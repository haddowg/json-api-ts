/**
 * How the normalised cache scales with what it holds. A music catalogue of about 50, 500 and 5,000
 * resources is cached the way an app caches one: an album list including each album's artist and
 * tracks, an infinite track list read with a sparse fieldset, the artists, album reads including
 * their tracks, each album's related and relationship reads, single tracks, and playlists whose
 * included tracks are per-edge views carrying a pivot. Against that cache it measures:
 *
 * - **read**: a successful read normalised (an album with its tracks and artist, a title changed),
 *   with `materialise` measured alone as the control;
 * - **update**: an optimistic attribute patch on a track cached in many places, rolled back;
 * - **attach**: an optimistic `attach` of a track to an album, which resolves the member into each
 *   hydrated slot it enters, rolled back;
 * - **delete**: an optimistic `evict` of a track from every list, page and slot holding it, rolled
 *   back;
 * - **r3**: a read whose to-many linkage changed, propagated to the album's other cached copies.
 *
 * Not part of the test suite: `npx vitest bench --project packages packages/query/bench`.
 */
import {
  type ApiDescriptor,
  createClient,
  materialise,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { type Query, QueryClient } from '@tanstack/query-core'
import { bench, describe } from 'vitest'
import { openDraft } from '../src/draft'
import { installNormalization } from '../src/install'
import { JsonApiMutationCache } from '../src/mutation-cache'
import { normalizeRead } from '../src/normalize'
import {
  getQueryOptions,
  infiniteListQueryOptions,
  listQueryOptions,
  relatedQueryOptions,
  relationshipQueryOptions,
} from '../src/read'

const BASE = 'https://bench.example'

const descriptor = {
  artists: {
    attributes: { name: 'string', country: 'string' },
    relations: {},
    paths: { fetchMany: '/artists', fetchOne: '/artists/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
  albums: {
    attributes: { title: 'string', year: 'integer' },
    relations: {
      artist: { cardinality: 'one', types: ['artists'], pivot: false, mutations: { set: true } },
      tracks: {
        cardinality: 'many',
        types: ['tracks'],
        pivot: false,
        mutations: { add: true, remove: true, replace: true },
      },
    },
    paths: {
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
      fetchRelationship: '/albums/{id}/relationships/{rel}',
      update: '/albums/{id}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['artist', 'tracks', 'tracks.album'],
  },
  tracks: {
    attributes: { title: 'string', duration: 'integer' },
    relations: {
      album: { cardinality: 'one', types: ['albums'], pivot: false },
    },
    paths: { fetchMany: '/tracks', fetchOne: '/tracks/{id}', update: '/tracks/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
  playlists: {
    attributes: { name: 'string' },
    relations: {
      tracks: {
        cardinality: 'many',
        types: ['tracks'],
        pivot: true,
        mutations: { add: true, remove: true },
      },
    },
    paths: { fetchMany: '/playlists', fetchOne: '/playlists/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    includable: ['tracks'],
  },
} as const satisfies ApiDescriptor

interface Catalogue {
  artists: { id: string; name: string; country: string }[]
  albums: { id: string; title: string; year: number; artist: string; tracks: string[] }[]
  tracks: Map<string, { title: string; duration: number; album: string }>
  playlists: { id: string; name: string; tracks: string[] }[]
}

/** About `size` resources: 5% artists, 15% albums, 80% tracks, and five playlists. */
function catalogue(size: number): Catalogue {
  const artists = Array.from({ length: Math.max(2, Math.round(size * 0.05)) }, (_, i) => ({
    id: `a${i}`,
    name: `Artist ${i}`,
    country: 'UK',
  }))
  const albumCount = Math.max(3, Math.round(size * 0.15))
  const albums = Array.from({ length: albumCount }, (_, i) => ({
    id: `b${i}`,
    title: `Album ${i}`,
    year: 1990 + (i % 30),
    artist: artists[i % artists.length]!.id,
    tracks: [] as string[],
  }))
  const tracks = new Map<string, { title: string; duration: number; album: string }>()
  const trackCount = Math.max(5, size - artists.length - albums.length - 5)
  for (let i = 0; i < trackCount; i++) {
    const album = albums[i % albums.length]!
    tracks.set(`t${i}`, { title: `Track ${i}`, duration: 200 + (i % 100), album: album.id })
    album.tracks.push(`t${i}`)
  }
  const ids = [...tracks.keys()]
  const playlists = Array.from({ length: 5 }, (_, p) => ({
    id: `p${p}`,
    name: `Playlist ${p}`,
    tracks: Array.from(
      { length: Math.min(40, ids.length) },
      (_unused, i) => ids[(p * 7 + i * 3) % ids.length]!,
    ),
  }))
  return { artists, albums, tracks, playlists }
}

const fields = (params: URLSearchParams, type: string) => params.get(`fields[${type}]`)?.split(',')
const pick = (values: Record<string, unknown>, fieldset: string[] | undefined) =>
  Object.fromEntries(
    Object.entries(values).filter(([k]) => fieldset === undefined || fieldset.includes(k)),
  )

/** A JSON:API server over a catalogue. */
function server(cat: Catalogue) {
  const albumsById = new Map(cat.albums.map((album) => [album.id, album]))
  const track = (id: string, params: URLSearchParams) => {
    const t = cat.tracks.get(id)!
    return {
      type: 'tracks',
      id,
      attributes: pick({ title: t.title, duration: t.duration }, fields(params, 'tracks')),
      relationships: { album: { data: { type: 'albums', id: t.album } } },
    }
  }
  const album = (id: string, params: URLSearchParams) => {
    const a = albumsById.get(id)!
    return {
      type: 'albums',
      id,
      attributes: pick({ title: a.title, year: a.year }, fields(params, 'albums')),
      relationships: {
        artist: { data: { type: 'artists', id: a.artist } },
        tracks: {
          data: a.tracks.map((t) => ({ type: 'tracks', id: t })),
          links: { related: `${BASE}/albums/${id}/tracks` },
        },
      },
    }
  }
  const artist = (id: string, params: URLSearchParams) => {
    const a = cat.artists.find((one) => one.id === id)!
    return {
      type: 'artists',
      id,
      attributes: pick({ name: a.name, country: a.country }, fields(params, 'artists')),
    }
  }
  const playlist = (id: string) => {
    const p = cat.playlists.find((one) => one.id === id)!
    return {
      type: 'playlists',
      id,
      attributes: { name: p.name },
      relationships: {
        tracks: {
          data: p.tracks.map((t, position) => ({
            type: 'tracks',
            id: t,
            meta: { pivot: { position } },
          })),
        },
      },
    }
  }
  const includedFor = (albums: string[], params: URLSearchParams) => {
    const include = params.get('include')?.split(',') ?? []
    const out = new Map<string, unknown>()
    for (const id of albums) {
      const a = albumsById.get(id)!
      if (include.includes('artist')) {
        out.set(`artists:${a.artist}`, artist(a.artist, params))
      }
      if (include.includes('tracks')) {
        for (const t of a.tracks) {
          out.set(`tracks:${t}`, track(t, params))
        }
      }
    }
    return [...out.values()]
  }
  const paged = (all: unknown[], url: URL) => {
    const number = Number(url.searchParams.get('page[number]') ?? '1')
    const size = Number(url.searchParams.get('page[size]') ?? `${all.length || 1}`)
    const first = (number - 1) * size
    const link = (n: number) =>
      `${BASE}${url.pathname}?page%5Bnumber%5D=${n}&page%5Bsize%5D=${size}${
        url.searchParams.has('fields[tracks]')
          ? `&fields%5Btracks%5D=${url.searchParams.get('fields[tracks]')}`
          : ''
      }`
    return {
      data: all.slice(first, first + size),
      links: {
        ...(number > 1 ? { prev: link(number - 1) } : {}),
        ...(first + size < all.length ? { next: link(number + 1) } : {}),
      },
    }
  }

  const route = (url: URL): unknown => {
    const parts = url.pathname.split('/').filter(Boolean)
    const params = url.searchParams
    const [kind, id, rel, sub] = parts
    if (kind === 'artists') {
      return id === undefined
        ? { data: cat.artists.map((a) => artist(a.id, params)) }
        : { data: artist(id, params) }
    }
    if (kind === 'tracks') {
      return id === undefined
        ? paged(
            [...cat.tracks.keys()].map((t) => track(t, params)),
            url,
          )
        : { data: track(id, params) }
    }
    if (kind === 'playlists') {
      const p = playlist(id!)
      const include = params.get('include')?.split(',') ?? []
      return {
        data: p,
        included: include.includes('tracks')
          ? [...new Set(cat.playlists.find((one) => one.id === id)!.tracks)].map((t) =>
              track(t, params),
            )
          : [],
      }
    }
    // albums
    if (id === undefined) {
      const ids = cat.albums.map((a) => a.id)
      return { data: ids.map((one) => album(one, params)), included: includedFor(ids, params) }
    }
    if (rel === 'relationships') {
      return { data: albumsById.get(id)!.tracks.map((t) => ({ type: 'tracks', id: t })) }
    }
    if (rel === 'tracks' && sub === undefined) {
      return { data: albumsById.get(id)!.tracks.map((t) => track(t, params)) }
    }
    return { data: album(id, params), included: includedFor([id], params) }
  }
  return { route, album, track, includedFor }
}

interface Fixture {
  queryClient: QueryClient
  cat: Catalogue
  route: (url: URL) => unknown
  /** How many resources the cache holds, counted by `type:id`. */
  resources: number
  queries: number
  /** The cached `albums/b0` read with no include, the query R3's read lands in. */
  plainAlbum: Query
  /** The cached `albums/b0?include=tracks,artist` read, the query the measured read lands in. */
  richAlbum: Query
}

async function fixture(size: number): Promise<Fixture> {
  const cat = catalogue(size)
  const { route } = server(cat)
  const transport = async (req: TransportRequest): Promise<TransportResponse> => ({
    status: 200,
    headers: {},
    body: JSON.stringify(route(new URL(req.url))),
  })
  const client = createClient(descriptor, { baseUrl: BASE, transport })
  const queryClient = new QueryClient({
    mutationCache: new JsonApiMutationCache(),
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } },
  })
  installNormalization(queryClient, descriptor)

  await queryClient.fetchQuery(listQueryOptions(client, 'artists'))
  await queryClient.fetchQuery(
    listQueryOptions(client, 'albums', { include: ['artist', 'tracks'] }),
  )
  const pageSize = 100
  await queryClient.fetchInfiniteQuery({
    ...infiniteListQueryOptions(client, 'tracks', {
      fields: { tracks: ['title'] },
      page: { size: pageSize },
    }),
    pages: Math.ceil(cat.tracks.size / pageSize),
  } as never)
  const sample = cat.albums.slice(0, Math.min(20, cat.albums.length))
  for (const album of sample) {
    await queryClient.fetchQuery(
      getQueryOptions(client, 'albums', album.id, { include: ['tracks', 'artist'] }),
    )
    await queryClient.fetchQuery(relatedQueryOptions(client, 'albums', album.id, 'tracks'))
  }
  for (const album of sample.slice(0, 10)) {
    await queryClient.fetchQuery(relationshipQueryOptions(client, 'albums', album.id, 'tracks'))
  }
  for (const playlist of cat.playlists) {
    await queryClient.fetchQuery(
      getQueryOptions(client, 'playlists', playlist.id, { include: ['tracks'] }),
    )
  }
  for (const id of [...cat.tracks.keys()].slice(0, 20)) {
    await queryClient.fetchQuery(getQueryOptions(client, 'tracks', id))
  }
  const plain = getQueryOptions(client, 'albums', 'b0')
  await queryClient.fetchQuery(plain)
  const rich = getQueryOptions(client, 'albums', 'b0', { include: ['tracks', 'artist'] })

  const cache = queryClient.getQueryCache()
  return {
    queryClient,
    cat,
    route,
    resources: 5 + cat.artists.length + cat.albums.length + cat.tracks.size,
    queries: cache.getAll().length,
    plainAlbum: cache.find({ queryKey: plain.queryKey, exact: true })!,
    richAlbum: cache.find({ queryKey: rich.queryKey, exact: true })!,
  }
}

const ctx = { descriptor, navigate: async () => undefined }

// `BENCH_SIZES=5000` measures one size.
const SIZES = (globalThis.process?.env?.['BENCH_SIZES'] ?? '50,500,5000').split(',').map(Number)
const fixtures = new Map<number, Fixture>()
for (const size of SIZES) {
  fixtures.set(size, await fixture(size))
}

const options = { time: 400, warmupTime: 100 }

for (const size of SIZES) {
  const f = fixtures.get(size)!
  const label = `${f.resources} resources, ${f.queries} queries`
  const b0 = f.cat.albums[0]!
  const url = new URL(`${BASE}/albums/b0?include=tracks,artist`)
  const plainUrl = new URL(`${BASE}/albums/b0`)
  // A track album b0 holds, cached in the album list, the infinite list, b0's reads and a playlist.
  const tracked = b0.tracks[0]!
  // A track of another album, fully cached (its own read), to attach to b0.
  const other = [...f.cat.tracks.keys()].find((id) => !b0.tracks.includes(id))!
  let flip = 0
  let grown = false

  describe(`read normalisation (${label})`, () => {
    bench(
      'materialise only (control)',
      () => {
        materialise(f.route(url) as never, ctx)
      },
      options,
    )
    bench(
      'materialise + normalise',
      () => {
        flip += 1
        b0.title = `Album 0 #${flip}`
        const result = materialise(f.route(url) as never, ctx)
        f.richAlbum.setState({ data: result })
        normalizeRead(f.queryClient, result, descriptor, undefined, f.richAlbum)
      },
      options,
    )
  })

  describe(`optimistic update (${label})`, () => {
    bench(
      'patch + rollback',
      () => {
        flip += 1
        const draft = openDraft(f.queryClient, descriptor)
        draft.patch('tracks', tracked, { title: `Patched #${flip}` } as never)
        draft.rollback()
      },
      options,
    )
  })

  describe(`optimistic attach (${label})`, () => {
    bench(
      'attach + rollback',
      () => {
        const draft = openDraft(f.queryClient, descriptor)
        draft.attach('albums', 'b0', 'tracks', [{ type: 'tracks', id: other }] as never)
        draft.rollback()
      },
      options,
    )
  })

  describe(`optimistic delete (${label})`, () => {
    bench(
      'evict + rollback',
      () => {
        const draft = openDraft(f.queryClient, descriptor)
        draft.evict('tracks', tracked)
        draft.rollback()
      },
      options,
    )
  })

  describe(`R3 propagation (${label})`, () => {
    bench(
      'a read with changed to-many linkage',
      () => {
        grown = !grown
        if (grown) {
          b0.tracks.push(other)
        } else {
          b0.tracks.pop()
        }
        const result = materialise(f.route(plainUrl) as never, ctx)
        f.plainAlbum.setState({ data: result })
        normalizeRead(f.queryClient, result, descriptor, undefined, f.plainAlbum)
      },
      options,
    )
  })
}
