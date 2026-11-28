import {
  type ApiDescriptor,
  type Client,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import {
  type InfiniteData,
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from '@tanstack/query-core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { type DraftQuery, openDraft } from './draft'
import { installNormalization } from './install'
import { JsonApiMutationCache } from './mutation-cache'
import { normalize } from './normalize'
import {
  getQueryOptions,
  infiniteListQueryOptions,
  infiniteRelatedQueryOptions,
  listQueryOptions,
  relatedQueryOptions,
  relationshipQueryOptions,
} from './read'
import { withScope } from './scope'
import { updateMutationOptions } from './mutate'

const BASE = 'https://music.example'
const COUNTABLE = 'https://music.example/profiles/countable/'

const descriptor = {
  albums: {
    attributes: { title: 'string', year: 'integer' },
    relations: {
      artist: { cardinality: 'one', types: ['artists'] },
      tracks: { cardinality: 'many', types: ['tracks'] },
    },
    paths: {
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
      fetchRelationship: '/albums/{id}/relationships/{rel}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['artist', 'tracks', 'tracks.artist'],
    resourceCountable: { fetchOne: { tokens: ['tracks'], profile: COUNTABLE } },
  },
  tracks: {
    attributes: { title: 'string', duration: 'integer' },
    relations: { artist: { cardinality: 'one', types: ['artists'] } },
    paths: { fetchMany: '/tracks', fetchOne: '/tracks/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['artist'],
  },
  artists: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchMany: '/artists', fetchOne: '/artists/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

type Row = Record<string, unknown> & {
  readonly $optimistic?: 'pending'
  readonly $pivot?: Record<string, unknown>
  $pending(rel: string): readonly { type: string; id: string }[]
  $count(rel: string): number | undefined
}
type Rows = Row[] & { readonly $count?: number; readonly $page?: unknown }

/** The attributes `fields[type]` selects (all of them when it selects nothing). */
function pick(type: string, attributes: Record<string, unknown>, params: URLSearchParams) {
  const fields = params.get(`fields[${type}]`)?.split(',')
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => fields === undefined || fields.includes(key)),
  )
}

/** Whether `fields[type]` selects relation `rel`. */
function selected(type: string, rel: string, params: URLSearchParams) {
  const fields = params.get(`fields[${type}]`)?.split(',')
  return fields === undefined || fields.includes(rel)
}

/**
 * A small music catalogue served over a mock transport: albums with an artist and tracks, tracks
 * with an artist. It honours `include`, `fields`, `withCount` and a related read's `page[size]`
 * (a page smaller than the relation answers with a `next` link). Album 2's relations are links-only.
 */
function catalogue() {
  const artists: Record<string, { name: string }> = {
    a1: { name: 'Radiohead' },
    a2: { name: 'Blur' },
  }
  const tracks: Record<string, { title: string; duration: number; artist: string }> = {
    t1: { title: 'Airbag', duration: 284, artist: 'a1' },
    t2: { title: 'Paranoid Android', duration: 383, artist: 'a1' },
    t3: { title: 'Song 2', duration: 122, artist: 'a2' },
    t4: { title: 'Lucky', duration: 259, artist: 'a1' },
  }
  const albums: Record<string, { title: string; year: number; artist: string; tracks: string[] }> =
    {
      '1': { title: 'OK Computer', year: 1997, artist: 'a1', tracks: ['t1', 't2'] },
      '2': { title: 'Blur', year: 1997, artist: 'a2', tracks: ['t3'] },
    }
  const requests: string[] = []

  const track = (id: string, params: URLSearchParams) => {
    const { artist, ...attributes } = tracks[id]!
    return {
      type: 'tracks',
      id,
      attributes: pick('tracks', attributes, params),
      ...(selected('tracks', 'artist', params)
        ? { relationships: { artist: { data: { type: 'artists', id: artist } } } }
        : {}),
    }
  }
  const artist = (id: string, params: URLSearchParams) => ({
    type: 'artists',
    id,
    attributes: pick('artists', artists[id]!, params),
  })
  const album = (id: string, params: URLSearchParams) => {
    const { artist: by, tracks: members, ...attributes } = albums[id]!
    const counted = params.get('withCount')?.split(',').includes('tracks') === true
    const relationships: Record<string, unknown> =
      id === '2'
        ? {
            artist: { links: { related: `${BASE}/albums/2/artist` } },
            tracks: {
              links: { related: `${BASE}/albums/2/tracks` },
              ...(counted ? { meta: { total: members.length } } : {}),
            },
          }
        : {
            artist: { data: { type: 'artists', id: by } },
            tracks: {
              data: members.map((t) => ({ type: 'tracks', id: t })),
              ...(counted ? { meta: { total: members.length } } : {}),
            },
          }
    for (const rel of ['artist', 'tracks']) {
      if (!selected('albums', rel, params)) {
        delete relationships[rel]
      }
    }
    return { type: 'albums', id, attributes: pick('albums', attributes, params), relationships }
  }
  const included = (id: string, params: URLSearchParams) => {
    const include = params.get('include')?.split(',') ?? []
    const out: unknown[] = []
    const { artist: by, tracks: members } = albums[id]!
    if (id !== '2' && include.includes('artist')) {
      out.push(artist(by, params))
    }
    if (id !== '2' && include.includes('tracks')) {
      out.push(...members.map((t) => track(t, params)))
    }
    if (id !== '2' && include.includes('tracks.artist')) {
      const ids = new Set(members.map((t) => tracks[t]!.artist))
      out.push(
        ...[...ids]
          .filter((a) => !include.includes('artist') || a !== by)
          .map((a) => artist(a, params)),
      )
    }
    return out
  }

  const route = (url: URL): unknown => {
    const params = url.searchParams
    const path = url.pathname.split('/').filter(Boolean)
    if (path[0] === 'albums' && path.length === 1) {
      return { data: Object.keys(albums).map((id) => album(id, params)) }
    }
    if (path[0] === 'albums' && path.length === 2) {
      return { data: album(path[1]!, params), included: included(path[1]!, params) }
    }
    if (path[0] === 'albums' && path[2] === 'relationships') {
      const { artist: by, tracks: members } = albums[path[1]!]!
      return path[3] === 'artist'
        ? { data: { type: 'artists', id: by } }
        : { data: members.map((t) => ({ type: 'tracks', id: t })) }
    }
    if (path[0] === 'albums' && path.length === 3) {
      const { artist: by, tracks: members } = albums[path[1]!]!
      if (path[2] === 'artist') {
        return { data: artist(by, params) }
      }
      const size = Number(params.get('page[size]') ?? members.length)
      const number = Number(params.get('page[number]') ?? '1')
      const page = members.slice((number - 1) * size, number * size)
      const next =
        number * size < members.length
          ? {
              next: `${BASE}/albums/${path[1]}/tracks?page%5Bnumber%5D=${number + 1}&page%5Bsize%5D=${size}`,
            }
          : {}
      const prev =
        number > 1
          ? {
              prev: `${BASE}/albums/${path[1]}/tracks?page%5Bnumber%5D=${number - 1}&page%5Bsize%5D=${size}`,
            }
          : {}
      return { data: page.map((t) => track(t, params)), links: { ...next, ...prev } }
    }
    if (path[0] === 'tracks' && path.length === 1) {
      const include = params.get('include')?.split(',') ?? []
      const ids = Object.keys(tracks)
      return {
        data: ids.map((t) => track(t, params)),
        included: include.includes('artist')
          ? Object.keys(artists).map((a) => artist(a, params))
          : [],
      }
    }
    if (path[0] === 'tracks') {
      return { data: track(path[1]!, params) }
    }
    if (path[0] === 'artists' && path.length === 1) {
      return { data: Object.keys(artists).map((a) => artist(a, params)) }
    }
    return { data: artist(path[1]!, params) }
  }

  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    const url = new URL(req.url)
    requests.push(`${req.method} ${decodeURIComponent(url.pathname + url.search)}`)
    return { status: 200, headers: {}, body: JSON.stringify(route(url)) }
  }
  const client = createClient(descriptor, { baseUrl: BASE, transport })
  const queryClient = new QueryClient({
    mutationCache: new JsonApiMutationCache(),
    defaultOptions: { queries: { staleTime: Infinity } },
  })
  installNormalization(queryClient, descriptor)
  return { client, queryClient, albums, tracks, artists, requests }
}

/** The data a read's key holds now. */
const dataOf = (queryClient: QueryClient, options: { queryKey: readonly unknown[] }) =>
  queryClient.getQueryData(options.queryKey as never) as unknown

const ids = (value: unknown): string[] => (value as Row[]).map((member) => member['id'] as string)
const pagesOf = (value: unknown): string[][] =>
  (value as InfiniteData<Row[]>).pages.map((page) => ids(page))

const ref = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'tracks', id, ...extra })

// ── Destinations ───────────────────────────────────────────────────────────────────────────

describe('attach reaches every destination in the shape it promises', () => {
  it('a relationship read takes an identifier, with the ref’s pivot', async () => {
    const { client, queryClient } = catalogue()
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(linkage)

    const draft = openDraft(queryClient, descriptor)
    draft.attach('albums', '1', 'tracks', [ref('t3', { $pivot: { position: 3 } })])

    const members = dataOf(queryClient, linkage) as Rows
    expect(ids(members)).toEqual(['t1', 't2', 't3'])
    expect({ ...members[2] }).toEqual({
      type: 'tracks',
      id: 't3',
      meta: { pivot: { position: 3 } },
    })
    expect(members[2]!.$pivot).toEqual({ position: 3 })
    expect(members[2]!.$optimistic).toBe('pending')
    expect(members[0]!.$optimistic).toBeUndefined()

    draft.rollback()
    expect(ids(dataOf(queryClient, linkage))).toEqual(['t1', 't2'])
  })

  it('a slot not included takes an identifier', async () => {
    const { client, queryClient } = catalogue()
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(get)

    openDraft(queryClient, descriptor).attach('albums', '1', 'tracks', [ref('t3')])

    const album = dataOf(queryClient, get) as Row & { tracks: Rows }
    expect(ids(album.tracks)).toEqual(['t1', 't2', 't3'])
    expect({ ...album.tracks[2] }).toEqual({ type: 'tracks', id: 't3' })
    expect(album.$optimistic).toBe('pending')
  })

  it('an included slot takes the richest cached copy as a per-edge view with its own pivot', async () => {
    const { client, queryClient } = catalogue()
    const get = getQueryOptions(client, 'albums', '1', { include: ['tracks'] })
    await queryClient.fetchQuery(get)
    // Song 2 is cached in a list that also carries it on another edge.
    await queryClient.fetchQuery(listQueryOptions(client, 'tracks'))

    const draft = openDraft(queryClient, descriptor)
    draft.attach('albums', '1', 'tracks', [ref('t3', { $pivot: { position: 9 } })])

    const album = dataOf(queryClient, get) as Row & { tracks: Rows }
    const added = album.tracks[2]!
    expect(ids(album.tracks)).toEqual(['t1', 't2', 't3'])
    expect(added['title']).toBe('Song 2')
    expect(added['duration']).toBe(122)
    expect(added.$pivot).toEqual({ position: 9 })
    expect(added.$optimistic).toBe('pending')
    expect(added['$raw']).toBeDefined()
    expect(album.$pending('tracks')).toEqual([])
    expect(draft.deferred()).toEqual([])
  })

  it('an included slot defers a member no copy fits, reported by $pending()', async () => {
    const { client, queryClient } = catalogue()
    const get = getQueryOptions(client, 'albums', '1', { include: ['tracks'] })
    await queryClient.fetchQuery(get)
    // Only a sparse copy of Song 2 is cached: it lacks `duration`, so it can't fill the slot.
    await queryClient.fetchQuery(
      listQueryOptions(client, 'tracks', { fields: { tracks: ['title'] } } as never),
    )

    const draft = openDraft(queryClient, descriptor)
    draft.attach('albums', '1', 'tracks', [ref('t3')])

    const album = dataOf(queryClient, get) as Row & { tracks: Rows }
    expect(ids(album.tracks)).toEqual(['t1', 't2'])
    expect(album.$pending('tracks')).toEqual([{ type: 'tracks', id: 't3' }])
    expect(album.$optimistic).toBe('pending')
    expect(draft.deferred()).toEqual([
      { type: 'albums', id: '1', rel: 'tracks', members: [{ type: 'tracks', id: 't3' }] },
    ])

    // The caller's own copy fits, so it goes in.
    const second = openDraft(queryClient, descriptor)
    second.attach('albums', '1', 'tracks', [ref('t4', { title: 'Lucky', duration: 259 })])
    expect(ids((dataOf(queryClient, get) as { tracks: Rows }).tracks)).toEqual(['t1', 't2', 't4'])

    draft.rollback()
    second.rollback()
    expect(album.$pending('tracks')).toEqual([])
    expect(album.$optimistic).toBeUndefined()
    expect(draft.deferred()).toEqual([])
  })

  it('a related read takes a fitting member, plain or infinite (on its last page)', async () => {
    const { client, queryClient } = catalogue()
    const related = relatedQueryOptions(client, 'albums', '1', 'tracks')
    const infinite = infiniteRelatedQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(related)
    await queryClient.fetchInfiniteQuery(infinite)
    await queryClient.fetchQuery(getQueryOptions(client, 'tracks', 't3'))

    openDraft(queryClient, descriptor).attach('albums', '1', 'tracks', [ref('t3')])

    expect(ids(dataOf(queryClient, related))).toEqual(['t1', 't2', 't3'])
    expect(pagesOf(dataOf(queryClient, infinite))).toEqual([['t1', 't2', 't3']])
    expect((dataOf(queryClient, related) as Rows)[2]!['title']).toBe('Song 2')
  })

  it('leaves a links-only slot alone', async () => {
    const { client, queryClient } = catalogue()
    const get = getQueryOptions(client, 'albums', '2', { withCount: ['tracks'] } as never)
    await queryClient.fetchQuery(get)
    const before = dataOf(queryClient, get) as Row & { tracks: Rows; artist: unknown }
    const tracksBefore = before.tracks
    expect(before.artist).toBeUndefined()

    const draft = openDraft(queryClient, descriptor)
    draft.attach('albums', '2', 'tracks', [ref('t1')])
    draft.link('albums', '2', 'artist', { type: 'artists', id: 'a1' })
    draft.detach('albums', '2', 'tracks', [ref('t3')])

    const after = dataOf(queryClient, get) as Row & { tracks: Rows; artist: unknown }
    expect(after.tracks).toBe(tracksBefore)
    expect(after.tracks).toBeUndefined()
    expect(after.$count('tracks')).toBe(1)
    expect(after.artist).toBeUndefined()
    expect(draft.deferred()).toEqual([])
  })
})

// ── Placement ──────────────────────────────────────────────────────────────────────────────

describe('placement', () => {
  async function reads() {
    const setup = catalogue()
    const { client, queryClient } = setup
    const plain = relatedQueryOptions(client, 'albums', '1', 'tracks')
    const filtered = relatedQueryOptions(client, 'albums', '1', 'tracks', {
      filter: { q: 'a' },
    } as never)
    const sorted = relatedQueryOptions(client, 'albums', '1', 'tracks', { sort: '-title' } as never)
    const paged = relatedQueryOptions(client, 'albums', '1', 'tracks', {
      page: { size: 1 },
    } as never)
    for (const options of [plain, filtered, sorted, paged]) {
      await queryClient.fetchQuery(options as never)
    }
    await queryClient.fetchQuery(getQueryOptions(client, 'tracks', 't3'))
    return { ...setup, plain, filtered, sorted, paged }
  }

  it('places automatically only in an unfiltered, unsorted, complete view', async () => {
    const { queryClient, plain, filtered, sorted, paged } = await reads()
    const draft = openDraft(queryClient, descriptor)
    draft.attach('albums', '1', 'tracks', [ref('t3')])

    expect(ids(dataOf(queryClient, plain))).toEqual(['t1', 't2', 't3'])
    expect(ids(dataOf(queryClient, filtered))).toEqual(['t1', 't2'])
    expect(ids(dataOf(queryClient, sorted))).toEqual(['t1', 't2'])
    expect(ids(dataOf(queryClient, paged))).toEqual(['t1'])
    // Every candidate is reported, placed or not, for the lifecycle to cancel and invalidate.
    const keys = draft.touchedKeys().map((key) => JSON.stringify(key))
    for (const options of [plain, filtered, sorted, paged]) {
      expect(keys).toContain(JSON.stringify(options.queryKey))
    }
  })

  it('places at the start when asked, on a first page only', async () => {
    const { queryClient, plain } = await reads()
    openDraft(queryClient, descriptor).attach(
      'albums',
      '1',
      'tracks',
      [ref('t3'), ref('t4', { title: 'Lucky', duration: 259 })],
      'start',
    )
    expect(ids(dataOf(queryClient, plain))).toEqual(['t3', 't4', 't1', 't2'])
  })

  it('offers every other view to into: an index, a function, or false', async () => {
    const { queryClient, plain, filtered, sorted, paged } = await reads()
    const seen: string[] = []
    const draft = openDraft(queryClient, descriptor, {
      into: (q: DraftQuery, member) => {
        seen.push(`${JSON.stringify(q.params)}:${member['title'] as string}`)
        if (q.params.filter !== undefined) {
          return 1
        }
        if (q.params.sort !== undefined) {
          return (members) => members.findIndex((m) => (m['title'] as string) < 'Song 2')
        }
        return false
      },
    })
    draft.attach('albums', '1', 'tracks', [ref('t3')])

    expect(ids(dataOf(queryClient, plain))).toEqual(['t1', 't2', 't3'])
    expect(ids(dataOf(queryClient, filtered))).toEqual(['t1', 't3', 't2'])
    // 'Airbag' is the first title before 'Song 2'.
    expect(ids(dataOf(queryClient, sorted))).toEqual(['t3', 't1', 't2'])
    expect(ids(dataOf(queryClient, paged))).toEqual(['t1'])
    // The view placed automatically isn't offered.
    expect(seen).toHaveLength(3)
    expect(seen.every((entry) => entry.endsWith(':Song 2'))).toBe(true)
  })

  it("refuses 'end' on an incomplete view, and places by a negative index after the last member", async () => {
    const { queryClient, paged, sorted } = await reads()
    openDraft(queryClient, descriptor, {
      into: (q) => (q.params.page !== undefined ? 'end' : () => -1),
    }).attach('albums', '1', 'tracks', [ref('t3')])
    expect(ids(dataOf(queryClient, paged))).toEqual(['t1'])
    expect(ids(dataOf(queryClient, sorted))).toEqual(['t1', 't2', 't3'])
  })

  it('places nothing automatically with autoPlace off', async () => {
    const { queryClient, plain } = await reads()
    const draft = openDraft(queryClient, descriptor, { autoPlace: false })
    draft.attach('albums', '1', 'tracks', [ref('t3')])
    expect(ids(dataOf(queryClient, plain))).toEqual(['t1', 't2'])
    draft.attach('albums', '1', 'tracks', [ref('t3')], { into: () => 'end' })
    expect(ids(dataOf(queryClient, plain))).toEqual(['t1', 't2', 't3'])
  })

  it('removes from every view, whatever its filter, sort or page', async () => {
    const { queryClient, plain, filtered, sorted, paged } = await reads()
    const draft = openDraft(queryClient, descriptor)
    draft.detach('albums', '1', 'tracks', [ref('t1')])
    for (const options of [plain, filtered, sorted]) {
      expect(ids(dataOf(queryClient, options))).toEqual(['t2'])
    }
    expect(ids(dataOf(queryClient, paged))).toEqual([])
    draft.rollback()
    for (const options of [plain, filtered, sorted]) {
      expect(ids(dataOf(queryClient, options))).toEqual(['t1', 't2'])
    }
    expect(ids(dataOf(queryClient, paged))).toEqual(['t1'])
  })

  it('replaces members in order where placed automatically, and removes elsewhere', async () => {
    const { queryClient, plain, filtered } = await reads()
    const draft = openDraft(queryClient, descriptor)
    draft.replaceMembers('albums', '1', 'tracks', [ref('t3'), ref('t2')])
    expect(ids(dataOf(queryClient, plain))).toEqual(['t3', 't2'])
    expect(ids(dataOf(queryClient, filtered))).toEqual(['t2'])
    draft.rollback()
    expect(ids(dataOf(queryClient, plain))).toEqual(['t1', 't2'])
    expect(ids(dataOf(queryClient, filtered))).toEqual(['t1', 't2'])
  })

  it('places the start of an infinite read on its first page and the end on its last', async () => {
    const { client, queryClient } = catalogue()
    const infinite = infiniteRelatedQueryOptions(client, 'albums', '1', 'tracks', {
      page: { size: 1 },
    } as never)
    await queryClient.fetchInfiniteQuery(infinite)
    const observer = new InfiniteQueryObserver(queryClient, infinite as never)
    await observer.fetchNextPage()
    observer.destroy()
    await queryClient.fetchQuery(getQueryOptions(client, 'tracks', 't3'))
    expect(pagesOf(dataOf(queryClient, infinite))).toEqual([['t1'], ['t2']])

    openDraft(queryClient, descriptor).attach('albums', '1', 'tracks', [ref('t3')])
    expect(pagesOf(dataOf(queryClient, infinite))).toEqual([['t1'], ['t2', 't3']])
    openDraft(queryClient, descriptor, { autoPlace: false }).attach(
      'albums',
      '1',
      'tracks',
      [ref('t4', { title: 'Lucky', duration: 259 })],
      { into: () => 'start' },
    )
    expect(pagesOf(dataOf(queryClient, infinite))).toEqual([
      ['t4', 't1'],
      ['t2', 't3'],
    ])
    // A removal reaches whichever page holds the member.
    const draft = openDraft(queryClient, descriptor, { autoPlace: false })
    draft.detach('albums', '1', 'tracks', [ref('t2')])
    expect(pagesOf(dataOf(queryClient, infinite))).toEqual([['t4', 't1'], ['t3']])
    draft.rollback()
    expect(pagesOf(dataOf(queryClient, infinite))).toEqual([
      ['t4', 't1'],
      ['t2', 't3'],
    ])
  })

  it('inserts a new resource only where into places it', async () => {
    const { client, queryClient } = catalogue()
    const all = listQueryOptions(client, 'tracks')
    const sparse = listQueryOptions(client, 'tracks', { fields: { tracks: ['title'] } } as never)
    await queryClient.fetchQuery(all)
    await queryClient.fetchQuery(sparse)
    const created = { id: 'new', title: 'Untitled', duration: 0, artist: null }

    const nowhere = openDraft(queryClient, descriptor)
    nowhere.insert('tracks', created as never)
    expect(ids(dataOf(queryClient, all))).toEqual(['t1', 't2', 't3', 't4'])
    expect(nowhere.touchedKeys()).toHaveLength(2)

    const draft = openDraft(queryClient, descriptor)
    draft.insert('tracks', created as never, () => 'start')
    const rows = dataOf(queryClient, all) as Rows
    expect(ids(rows)).toEqual(['new', 't1', 't2', 't3', 't4'])
    expect(rows[0]!.$optimistic).toBe('pending')
    // The sparse list takes only the attributes its fieldset selects.
    const sparseRows = dataOf(queryClient, sparse) as Rows
    expect(ids(sparseRows)[0]).toBe('new')
    expect({ ...sparseRows[0] }).toEqual({ type: 'tracks', id: 'new', title: 'Untitled' })
    draft.rollback()
    expect(ids(dataOf(queryClient, all))).toEqual(['t1', 't2', 't3', 't4'])
  })

  it('hands into a frozen description, so changing it reaches no later call', async () => {
    const { client, queryClient } = catalogue()
    const filter = { title: 'Song 2' }
    const filtered = listQueryOptions(client, 'tracks', { filter, sort: ['title'] } as never)
    await queryClient.fetchQuery(filtered)
    const created = { id: 'new', title: 'Untitled', duration: 0, artist: null }
    const seen: unknown[] = []
    const errors: unknown[] = []
    const into = (q: DraftQuery) => {
      seen.push(JSON.parse(JSON.stringify(q)))
      for (const corrupt of [
        () => {
          ;(q as { type: string }).type = 'artists'
        },
        () => {
          ;(q.params as { filter?: unknown }).filter = undefined
        },
        () => {
          ;(q.params.filter as Record<string, unknown>)['title'] = 'Airbag'
        },
        () => {
          ;(q.params.sort as unknown as string[]).push('duration')
        },
        () => {
          ;(q.types as string[]).push('artists')
        },
      ]) {
        try {
          corrupt()
        } catch (error) {
          errors.push(error)
        }
      }
      return false as const
    }

    openDraft(queryClient, descriptor).insert('tracks', created as never, into)
    openDraft(queryClient, descriptor).insert('tracks', created as never, into)

    // Strict mode (an ES module) throws on every write to a frozen description.
    expect(errors).toHaveLength(10)
    expect(errors.every((error) => error instanceof TypeError)).toBe(true)
    expect(seen).toHaveLength(2)
    expect(seen[1]).toEqual(seen[0])
    // Neither the query's key nor the descriptor was frozen with it.
    expect(Object.isFrozen(filter)).toBe(false)
    expect(Object.isFrozen(descriptor.albums.relations.tracks.types)).toBe(false)
  })
})

// ── To-one ─────────────────────────────────────────────────────────────────────────────────

describe('link', () => {
  it('points every to-one view at the ref where it fits, and defers where it does not', async () => {
    const { client, queryClient } = catalogue()
    const included = getQueryOptions(client, 'albums', '1', { include: ['artist'] })
    const plain = getQueryOptions(client, 'albums', '1')
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'artist')
    const related = relatedQueryOptions(client, 'albums', '1', 'artist')
    for (const options of [included, plain, linkage, related]) {
      await queryClient.fetchQuery(options as never)
    }

    const draft = openDraft(queryClient, descriptor)
    draft.link('albums', '1', 'artist', { type: 'artists', id: 'a2' })
    // Blur isn't cached: identifier views take it, resource views keep Radiohead.
    expect((dataOf(queryClient, plain) as { artist: Row }).artist['id']).toBe('a2')
    expect((dataOf(queryClient, linkage) as Row)['id']).toBe('a2')
    expect((dataOf(queryClient, included) as { artist: Row }).artist['id']).toBe('a1')
    expect((dataOf(queryClient, related) as Row)['id']).toBe('a1')
    expect((dataOf(queryClient, included) as Row).$pending('artist')).toEqual([
      { type: 'artists', id: 'a2' },
    ])
    draft.rollback()
    expect((dataOf(queryClient, plain) as { artist: Row }).artist['id']).toBe('a1')
    expect((dataOf(queryClient, linkage) as Row)['id']).toBe('a1')

    // Once Blur is cached it fills every view.
    await queryClient.fetchQuery(getQueryOptions(client, 'artists', 'a2'))
    const second = openDraft(queryClient, descriptor)
    second.link('albums', '1', 'artist', { type: 'artists', id: 'a2' })
    expect((dataOf(queryClient, included) as { artist: Row }).artist['name']).toBe('Blur')
    expect((dataOf(queryClient, related) as Row)['name']).toBe('Blur')

    // Clearing applies everywhere.
    const third = openDraft(queryClient, descriptor)
    third.link('albums', '1', 'artist', null)
    for (const options of [included, plain]) {
      expect((dataOf(queryClient, options) as { artist: unknown }).artist).toBeNull()
    }
    expect(dataOf(queryClient, linkage)).toBeNull()
    expect(dataOf(queryClient, related)).toBeNull()
    third.rollback()
    expect((dataOf(queryClient, included) as { artist: Row }).artist['name']).toBe('Blur')

    // A to-one read holding `null` takes a link too (once a copy of the artist is cached again).
    const cleared = openDraft(queryClient, descriptor)
    cleared.link('albums', '1', 'artist', null)
    cleared.commit()
    await queryClient.fetchQuery(getQueryOptions(client, 'artists', 'a1'))
    openDraft(queryClient, descriptor).link('albums', '1', 'artist', { type: 'artists', id: 'a1' })
    expect((dataOf(queryClient, related) as Row)['name']).toBe('Radiohead')
    expect((dataOf(queryClient, linkage) as Row)['id']).toBe('a1')
  })
})

// ── Patch ──────────────────────────────────────────────────────────────────────────────────

describe('patch', () => {
  it('writes attributes onto every copy, and applies the relations it carries', async () => {
    const { client, queryClient } = catalogue()
    const get = getQueryOptions(client, 'albums', '1', { include: ['tracks'] })
    const list = listQueryOptions(client, 'albums')
    await queryClient.fetchQuery(get)
    await queryClient.fetchQuery(list)
    await queryClient.fetchQuery(getQueryOptions(client, 'artists', 'a2'))

    const draft = openDraft(queryClient, descriptor)
    draft.patch('albums', '1', {
      title: 'OKNOTOK',
      artist: { type: 'artists', id: 'a2' },
      tracks: [ref('t2')],
    } as never)
    const album = dataOf(queryClient, get) as Row & { tracks: Rows }
    const row = (dataOf(queryClient, list) as Rows)[0]!
    expect(album['title']).toBe('OKNOTOK')
    expect(row['title']).toBe('OKNOTOK')
    expect((row['artist'] as Row)['id']).toBe('a2')
    expect(ids(album.tracks)).toEqual(['t2'])
    expect(album.$optimistic).toBe('pending')
    expect(row.$optimistic).toBe('pending')

    draft.rollback()
    expect(album['title']).toBe('OK Computer')
    expect(((dataOf(queryClient, list) as Rows)[0]!['artist'] as Row)['id']).toBe('a1')
    expect(ids((dataOf(queryClient, get) as { tracks: Rows }).tracks)).toEqual(['t1', 't2'])
    expect(row.$optimistic).toBeUndefined()
  })

  it('never adds an attribute a sparse copy leaves out, optimistically or on success', async () => {
    const { client, queryClient, albums } = catalogue()
    const sparse = listQueryOptions(client, 'albums', { fields: { albums: ['title'] } } as never)
    const full = getQueryOptions(client, 'albums', '1')
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(sparse)
    await queryClient.fetchQuery(full)
    await queryClient.fetchQuery(linkage)

    const draft = openDraft(queryClient, descriptor)
    draft.patch('albums', '1', { title: 'Kid A', year: 2000 } as never)
    const row = (dataOf(queryClient, sparse) as Rows)[0]!
    expect(row['title']).toBe('Kid A')
    expect('year' in row).toBe(false)
    expect((dataOf(queryClient, full) as Row)['year']).toBe(2000)
    draft.commit()

    // A tracks read normalises; its tracks' identifiers in the linkage read never gain attributes.
    await queryClient.fetchQuery(listQueryOptions(client, 'tracks'))
    expect({ ...(dataOf(queryClient, linkage) as Rows)[0] }).toEqual({ type: 'tracks', id: 't1' })

    // A full read of the album on success leaves the sparse row without `year`.
    albums['1']!.year = 2001
    await queryClient.refetchQueries({ queryKey: full.queryKey })
    const again = (dataOf(queryClient, sparse) as Rows)[0]!
    expect(again['title']).toBe('OK Computer')
    expect('year' in again).toBe(false)
  })
})

// ── Evict ──────────────────────────────────────────────────────────────────────────────────

describe('evict', () => {
  it('removes the resource from every list, slot and page, and nulls to-ones', async () => {
    const { client, queryClient } = catalogue()
    const album = getQueryOptions(client, 'albums', '1', { include: ['tracks', 'tracks.artist'] })
    const tracks = listQueryOptions(client, 'tracks', { include: ['artist'] } as never)
    const infinite = infiniteListQueryOptions(client, 'tracks')
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    const own = getQueryOptions(client, 'tracks', 't1')
    const artist = getQueryOptions(client, 'artists', 'a1')
    const artistOf = relatedQueryOptions(client, 'albums', '1', 'artist')
    for (const options of [album, tracks, linkage, own, artist, artistOf]) {
      await queryClient.fetchQuery(options as never)
    }
    await queryClient.fetchInfiniteQuery(infinite)

    const draft = openDraft(queryClient, descriptor)
    draft.evict('tracks', 't1')
    expect(ids((dataOf(queryClient, album) as { tracks: Rows }).tracks)).toEqual(['t2'])
    expect(ids(dataOf(queryClient, tracks))).toEqual(['t2', 't3', 't4'])
    expect(pagesOf(dataOf(queryClient, infinite))).toEqual([['t2', 't3', 't4']])
    expect(ids(dataOf(queryClient, linkage))).toEqual(['t2'])
    // Its own read is left alone.
    expect((dataOf(queryClient, own) as Row)['id']).toBe('t1')
    expect(draft.touchedKeys().map((key) => JSON.stringify(key))).not.toContain(
      JSON.stringify(own.queryKey),
    )

    // Evicting an artist nulls the to-ones holding it, nested included slots too.
    const second = openDraft(queryClient, descriptor)
    second.evict('artists', 'a1')
    const nested = (dataOf(queryClient, album) as { tracks: (Row & { artist: unknown })[] }).tracks
    expect(nested[0]!.artist).toBeNull()
    expect((dataOf(queryClient, album) as { artist: unknown }).artist).toBeNull()
    expect(dataOf(queryClient, artistOf)).toBeNull()
    expect((dataOf(queryClient, tracks) as (Row & { artist: unknown })[])[0]!.artist).toBeNull()
    expect((dataOf(queryClient, artist) as Row)['id']).toBe('a1')

    second.rollback()
    draft.rollback()
    expect(ids((dataOf(queryClient, album) as { tracks: Rows }).tracks)).toEqual(['t1', 't2'])
    expect(pagesOf(dataOf(queryClient, infinite))).toEqual([['t1', 't2', 't3', 't4']])
    expect((dataOf(queryClient, album) as { artist: Row }).artist['id']).toBe('a1')
    expect((dataOf(queryClient, tracks) as (Row & { artist: Row })[])[0]!.artist['name']).toBe(
      'Radiohead',
    )
  })
})

// ── Counts and markers ─────────────────────────────────────────────────────────────────────

describe('counts and markers', () => {
  it('moves a counted parent’s $count by the members added and removed', async () => {
    const { client, queryClient } = catalogue()
    const get = getQueryOptions(client, 'albums', '1', { withCount: ['tracks'] } as never)
    const plain = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(get)
    await queryClient.fetchQuery(plain)
    const album = () => dataOf(queryClient, get) as Row & { tracks: Rows }
    expect(album().$count('tracks')).toBe(2)

    const added = openDraft(queryClient, descriptor)
    added.attach('albums', '1', 'tracks', [ref('t3'), ref('t4'), ref('t1')])
    expect(album().$count('tracks')).toBe(4)
    expect(album().tracks.$count).toBe(4)
    // A copy that carries no count still carries none.
    expect((dataOf(queryClient, plain) as Row).$count('tracks')).toBeUndefined()

    const removed = openDraft(queryClient, descriptor)
    removed.detach('albums', '1', 'tracks', [ref('t1')])
    expect(album().$count('tracks')).toBe(3)

    added.rollback()
    expect(album().$count('tracks')).toBe(1)
    removed.commit()
    expect(album().$count('tracks')).toBe(2)
  })

  it('marks what it touched, read through per-edge views, until it commits', async () => {
    const { client, queryClient } = catalogue()
    const tracks = listQueryOptions(client, 'tracks', { include: ['artist'] } as never)
    await queryClient.fetchQuery(tracks)
    const rows = () => dataOf(queryClient, tracks) as (Row & { artist: Row })[]

    const draft = openDraft(queryClient, descriptor)
    draft.patch('artists', 'a1', { name: 'On a Friday' } as never)
    expect(rows()[0]!.artist.$optimistic).toBe('pending')
    expect(rows()[0]!.artist['name']).toBe('On a Friday')
    expect(rows()[2]!.artist.$optimistic).toBeUndefined()
    expect(rows()[0]!.$optimistic).toBeUndefined()
    expect(Object.keys(rows()[0]!.artist)).not.toContain('$optimistic')

    draft.commit()
    expect(rows()[0]!.artist.$optimistic).toBeUndefined()
    expect(rows()[0]!.artist['name']).toBe('On a Friday')
    expect(() => draft.patch('artists', 'a1', { name: 'x' } as never)).toThrow(/already committed/)
  })
})

// ── Rollback ───────────────────────────────────────────────────────────────────────────────

describe('rollback is compare-and-swap', () => {
  it('keeps what a normalise and a second draft changed between apply and rollback', async () => {
    const { client, queryClient, albums } = catalogue()
    const get = getQueryOptions(client, 'albums', '1')
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(get)
    await queryClient.fetchQuery(linkage)

    const first = openDraft(queryClient, descriptor)
    first.batch(() => {
      first.patch('albums', '1', { title: 'Predicted', year: 1998 } as never)
      first.attach('albums', '1', 'tracks', [ref('t3')])
      first.detach('albums', '1', 'tracks', [ref('t1')])
    })

    // A read lands: the server renamed the album (it knows nothing of the pending write). The
    // predictions keep showing while the draft is open, and the server values are recorded.
    albums['1']!.title = 'Server'
    await queryClient.fetchQuery(getQueryOptions(client, 'albums', '1', { include: ['artist'] }))
    expect((dataOf(queryClient, get) as Row)['year']).toBe(1998)
    expect((dataOf(queryClient, get) as Row)['title']).toBe('Predicted')
    // A second draft adds its own member and predicts its own year.
    const second = openDraft(queryClient, descriptor)
    second.batch(() => {
      second.attach('albums', '1', 'tracks', [ref('t4')])
      second.patch('albums', '1', { year: 2017 } as never)
    })
    expect(ids(dataOf(queryClient, linkage))).toEqual(['t2', 't3', 't4'])

    first.rollback()
    const album = dataOf(queryClient, get) as Row
    // The normalised title and the second draft's year and member all survive; the first draft's
    // removal is undone at its index and its addition withdrawn.
    expect(album['title']).toBe('Server')
    expect(album['year']).toBe(2017)
    expect(ids(dataOf(queryClient, linkage))).toEqual(['t1', 't2', 't4'])
    expect(ids((album as { tracks?: Rows }).tracks)).toEqual(['t1', 't2', 't4'])

    // The second draft restores the value it replaced: the server's, not the first prediction.
    second.rollback()
    expect(album['year']).toBe(1997)
    expect(album['title']).toBe('Server')
    expect(ids(dataOf(queryClient, linkage))).toEqual(['t1', 't2'])
  })

  it('leaves a list a read replaced since', async () => {
    const { client, queryClient, albums } = catalogue()
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(linkage)
    const draft = openDraft(queryClient, descriptor)
    draft.detach('albums', '1', 'tracks', [ref('t1')])
    albums['1']!.tracks = ['t2']
    await queryClient.refetchQueries({ queryKey: linkage.queryKey })
    draft.rollback()
    expect(ids(dataOf(queryClient, linkage))).toEqual(['t2'])
  })
})

// ── Publishing ─────────────────────────────────────────────────────────────────────────────

describe('publishing', () => {
  it('republishes each touched query once per transaction', async () => {
    const { client, queryClient } = catalogue()
    const get = getQueryOptions(client, 'albums', '1', { include: ['tracks'] })
    const untouched = getQueryOptions(client, 'artists', 'a2')
    await queryClient.fetchQuery(get)
    await queryClient.fetchQuery(untouched)
    await queryClient.fetchQuery(getQueryOptions(client, 'tracks', 't3'))
    const count = (options: { queryKey: readonly unknown[] }) => {
      const observer = new QueryObserver(queryClient, {
        ...(options as object),
        notifyOnChangeProps: ['data'],
      } as never)
      const seen = { n: 0 }
      observer.subscribe(() => {
        seen.n += 1
      })
      return seen
    }
    const album = count(get)
    const other = count(untouched)

    const draft = openDraft(queryClient, descriptor)
    draft.batch(() => {
      draft.patch('albums', '1', { title: 'A', year: 1 } as never)
      draft.attach('albums', '1', 'tracks', [ref('t3')])
      draft.link('albums', '1', 'artist', null)
    })
    expect(album.n).toBe(1)
    expect(other.n).toBe(0)

    draft.rollback()
    expect(album.n).toBe(2)
    expect(other.n).toBe(0)
  })

  it('keeps a list’s envelope and normalises into an edited list', async () => {
    const { client, queryClient, tracks } = catalogue()
    const related = relatedQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(related)
    await queryClient.fetchQuery(getQueryOptions(client, 'tracks', 't3'))
    const before = dataOf(queryClient, related) as Rows & { $next: unknown }
    openDraft(queryClient, descriptor).attach('albums', '1', 'tracks', [ref('t3')])
    const after = dataOf(queryClient, related) as Rows & { $next: unknown }
    expect(after.$page).toBe(before.$page)
    expect(typeof after.$next).toBe('function')

    tracks['t3']!.title = 'Song 2 (remastered)'
    normalize(queryClient, await client.tracks.id('t3').get(), descriptor)
    expect((dataOf(queryClient, related) as Rows)[2]!['title']).toBe('Song 2 (remastered)')
  })
})

// ── Scopes and resolve ─────────────────────────────────────────────────────────────────────

describe('scopes', () => {
  it('edits only the queries of its own scope', async () => {
    const { client, queryClient } = catalogue()
    installNormalization(queryClient, descriptor, { scope: 'admin' })
    const main = getQueryOptions(client, 'albums', '1')
    const admin = withScope('admin', getQueryOptions(client, 'albums', '1'))
    await queryClient.fetchQuery(main)
    await queryClient.fetchQuery(admin)

    const draft = openDraft(queryClient, descriptor, { scope: 'admin' })
    draft.batch(() => {
      draft.patch('albums', '1', { title: 'Admin' } as never)
      draft.detach('albums', '1', 'tracks', [ref('t1')])
    })
    expect((dataOf(queryClient, admin) as Row)['title']).toBe('Admin')
    expect((dataOf(queryClient, main) as Row)['title']).toBe('OK Computer')
    expect(ids((dataOf(queryClient, main) as { tracks: Rows }).tracks)).toEqual(['t1', 't2'])
    expect(draft.touchedKeys()).toEqual([admin.queryKey])
  })
})

describe('resolve', () => {
  it('returns the richest cached copy, else the identifier', async () => {
    const { client, queryClient } = catalogue()
    await queryClient.fetchQuery(
      listQueryOptions(client, 'tracks', { fields: { tracks: ['title'] } } as never),
    )
    await queryClient.fetchQuery(getQueryOptions(client, 'tracks', 't2'))
    const draft = openDraft(queryClient, descriptor)
    expect(draft.resolve('tracks', 't2')['duration']).toBe(383)
    expect(draft.resolve('tracks', 't1')['title']).toBe('Airbag')
    expect(draft.resolve('tracks', 'nope')).toEqual({ type: 'tracks', id: 'nope' })
  })
})

// ── The mutation lifecycle ─────────────────────────────────────────────────────────────────

describe('a JSON:API mutation’s draft', () => {
  it('stays marked while the write is pending and clears once it settles', async () => {
    const { client, queryClient } = catalogue()
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(get)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const mutation = queryClient.getMutationCache().build(queryClient, {
      ...updateMutationOptions(queryClient, client, descriptor, 'albums', '1', {
        optimistic: true,
      }),
      mutationFn: async () => {
        await gate
        return undefined
      },
    } as never)
    const written = mutation.execute({ title: 'Pending' })
    await Promise.resolve()
    const album = () => dataOf(queryClient, get) as Row
    expect(album()['title']).toBe('Pending')
    expect(album().$optimistic).toBe('pending')
    release?.()
    await written
    expect(album().$optimistic).toBeUndefined()
  })
})

// ── Typing ─────────────────────────────────────────────────────────────────────────────────

describe('typing', () => {
  it('types the operations against the descriptor', () => {
    const draft = openDraft(new QueryClient(), descriptor)
    const check = () => {
      draft.link('albums', '1', 'artist', { type: 'artists', id: 'a1' })
      draft.attach(
        'albums',
        '1',
        'tracks',
        [{ type: 'tracks', id: 't1', title: 'Airbag' }],
        'start',
      )
      draft.patch('albums', '1', { title: 'OK' })
      // @ts-expect-error — `nope` is not a type.
      draft.evict('nope', '1')
      // @ts-expect-error — `songs` is not a relation of albums.
      draft.detach('albums', '1', 'songs', [])
      // @ts-expect-error — `at` takes only 'start' or 'end'.
      draft.attach('albums', '1', 'tracks', [], 'middle')
    }
    expect(typeof check).toBe('function')
  })
})

// ── A pivot rendered on every member ───────────────────────────────────────────────────────

/** The catalogue's descriptor with album tracks marked as rendering `meta.pivot` on every member. */
const renderedPivot = {
  ...descriptor,
  albums: {
    ...descriptor.albums,
    relations: {
      ...descriptor.albums.relations,
      tracks: {
        ...descriptor.albums.relations.tracks,
        pivot: true,
        readPivot: { fields: { position: 'integer' } },
        pivotRendered: true,
      },
    },
  },
} as const satisfies ApiDescriptor

/** The catalogue's attributes, as a generated client types them. */
interface CatalogueAttributes {
  albums: { title: string; year: number }
  tracks: { title: string; duration: number }
  artists: { name: string }
}

/** Album tracks with a write-optional `weight` beside the required `position`. */
const weighted = {
  ...renderedPivot,
  albums: {
    ...renderedPivot.albums,
    relations: {
      ...renderedPivot.albums.relations,
      tracks: {
        ...renderedPivot.albums.relations.tracks,
        readPivot: { fields: { position: 'integer', weight: 'integer' } },
        writePivot: { fields: { position: 'integer', weight: 'integer' }, required: ['position'] },
      },
    },
  },
} as const satisfies ApiDescriptor

/** Album tracks whose write pivot requires nothing. */
const unrequired = {
  ...renderedPivot,
  albums: {
    ...renderedPivot.albums,
    relations: {
      ...renderedPivot.albums.relations,
      tracks: {
        ...renderedPivot.albums.relations.tracks,
        writePivot: { fields: { position: 'integer' }, required: [] },
      },
    },
  },
} as const satisfies ApiDescriptor

type WeightedLinkage = Awaited<
  ReturnType<
    ReturnType<Client<typeof weighted, CatalogueAttributes>['albums']['id']>['tracks']['get']
  >
>
type UnrequiredLinkage = Awaited<
  ReturnType<
    ReturnType<Client<typeof unrequired, CatalogueAttributes>['albums']['id']>['tracks']['get']
  >
>

describe('a pending member of a relation rendering its pivot on every member', () => {
  it('carries an empty pivot when the operation sent none', async () => {
    const { client, queryClient } = catalogue()
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(linkage)
    await queryClient.fetchQuery(get)

    openDraft(queryClient, renderedPivot).attach('albums', '1', 'tracks', [ref('t3')])

    const member = (dataOf(queryClient, linkage) as Rows)[2]!
    expect({ ...member }).toEqual({ type: 'tracks', id: 't3', meta: { pivot: {} } })
    expect(member.$pivot).toEqual({})
    expect(member.$optimistic).toBe('pending')
    const slot = (dataOf(queryClient, get) as Row & { tracks: Rows }).tracks[2]!
    expect(slot.$pivot).toEqual({})
  })

  it('carries the pivot values the operation sent, in an included slot too', async () => {
    const { client, queryClient } = catalogue()
    const get = getQueryOptions(client, 'albums', '1', { include: ['tracks'] })
    await queryClient.fetchQuery(get)
    await queryClient.fetchQuery(listQueryOptions(client, 'tracks'))

    openDraft(queryClient, renderedPivot).attach('albums', '1', 'tracks', [
      ref('t3', { $pivot: { position: 3 } }),
    ])

    const added = (dataOf(queryClient, get) as Row & { tracks: Rows }).tracks[2]!
    expect(added['title']).toBe('Song 2')
    expect(added.$pivot).toEqual({ position: 3 })
  })

  it('carries an empty pivot on a member a replace brings in', async () => {
    const { client, queryClient } = catalogue()
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(linkage)

    openDraft(queryClient, renderedPivot).replaceMembers('albums', '1', 'tracks', [
      ref('t1'),
      ref('t4'),
    ])

    const members = dataOf(queryClient, linkage) as Rows
    expect(ids(members)).toEqual(['t1', 't4'])
    expect(members[1]!.$pivot).toEqual({})
    expect(members[1]!.$optimistic).toBe('pending')
  })

  it('leaves a field only the server sets undefined, as the pending type allows', async () => {
    const stamped = {
      ...renderedPivot,
      albums: {
        ...renderedPivot.albums,
        relations: {
          ...renderedPivot.albums.relations,
          tracks: {
            ...renderedPivot.albums.relations.tracks,
            readPivot: { fields: { addedAt: 'date-time', position: 'integer' } },
            writePivot: { fields: { position: 'integer' } },
          },
        },
      },
    } as const satisfies ApiDescriptor
    type Attributes = {
      albums: { title: string; year: number }
      tracks: { title: string; duration: number }
      artists: { name: string }
    }
    type Linkage = Awaited<
      ReturnType<ReturnType<Client<typeof stamped, Attributes>['albums']['id']>['tracks']['get']>
    >
    const { client, queryClient } = catalogue()
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(linkage)

    openDraft(queryClient, stamped).attach('albums', '1', 'tracks', [
      ref('t3', { $pivot: { position: 3 } }),
    ])

    const member = (dataOf(queryClient, linkage) as Linkage)[2]!
    expectTypeOf(member.$pivot.addedAt).toEqualTypeOf<string | undefined>()
    expect(member.$optimistic).toBe('pending')
    if (member.$optimistic === 'pending') {
      expectTypeOf(member.$pivot.position).toEqualTypeOf<number>()
      expect(member.$pivot.position).toBe(3)
      expect(member.$pivot.addedAt).toBeUndefined()
      expect(member.$edge.meta.pivot.addedAt).toBeUndefined()
    } else {
      expectTypeOf(member.$pivot.addedAt).toEqualTypeOf<string>()
    }
  })

  it('leaves a write-optional field the write left out undefined, as the pending type allows', async () => {
    const { client, queryClient } = catalogue()
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(linkage)

    openDraft(queryClient, weighted).attach('albums', '1', 'tracks', [
      ref('t3', { $pivot: { position: 3 } }),
    ])

    const member = (dataOf(queryClient, linkage) as WeightedLinkage)[2]!
    expect(member.$optimistic).toBe('pending')
    if (member.$optimistic === 'pending') {
      expectTypeOf(member.$pivot.position).toEqualTypeOf<number>()
      expectTypeOf(member.$pivot.weight).toEqualTypeOf<number | undefined>()
      expect(member.$pivot.weight).toBeUndefined()
    } else {
      expectTypeOf(member.$pivot.weight).toEqualTypeOf<number>()
    }
  })

  it('leaves every field undefined on an attach that sent no pivot, as the pending type allows', async () => {
    const { client, queryClient } = catalogue()
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(linkage)

    openDraft(queryClient, unrequired).attach('albums', '1', 'tracks', [ref('t3')])

    const member = (dataOf(queryClient, linkage) as UnrequiredLinkage)[2]!
    expect(member.$optimistic).toBe('pending')
    if (member.$optimistic === 'pending') {
      expectTypeOf(member.$pivot.position).toEqualTypeOf<number | undefined>()
      expect(member.$pivot).toEqual({})
    } else {
      expectTypeOf(member.$pivot.position).toEqualTypeOf<number>()
    }
  })

  it('leaves a relation without the mark as it was', async () => {
    const { client, queryClient } = catalogue()
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(linkage)

    openDraft(queryClient, descriptor).attach('albums', '1', 'tracks', [ref('t3')])

    expect((dataOf(queryClient, linkage) as Rows)[2]!.$pivot).toBeUndefined()
  })
})
