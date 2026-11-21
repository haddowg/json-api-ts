import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { type InfiniteData, QueryClient, QueryObserver } from '@tanstack/query-core'
import { describe, expect, it } from 'vitest'
import { installNormalization } from './install'
import { createMutationApi } from './mutate'
import { JsonApiMutationCache } from './mutation-cache'
import { getQueryOptions, infiniteListQueryOptions, listQueryOptions } from './read'
import { withScope } from './scope'

const BASE = 'https://music.example'

const descriptor = {
  albums: {
    attributes: { title: 'string', year: 'integer' },
    relations: {
      artist: {
        cardinality: 'one',
        types: ['artists'],
        pivot: false,
        mutations: { set: true },
      },
      tracks: {
        cardinality: 'many',
        types: ['tracks'],
        pivot: true,
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
    includable: ['artist', 'tracks'],
  },
  tracks: {
    attributes: { title: 'string', duration: 'integer' },
    relations: {},
    paths: { fetchMany: '/tracks', fetchOne: '/tracks/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
  artists: {
    attributes: { name: 'string', country: 'string' },
    relations: {},
    paths: { fetchMany: '/artists', fetchOne: '/artists/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

type Row = Record<string, unknown> & {
  readonly $pivot?: Record<string, unknown>
  readonly $page?: { links: Record<string, string> }
  $rel(name: string): { data?: unknown } | undefined
}

interface Album {
  title: string
  year: number
  artist: string | null
  tracks: string[]
  /** Each member's pivot, sent as its linkage `meta.pivot`. */
  pivots?: Record<string, Record<string, unknown>>
  /** Render only this many tracks, with a `next` link when more follow. */
  window?: number
}

/** A request held open until the test releases it; it answers as the server stood when it was made. */
interface Held {
  release(): void
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The attributes of `values` a sparse fieldset selects. */
const pick = <T extends Record<string, unknown>>(values: T, fieldset: string[] | undefined) =>
  Object.fromEntries(
    Object.entries(values).filter(([key]) => fieldset === undefined || fieldset.includes(key)),
  )
const fieldsOf = (params: URLSearchParams, type: string) =>
  params.get(`fields[${type}]`)?.split(',')
/** The tracks an album's read renders. */
const shown = (a: Album) => (a.window === undefined ? a.tracks : a.tracks.slice(0, a.window))
const answerAsIs = (_url: URL): void => {}

/** A catalogue served over a mock transport, and a QueryClient built as an app builds one. */
function setup() {
  const albums: Record<string, Album> = {
    '1': { title: 'OK Computer', year: 1997, artist: 'a1', tracks: ['t1', 't2'] },
    '2': { title: 'Kid A', year: 2000, artist: 'a1', tracks: [] },
  }
  const tracks: Record<string, { title: string; duration: number }> = {
    t1: { title: 'Airbag', duration: 284 },
    t2: { title: 'Paranoid Android', duration: 383 },
    t3: { title: 'Lucky', duration: 259 },
    t4: { title: 'Karma Police', duration: 261 },
  }
  const artists: Record<string, { name: string; country: string }> = {
    a1: { name: 'Radiohead', country: 'UK' },
    a2: { name: 'Blur', country: 'UK' },
  }
  const requests: string[] = []
  const holds = new Map<string, Promise<void>[]>()
  const failing = new Set<string>()
  /** Run before each request is answered, to make the server answer differently per request. */
  let before: (url: URL) => void = answerAsIs

  const album = (id: string, params: URLSearchParams) => {
    const a = albums[id]!
    const fieldset = fieldsOf(params, 'albums')
    const relationships: Record<string, unknown> = {}
    if (fieldset === undefined || fieldset.includes('artist')) {
      relationships['artist'] = {
        data: a.artist === null ? null : { type: 'artists', id: a.artist },
      }
    }
    if (fieldset === undefined || fieldset.includes('tracks')) {
      const self = `${BASE}/albums/${id}/relationships/tracks`
      relationships['tracks'] = {
        data: shown(a).map((t) => ({
          type: 'tracks',
          id: t,
          ...(a.pivots?.[t] === undefined ? {} : { meta: { pivot: a.pivots[t] } }),
        })),
        links: {
          self,
          related: `${BASE}/albums/${id}/tracks`,
          ...(shown(a).length < a.tracks.length ? { next: `${self}?page[number]=2` } : {}),
        },
      }
    }
    return {
      type: 'albums',
      id,
      attributes: pick({ title: a.title, year: a.year }, fieldset),
      relationships,
    }
  }
  const track = (id: string, params: URLSearchParams) => ({
    type: 'tracks',
    id,
    attributes: pick(tracks[id]!, fieldsOf(params, 'tracks')),
  })
  const artist = (id: string, params: URLSearchParams) => ({
    type: 'artists',
    id,
    attributes: pick(artists[id]!, fieldsOf(params, 'artists')),
  })
  const included = (ids: string[], params: URLSearchParams) => {
    const include = params.get('include')?.split(',') ?? []
    const out = new Map<string, unknown>()
    for (const id of ids) {
      const a = albums[id]!
      if (include.includes('artist') && a.artist !== null) {
        out.set(`artists:${a.artist}`, artist(a.artist, params))
      }
      if (include.includes('tracks')) {
        for (const t of shown(a)) {
          out.set(`tracks:${t}`, track(t, params))
        }
      }
    }
    return [...out.values()]
  }

  const route = (req: TransportRequest, url: URL): unknown => {
    const [kind, id] = url.pathname.split('/').filter(Boolean)
    const params = url.searchParams
    if (req.method !== 'GET') {
      return { status: 204 }
    }
    if (kind === 'albums') {
      const ids = id === undefined ? Object.keys(albums) : [id]
      const data = ids.map((one) => album(one, params))
      return { data: id === undefined ? data : data[0], included: included(ids, params) }
    }
    if (kind === 'tracks') {
      return id === undefined
        ? { data: Object.keys(tracks).map((t) => track(t, params)) }
        : { data: track(id, params) }
    }
    return { data: artist(id!, params) }
  }

  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    const url = new URL(req.url)
    const key = `${req.method} ${url.pathname}`
    requests.push(`${key}${decodeURIComponent(url.search)}`)
    before(url)
    let answer: TransportResponse
    if (failing.has(key)) {
      answer = { status: 422, headers: {}, body: JSON.stringify({ errors: [{ status: '422' }] }) }
    } else {
      const doc = route(req, url)
      answer =
        req.method === 'GET'
          ? { status: 200, headers: {}, body: JSON.stringify(doc) }
          : { status: 204, headers: {}, body: '' }
    }
    const gate = holds.get(key)?.shift()
    if (gate !== undefined) {
      await gate
    }
    return answer
  }

  const client = createClient(descriptor, { baseUrl: BASE, transport })
  const queryClient = new QueryClient({
    mutationCache: new JsonApiMutationCache(),
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  })
  installNormalization(queryClient, descriptor)

  return {
    client,
    queryClient,
    albums,
    tracks,
    artists,
    requests,
    /** How many requests were made to `GET /path` (any query string), or matching `search`. */
    count(path: string, search?: string): number {
      return requests.filter(
        (request) =>
          request.split('?')[0] === `GET ${path}` &&
          (search === undefined || request.includes(search)),
      ).length
    },
    /** Hold the next request to `METHOD /path` open until released. */
    hold(key: string): Held {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      holds.set(key, [...(holds.get(key) ?? []), gate])
      return { release }
    },
    fail(key: string): void {
      failing.add(key)
    },
    before(fn: (url: URL) => void): void {
      before = fn
    },
    /** Keep a query observed (active), as a mounted component does. */
    observe(options: object): () => void {
      return new QueryObserver(queryClient, options as never).subscribe(() => {})
    },
    data(options: { queryKey: readonly unknown[] }): Row {
      return queryClient.getQueryData(options.queryKey as never) as Row
    },
    list(options: { queryKey: readonly unknown[] }): Row[] {
      return queryClient.getQueryData(options.queryKey as never) as Row[]
    },
    invalidated(options: { queryKey: readonly unknown[] }): boolean {
      return queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true })!.state
        .isInvalidated
    },
    /** Refetch a read now, as a refocus or a newly mounted component would. */
    refetch(options: { queryKey: readonly unknown[] }): Promise<unknown> {
      return queryClient.fetchQuery({ ...options, staleTime: 0 } as never)
    },
  }
}

const ids = (value: unknown): string[] => (value as Row[]).map((member) => member['id'] as string)

describe('reads propagate to-one linkage (A7 R3)', () => {
  it('moves an identifier slot to the new target in place', async () => {
    const h = setup()
    const get = getQueryOptions(h.client, 'albums', '1')
    await h.queryClient.fetchQuery(get)
    const before = h.data(get)

    h.albums['1']!.artist = 'a2'
    await h.queryClient.fetchQuery(listQueryOptions(h.client, 'albums'))

    const after = h.data(get)
    expect(after).not.toBe(before)
    expect(after['artist']).toEqual({ type: 'artists', id: 'a2' })
    expect(h.invalidated(get)).toBe(false)
  })

  it('fills an included slot with a cached copy that fits it', async () => {
    const h = setup()
    const get = getQueryOptions(h.client, 'albums', '1', { include: ['artist'] })
    await h.queryClient.fetchQuery(get)
    await h.queryClient.fetchQuery(getQueryOptions(h.client, 'artists', 'a2'))

    h.albums['1']!.artist = 'a2'
    await h.queryClient.fetchQuery(listQueryOptions(h.client, 'albums'))

    expect(h.data(get)['artist']).toMatchObject({ type: 'artists', id: 'a2', name: 'Blur' })
    expect(h.invalidated(get)).toBe(false)
  })

  it('prefers the copy the read itself carries', async () => {
    const h = setup()
    const get = getQueryOptions(h.client, 'albums', '1', { include: ['artist'] })
    await h.queryClient.fetchQuery(get)

    h.albums['1']!.artist = 'a2'
    await h.queryClient.fetchQuery(listQueryOptions(h.client, 'albums', { include: ['artist'] }))

    expect(h.data(get)['artist']).toMatchObject({ id: 'a2', name: 'Blur', country: 'UK' })
    expect(h.invalidated(get)).toBe(false)
  })

  it('invalidates an included slot no copy fits, which then refetches', async () => {
    const h = setup()
    const get = getQueryOptions(h.client, 'albums', '1', { include: ['artist'] })
    const stop = h.observe(get)
    await h.queryClient.fetchQuery(get)
    // A sparse copy of a2 is cached, but the album's slot promises every artist attribute.
    await h.queryClient.fetchQuery(
      getQueryOptions(h.client, 'artists', 'a2', { fields: { artists: ['name'] } }),
    )

    h.albums['1']!.artist = 'a2'
    await h.queryClient.fetchQuery(listQueryOptions(h.client, 'albums'))
    // The slot keeps its member until the refetch replaces it.
    expect(h.data(get)['artist']).toMatchObject({ id: 'a1' })
    await tick()

    expect(h.count('/albums/1')).toBe(2)
    expect(h.data(get)['artist']).toMatchObject({ id: 'a2', name: 'Blur', country: 'UK' })
    stop()
  })

  it('applies null to identifier and included slots alike', async () => {
    const h = setup()
    const plain = getQueryOptions(h.client, 'albums', '1')
    const withArtist = getQueryOptions(h.client, 'albums', '1', { include: ['artist'] })
    await h.queryClient.fetchQuery(plain)
    await h.queryClient.fetchQuery(withArtist)

    h.albums['1']!.artist = null
    await h.queryClient.fetchQuery(listQueryOptions(h.client, 'albums'))

    expect(h.data(plain)['artist']).toBeNull()
    expect(h.data(withArtist)['artist']).toBeNull()
    expect(h.invalidated(withArtist)).toBe(false)
  })
})

describe('reads propagate complete to-many linkage (A7 R3)', () => {
  it('replaces an identifier slot’s members, keeping its envelope', async () => {
    const h = setup()
    const get = getQueryOptions(h.client, 'albums', '1')
    await h.queryClient.fetchQuery(get)
    const page = (h.data(get)['tracks'] as Row).$page

    h.albums['1']!.tracks = ['t2', 't3']
    await h.queryClient.fetchQuery(listQueryOptions(h.client, 'albums'))

    const slot = h.data(get)['tracks'] as Row
    expect(ids(slot)).toEqual(['t2', 't3'])
    expect(slot.$page).toBe(page)
    expect(h.invalidated(get)).toBe(false)
  })

  it('replaces an included slot’s members when every member fits, keeping the members it held', async () => {
    const h = setup()
    const get = getQueryOptions(h.client, 'albums', '1', { include: ['tracks'] })
    await h.queryClient.fetchQuery(get)
    await h.queryClient.fetchQuery(getQueryOptions(h.client, 'tracks', 't3'))
    const t1 = (h.data(get)['tracks'] as Row[])[0]

    h.albums['1']!.tracks = ['t1', 't2', 't3']
    await h.queryClient.fetchQuery(listQueryOptions(h.client, 'albums'))

    const slot = h.data(get)['tracks'] as Row[]
    expect(ids(slot)).toEqual(['t1', 't2', 't3'])
    expect(slot[0]).toBe(t1)
    expect(slot[2]).toMatchObject({ title: 'Lucky', duration: 259 })
    expect(h.invalidated(get)).toBe(false)
  })

  it('invalidates an included slot when only some members fit, and leaves its members until then', async () => {
    const h = setup()
    const get = getQueryOptions(h.client, 'albums', '1', { include: ['tracks'] })
    await h.queryClient.fetchQuery(get)

    h.albums['1']!.tracks = ['t1', 't2', 't3']
    await h.queryClient.fetchQuery(listQueryOptions(h.client, 'albums'))

    expect(ids(h.data(get)['tracks'])).toEqual(['t1', 't2'])
    expect(h.invalidated(get)).toBe(true)
  })

  it('never treats windowed linkage as the whole list', async () => {
    const h = setup()
    const get = getQueryOptions(h.client, 'albums', '1')
    await h.queryClient.fetchQuery(get)

    h.albums['1']!.tracks = ['t3', 't4', 't1']
    h.albums['1']!.window = 2
    await h.queryClient.fetchQuery(listQueryOptions(h.client, 'albums'))

    expect(ids(h.data(get)['tracks'])).toEqual(['t1', 't2'])
    expect(h.invalidated(get)).toBe(false)
  })

  it('completes a windowed slot from complete linkage, taking the read’s envelope', async () => {
    const h = setup()
    h.albums['1']!.window = 1
    const get = getQueryOptions(h.client, 'albums', '1')
    await h.queryClient.fetchQuery(get)
    expect((h.data(get)['tracks'] as Row).$page?.links['next']).toBeDefined()

    delete h.albums['1']!.window
    await h.queryClient.fetchQuery(listQueryOptions(h.client, 'albums'))

    const slot = h.data(get)['tracks'] as Row
    expect(ids(slot)).toEqual(['t1', 't2'])
    expect(slot.$page?.links['next']).toBeUndefined()
  })

  it('leaves links-only slots alone', async () => {
    const h = setup()
    // The album's own read renders its relationships as links only.
    const get = getQueryOptions(h.client, 'albums', '1')
    h.before((url) => {
      if (url.pathname === '/albums/1') {
        h.albums['1']!.tracks = []
      }
    })
    await h.queryClient.fetchQuery(get)
    // Rewrite the cached copy's relationships as links-only.
    const node = h.data(get)
    const raw = (node as unknown as { $raw: { relationships: Record<string, unknown> } }).$raw
    raw.relationships['tracks'] = { links: { related: `${BASE}/albums/1/tracks` } }
    raw.relationships['artist'] = { links: { related: `${BASE}/albums/1/artist` } }
    delete (node as Record<string, unknown>)['artist']

    h.before(answerAsIs)
    h.albums['1']!.tracks = ['t3']
    h.albums['1']!.artist = 'a2'
    await h.queryClient.fetchQuery(listQueryOptions(h.client, 'albums'))

    expect(h.data(get)['tracks']).toEqual([])
    expect(h.data(get)['artist']).toBeUndefined()
    expect(h.invalidated(get)).toBe(false)
  })

  it('gives each member the pivot its linkage carries, and keeps a member whose pivot is unchanged', async () => {
    const h = setup()
    h.albums['1']!.pivots = { t1: { position: 1 }, t2: { position: 2 } }
    const get = getQueryOptions(h.client, 'albums', '1', { include: ['tracks'] })
    await h.queryClient.fetchQuery(get)
    await h.queryClient.fetchQuery(getQueryOptions(h.client, 'tracks', 't3'))
    const t1 = (h.data(get)['tracks'] as Row[])[0]

    h.albums['1']!.tracks = ['t1', 't3', 't2']
    h.albums['1']!.pivots = { t1: { position: 1 }, t2: { position: 3 }, t3: { position: 2 } }
    await h.queryClient.fetchQuery(listQueryOptions(h.client, 'albums'))

    const slot = h.data(get)['tracks'] as Row[]
    expect(ids(slot)).toEqual(['t1', 't3', 't2'])
    expect(slot[0]).toBe(t1)
    expect(slot.map((member) => member.$pivot)).toEqual([
      { position: 1 },
      { position: 2 },
      { position: 3 },
    ])
    expect(slot[2]).toMatchObject({ title: 'Paranoid Android' })
  })

  it('reaches a copy of the parent inside an infinite page', async () => {
    const h = setup()
    const infinite = infiniteListQueryOptions(h.client, 'albums')
    await h.queryClient.fetchInfiniteQuery(infinite)
    const before = h.queryClient.getQueryData(infinite.queryKey) as InfiniteData<Row[]>

    h.albums['1']!.tracks = ['t4']
    h.albums['1']!.artist = 'a2'
    await h.queryClient.fetchQuery(getQueryOptions(h.client, 'albums', '1'))

    const after = h.queryClient.getQueryData(infinite.queryKey) as InfiniteData<Row[]>
    expect(after).not.toBe(before)
    expect(after.pages[0]).not.toBe(before.pages[0])
    expect(ids(after.pages[0]![0]!['tracks'])).toEqual(['t4'])
    expect(after.pages[0]![0]!['artist']).toEqual({ type: 'artists', id: 'a2' })
  })
})

describe('relationship freshness (A7 R1 for R3)', () => {
  it('an older read arriving last overwrites no newer slot, and takes the newer linkage itself', async () => {
    const h = setup()
    const list = listQueryOptions(h.client, 'albums')
    const get = getQueryOptions(h.client, 'albums', '1')

    // The list is requested first, while the album still has two tracks, and answers last.
    const held = h.hold('GET /albums')
    const older = h.queryClient.fetchQuery(list)
    await tick()
    h.albums['1']!.tracks = ['t2']
    await h.queryClient.fetchQuery(get)
    held.release()
    await older

    expect(ids(h.data(get)['tracks'])).toEqual(['t2'])
    expect(ids(h.list(list)[0]!['tracks'])).toEqual(['t2'])
  })

  it('an older read’s complete linkage leaves a newer windowed slot alone', async () => {
    const h = setup()
    const list = listQueryOptions(h.client, 'albums')
    const get = getQueryOptions(h.client, 'albums', '1')

    const held = h.hold('GET /albums')
    const older = h.queryClient.fetchQuery(list)
    await tick()
    // Newer: the album now has three tracks, of which its read renders the first page.
    h.albums['1']!.tracks = ['t3', 't4', 't1']
    h.albums['1']!.window = 1
    await h.queryClient.fetchQuery(get)
    held.release()
    await older

    const slot = h.data(get)['tracks'] as Row
    expect(ids(slot)).toEqual(['t3'])
    expect(slot.$page?.links['next']).toBeDefined()
  })

  it('a newer read arriving last wins', async () => {
    const h = setup()
    const list = listQueryOptions(h.client, 'albums')
    const get = getQueryOptions(h.client, 'albums', '1')
    await h.queryClient.fetchQuery(get)

    h.albums['1']!.tracks = ['t3']
    await h.queryClient.fetchQuery(list)
    expect(ids(h.data(get)['tracks'])).toEqual(['t3'])
  })
})

describe('reads and pending optimistic relationship writes (A7 R2 for R3)', () => {
  it('a slot a pending draft edited keeps its prediction, and a rollback shows the newest server membership', async () => {
    const h = setup()
    const get = getQueryOptions(h.client, 'albums', '1')
    const list = listQueryOptions(h.client, 'albums')
    await h.queryClient.fetchQuery(get)
    await h.queryClient.fetchQuery(list)

    h.fail('POST /albums/1/relationships/tracks')
    const write = h.hold('POST /albums/1/relationships/tracks')
    const pending = h.queryClient
      .getMutationCache()
      .build(
        h.queryClient,
        createMutationApi(h.queryClient, h.client, descriptor)
          .albums.id('1')
          .rel('tracks')
          .add({ optimistic: true }) as never,
      )
      .execute([{ type: 'tracks', id: 't3' }] as never)
    await tick()
    expect(ids(h.data(get)['tracks'])).toEqual(['t1', 't2', 't3'])

    // Someone else changes the album's tracks; the list's read lands while the write is pending.
    h.albums['1']!.tracks = ['t2', 't4']
    await h.refetch(list)
    expect(ids(h.data(get)['tracks'])).toEqual(['t1', 't2', 't3'])
    expect(ids(h.list(list)[0]!['tracks'])).toEqual(['t2', 't4', 't3'])

    write.release()
    await expect(pending).rejects.toBeDefined()
    expect(ids(h.data(get)['tracks'])).toEqual(['t2', 't4'])
    expect(ids(h.list(list)[0]!['tracks'])).toEqual(['t2', 't4'])
  })
})

describe('R3 never loops', () => {
  it('two views whose server answers keep disagreeing settle after one refetch', async () => {
    const h = setup()
    // Each view's read gets its own answer, and neither's members fit the other's fieldset.
    h.before((url) => {
      const fieldset = url.searchParams.get('fields[tracks]')
      if (fieldset === 'title') {
        h.albums['1']!.tracks = ['t1', 't2']
      } else if (fieldset === 'duration') {
        h.albums['1']!.tracks = ['t1', 't3']
      }
    })
    const a = getQueryOptions(h.client, 'albums', '1', {
      include: ['tracks'],
      fields: { tracks: ['title'] },
    })
    const b = getQueryOptions(h.client, 'albums', '1', {
      include: ['tracks'],
      fields: { tracks: ['duration'] },
    })
    const stopA = h.observe(a)
    const stopB = h.observe(b)
    await tick(10)

    // B's newer read invalidated A once; A's refetch, newer still, invalidated nothing.
    expect(h.count('/albums/1', 'title')).toBe(2)
    expect(h.count('/albums/1', 'duration')).toBe(1)
    await tick(20)
    expect(h.count('/albums/1')).toBe(3)
    expect(ids(h.data(a)['tracks'])).toEqual(['t1', 't2'])
    expect(h.invalidated(a)).toBe(false)
    stopA()
    stopB()
  })

  it('a refetched view is never overwritten by the older view that invalidated it', async () => {
    const h = setup()
    const sparse = getQueryOptions(h.client, 'albums', '1', { include: ['tracks'] })
    const plain = getQueryOptions(h.client, 'albums', '1')
    const stop = h.observe(sparse)
    await tick()
    await h.queryClient.fetchQuery(plain)

    // The plain read brings t4, which the included slot can't fill: it refetches, once.
    h.albums['1']!.tracks = ['t4']
    await h.refetch(plain)
    await tick(10)
    expect(h.count('/albums/1', 'include')).toBe(2)
    expect(ids(h.data(sparse)['tracks'])).toEqual(['t4'])

    // Normalising the older plain read again changes nothing and invalidates nothing.
    await tick(20)
    expect(h.count('/albums/1', 'include')).toBe(2)
    expect(h.invalidated(sparse)).toBe(false)
    stop()
  })
})

describe('R3 scopes', () => {
  it('a read in one scope leaves another scope’s copies alone', async () => {
    const h = setup()
    installNormalization(h.queryClient, descriptor, { scope: 'admin' })
    const admin = withScope('admin', getQueryOptions(h.client, 'albums', '1'))
    await h.queryClient.fetchQuery(admin)

    h.albums['1']!.tracks = ['t3']
    h.albums['1']!.artist = 'a2'
    await h.queryClient.fetchQuery(listQueryOptions(h.client, 'albums'))

    expect(ids(h.data(admin)['tracks'])).toEqual(['t1', 't2'])
    expect(h.data(admin)['artist']).toEqual({ type: 'artists', id: 'a1' })
  })
})
