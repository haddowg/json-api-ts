import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { InfiniteQueryObserver, type Query, QueryClient } from '@tanstack/query-core'
import { describe, expect, it, vi } from 'vitest'
import { cacheView } from './cache-index'
import { openDraft, openDraftHandle } from './draft'
import { installNormalization } from './install'
import { isInfiniteValue, partsOf } from './normalize'
import {
  getQueryOptions,
  infiniteListQueryOptions,
  listQueryOptions,
  relatedQueryOptions,
  relationshipQueryOptions,
} from './read'
import { withScope } from './scope'
import { describeQuery, viewShape, type ViewShape, walkShaped } from './view-shape'

const BASE = 'https://music.example'

const descriptor = {
  albums: {
    attributes: { title: 'string' },
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
      create: '/albums',
    },
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['artist', 'tracks'],
  },
  tracks: {
    attributes: { title: 'string' },
    relations: { album: { cardinality: 'one', types: ['albums'], pivot: false } },
    paths: { fetchMany: '/tracks', fetchOne: '/tracks/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
  artists: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchMany: '/artists', fetchOne: '/artists/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

interface Album {
  title: string
  artist: string
  tracks: string[]
}

/** A catalogue served over a mock transport, and a QueryClient built as an app builds one. */
function setup() {
  const albums: Record<string, Album> = {
    '1': { title: 'OK Computer', artist: 'a1', tracks: ['t1', 't2'] },
    '2': { title: 'Kid A', artist: 'a1', tracks: ['t3'] },
    '3': { title: 'Parklife', artist: 'a2', tracks: ['t4', 't5'] },
  }
  const tracks: Record<string, string> = {
    t1: 'Airbag',
    t2: 'Paranoid Android',
    t3: 'Idioteque',
    t4: 'Girls & Boys',
    t5: 'Tracy Jacks',
    t6: 'Lucky',
  }
  const artists: Record<string, string> = { a1: 'Radiohead', a2: 'Blur' }
  const albumOf = (track: string) =>
    Object.keys(albums).find((id) => albums[id]!.tracks.includes(track)) ?? null
  const track = (id: string) => ({
    type: 'tracks',
    id,
    attributes: { title: tracks[id]! },
    relationships: {
      album: { data: albumOf(id) === null ? null : { type: 'albums', id: albumOf(id) } },
    },
  })
  const album = (id: string) => ({
    type: 'albums',
    id,
    attributes: { title: albums[id]!.title },
    relationships: {
      artist: { data: { type: 'artists', id: albums[id]!.artist } },
      tracks: { data: albums[id]!.tracks.map((t) => ({ type: 'tracks', id: t })) },
    },
  })
  const artist = (id: string) => ({ type: 'artists', id, attributes: { name: artists[id]! } })
  const included = (ids: string[], params: URLSearchParams) => {
    const include = params.get('include')?.split(',') ?? []
    const out = new Map<string, unknown>()
    for (const id of ids) {
      if (include.includes('artist')) {
        out.set(`artists:${albums[id]!.artist}`, artist(albums[id]!.artist))
      }
      if (include.includes('tracks')) {
        for (const t of albums[id]!.tracks) {
          out.set(`tracks:${t}`, track(t))
        }
      }
    }
    return [...out.values()]
  }
  const route = (url: URL): unknown => {
    const [kind, id, rel, sub] = url.pathname.split('/').filter(Boolean)
    const params = url.searchParams
    if (kind === 'artists') {
      return { data: id === undefined ? Object.keys(artists).map(artist) : artist(id) }
    }
    if (kind === 'tracks') {
      if (id !== undefined) {
        return { data: track(id) }
      }
      const all = Object.keys(tracks)
      const number = Number(params.get('page[number]') ?? '1')
      const size = Number(params.get('page[size]') ?? `${all.length}`)
      const next = `${BASE}/tracks?page%5Bnumber%5D=${number + 1}&page%5Bsize%5D=${size}`
      return {
        data: all.slice((number - 1) * size, number * size).map(track),
        links: number * size < all.length ? { next } : {},
      }
    }
    if (id === undefined) {
      const ids = Object.keys(albums)
      return { data: ids.map(album), included: included(ids, params) }
    }
    if (rel === 'relationships') {
      return { data: albums[id]!.tracks.map((t) => ({ type: 'tracks', id: t })) }
    }
    if (rel === 'tracks' && sub === undefined) {
      return { data: albums[id]!.tracks.map(track) }
    }
    return { data: album(id), included: included([id], params) }
  }
  const transport = async (req: TransportRequest): Promise<TransportResponse> => ({
    status: 200,
    headers: {},
    body: JSON.stringify(route(new URL(req.url))),
  })
  const client = createClient(descriptor, { baseUrl: BASE, transport })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  })
  installNormalization(queryClient, descriptor)
  return { client, queryClient, albums, tracks }
}

/** A cached query's top-level shape, decoded afresh (not through the index's memo). */
function shapeOf(query: Query): ViewShape | undefined {
  const description = describeQuery(query, descriptor)
  return description === undefined || description.skipped
    ? undefined
    : viewShape(description, descriptor)
}

/** Every copy a fresh walk of `query`'s data reaches, as the index records them. */
function walked(query: Query) {
  const out: { node: object; shape: ViewShape | undefined; part: number; first: boolean }[] = []
  const reached = new Set<object>()
  const data = query.state.data
  const parts = data === undefined || data === null ? [] : partsOf(data)
  parts.forEach((part, at) => {
    walkShaped(part, shapeOf(query), descriptor, (node, shape) => {
      out.push({ node, shape, part: at, first: !reached.has(node) })
      reached.add(node)
    })
  })
  return out
}

const keyOf = (node: object) => {
  const { type, id } = node as { type: string; id: string }
  return `${type}:${id}`
}

/**
 * The index of `scope` agrees with a fresh walk of every cached query: the same copies, in the
 * same order, each with its slot's shape, its part and whether an earlier part reaches it; and
 * each `type:id` held by exactly the queries a walk finds it in.
 */
function expectConsistent(queryClient: QueryClient, scope?: string): void {
  const view = cacheView(queryClient, scope, descriptor)
  const holders = new Map<string, Set<Query>>()
  for (const query of view.queries) {
    const fresh = walked(query)
    const indexed = view.copies(query)
    expect(indexed.map((visit) => visit.node)).toEqual(fresh.map((visit) => visit.node))
    indexed.forEach((visit, at) => {
      const expected = fresh[at]!
      expect(visit.node).toBe(expected.node)
      expect(visit.part).toBe(expected.part)
      expect(visit.first).toBe(expected.first)
      expect(visit.shape).toEqual(expected.shape)
    })
    for (const { node } of fresh) {
      const set = holders.get(keyOf(node)) ?? new Set<Query>()
      set.add(query)
      holders.set(keyOf(node), set)
    }
  }
  for (const [key, queries] of holders) {
    const [type, ...rest] = key.split(':')
    // oxlint-disable-next-line no-array-sort -- spread into fresh arrays
    expect([...view.holding(type!, rest.join(':'))].sort(byHash)).toEqual([...queries].sort(byHash))
  }
}

const byHash = (a: Query, b: Query) => a.queryHash.localeCompare(b.queryHash)

/** A QueryClient caching the catalogue in lists, single, related, relationship and infinite reads. */
async function cached() {
  const s = setup()
  const { client, queryClient } = s
  await queryClient.fetchQuery(
    listQueryOptions(client, 'albums', { include: ['artist', 'tracks'] }),
  )
  await queryClient.fetchQuery(getQueryOptions(client, 'albums', '1', { include: ['tracks'] }))
  await queryClient.fetchQuery(getQueryOptions(client, 'albums', '2'))
  await queryClient.fetchQuery(relatedQueryOptions(client, 'albums', '1', 'tracks'))
  await queryClient.fetchQuery(relationshipQueryOptions(client, 'albums', '1', 'tracks'))
  await queryClient.fetchQuery(getQueryOptions(client, 'tracks', 't6'))
  const infinite = infiniteListQueryOptions(client, 'tracks', { page: { size: 2 } })
  const observer = new InfiniteQueryObserver(queryClient, infinite as never)
  const stop = observer.subscribe(() => {})
  await vi.waitFor(() => expect(observer.getCurrentResult().data).toBeDefined())
  return { ...s, observer, stop, infinite }
}

const albumsList = (s: { client: ReturnType<typeof setup>['client'] }) =>
  listQueryOptions(s.client, 'albums', { include: ['artist', 'tracks'] })

const idsOf = (value: unknown): string[] => (value as { id: string }[]).map((member) => member.id)

describe('the cache index', () => {
  it('agrees with a walk of every cached read', async () => {
    const s = await cached()
    expectConsistent(s.queryClient)
    const view = cacheView(s.queryClient, undefined, descriptor)
    // t1 is in the album list, album 1's reads and the infinite list.
    expect(view.holding('tracks', 't1').size).toBe(5)
    s.stop()
  })

  it('follows an infinite query gaining a page', async () => {
    const s = await cached()
    expectConsistent(s.queryClient)
    expect(cacheView(s.queryClient, undefined, descriptor).holding('tracks', 't3').size).toBe(2)
    await s.observer.fetchNextPage()
    expectConsistent(s.queryClient)
    const infinite = s.queryClient.getQueryCache().find({ queryKey: s.infinite.queryKey })!
    expect(cacheView(s.queryClient, undefined, descriptor).holding('tracks', 't3')).toContain(
      infinite,
    )
    s.stop()
  })

  it('follows a refetch replacing a query’s data', async () => {
    const s = await cached()
    expectConsistent(s.queryClient)
    s.albums['2']!.tracks = ['t3', 't6']
    await s.queryClient.fetchQuery({ ...albumsList(s), staleTime: 0 })
    expectConsistent(s.queryClient)
    const list = s.queryClient.getQueryCache().find({ queryKey: albumsList(s).queryKey })!
    expect(cacheView(s.queryClient, undefined, descriptor).holding('tracks', 't6')).toContain(list)
    s.stop()
  })

  it('follows the app’s own setQueryData, materialised or plain', async () => {
    const s = await cached()
    const single = getQueryOptions(s.client, 'albums', '2')
    const other = await s.queryClient.fetchQuery(getQueryOptions(s.client, 'albums', '3'))
    s.queryClient.setQueryData(single.queryKey as never, other as never)
    expectConsistent(s.queryClient)
    const query = s.queryClient.getQueryCache().find({ queryKey: single.queryKey })!
    const view = cacheView(s.queryClient, undefined, descriptor)
    expect(view.holding('albums', '3')).toContain(query)
    expect(view.holding('albums', '2')).not.toContain(query)

    s.queryClient.setQueryData(['app', 'own'], { type: 'artists', id: 'a9', name: 'Plain' })
    expectConsistent(s.queryClient)
    expect(cacheView(s.queryClient, undefined, descriptor).holding('artists', 'a9').size).toBe(1)
    s.stop()
  })

  it('releases a removed or garbage-collected query', async () => {
    const s = await cached()
    expectConsistent(s.queryClient)
    const related = relatedQueryOptions(s.client, 'albums', '1', 'tracks')
    const query = s.queryClient.getQueryCache().find({ queryKey: related.queryKey })!
    expect(cacheView(s.queryClient, undefined, descriptor).holding('tracks', 't1')).toContain(query)
    s.queryClient.removeQueries({ queryKey: related.queryKey, exact: true })
    // Dropped on the cache's event, before any lookup.
    const view = cacheView(s.queryClient, undefined, descriptor)
    expect(view.holding('tracks', 't1')).not.toContain(query)
    expectConsistent(s.queryClient)

    vi.useFakeTimers()
    try {
      await s.queryClient.fetchQuery({
        ...getQueryOptions(s.client, 'artists', 'a2'),
        gcTime: 10,
      })
      expect(cacheView(s.queryClient, undefined, descriptor).holding('artists', 'a2').size).toBe(2)
      await vi.advanceTimersByTimeAsync(20)
      expect(cacheView(s.queryClient, undefined, descriptor).holding('artists', 'a2').size).toBe(1)
    } finally {
      vi.useRealTimers()
    }
    expectConsistent(s.queryClient)
    s.stop()
  })

  it('follows a draft’s membership edits and their rollback', async () => {
    const s = await cached()
    await s.queryClient.fetchQuery(getQueryOptions(s.client, 'tracks', 't3'))
    const draft = openDraft(s.queryClient, descriptor)
    draft.attach('albums', '1', 'tracks', [{ type: 'tracks', id: 't6' }])
    expectConsistent(s.queryClient)
    const list = s.queryClient.getQueryCache().find({ queryKey: albumsList(s).queryKey })!
    expect(cacheView(s.queryClient, undefined, descriptor).holding('tracks', 't6')).toContain(list)

    draft.detach('albums', '1', 'tracks', [{ type: 'tracks', id: 't1' }])
    expectConsistent(s.queryClient)
    draft.replaceMembers('albums', '3', 'tracks', [
      { type: 'tracks', id: 't3' },
      { type: 'tracks', id: 't4' },
    ])
    expectConsistent(s.queryClient)
    draft.link('albums', '2', 'artist', { type: 'artists', id: 'a2' })
    expectConsistent(s.queryClient)
    draft.evict('tracks', 't2')
    expectConsistent(s.queryClient)
    // Evicted from every list, slot and page.
    expect(cacheView(s.queryClient, undefined, descriptor).holding('tracks', 't2').size).toBe(0)

    draft.rollback()
    expectConsistent(s.queryClient)
    const view = cacheView(s.queryClient, undefined, descriptor)
    expect(view.holding('tracks', 't6')).not.toContain(list)
    expect(view.holding('tracks', 't2')).toContain(list)
    expect(
      idsOf((s.queryClient.getQueryData(albumsList(s).queryKey) as never[])[0]!['tracks']),
    ).toEqual(['t1', 't2'])
    s.stop()
  })

  it('follows a member shared by two parents leaving one of them', async () => {
    const s = await cached()
    await s.queryClient.fetchQuery(getQueryOptions(s.client, 'tracks', 't3'))
    const draft = openDraft(s.queryClient, descriptor)
    // Album 1's slot in the list gains a view of t3, which album 2 holds too; then album 2 loses it.
    draft.attach('albums', '1', 'tracks', [{ type: 'tracks', id: 't3' }])
    expectConsistent(s.queryClient)
    draft.detach('albums', '2', 'tracks', [{ type: 'tracks', id: 't3' }])
    expectConsistent(s.queryClient)
    draft.commit()
    expectConsistent(s.queryClient)
    s.stop()
  })

  it('follows a temporary id swapped for the server’s', async () => {
    const s = await cached()
    const draft = openDraftHandle(s.queryClient, descriptor)
    const row = { id: '$tmp:1', title: 'New', artist: null, tracks: [] }
    draft.insert('albums', row, () => 'start')
    expectConsistent(s.queryClient)
    const list = s.queryClient.getQueryCache().find({ queryKey: albumsList(s).queryKey })!
    expect(cacheView(s.queryClient, undefined, descriptor).holding('albums', '$tmp:1')).toContain(
      list,
    )
    draft.swapId('albums', '$tmp:1', 'srv-1')
    expectConsistent(s.queryClient)
    const view = cacheView(s.queryClient, undefined, descriptor)
    expect(view.holding('albums', '$tmp:1').size).toBe(0)
    expect(view.holding('albums', 'srv-1')).toContain(list)
    draft.commit()
    s.stop()
  })

  it('follows a read relinking other cached copies (R3)', async () => {
    const s = await cached()
    await s.queryClient.fetchQuery(getQueryOptions(s.client, 'tracks', 't3'))
    s.albums['1']!.tracks = ['t1', 't3']
    await s.queryClient.fetchQuery({
      ...getQueryOptions(s.client, 'albums', '1'),
      staleTime: 0,
    })
    expectConsistent(s.queryClient)
    const list = s.queryClient.getQueryCache().find({ queryKey: albumsList(s).queryKey })!
    const first = (list.state.data as { tracks: unknown }[])[0]!
    expect(idsOf(first.tracks)).toEqual(['t1', 't3'])
    // The R3 relink of album 1's slot in the list didn't drop t2 from what the index finds there.
    expect(cacheView(s.queryClient, undefined, descriptor).holding('tracks', 't2')).not.toContain(
      list,
    )
    s.stop()
  })

  it('keeps each scope to itself', async () => {
    const s = setup()
    installNormalization(s.queryClient, descriptor, { scope: 'admin' })
    const plain = getQueryOptions(s.client, 'albums', '1')
    const scoped = withScope('admin', getQueryOptions(s.client, 'albums', '1'))
    await s.queryClient.fetchQuery(plain)
    await s.queryClient.fetchQuery(scoped as never)
    const unscopedView = cacheView(s.queryClient, undefined, descriptor)
    const adminView = cacheView(s.queryClient, 'admin', descriptor)
    const plainQuery = s.queryClient.getQueryCache().find({ queryKey: plain.queryKey })!
    const scopedQuery = s.queryClient
      .getQueryCache()
      .find({ queryKey: (scoped as { queryKey: readonly unknown[] }).queryKey })!
    expect([...unscopedView.holding('albums', '1')]).toEqual([plainQuery])
    expect([...adminView.holding('albums', '1')]).toEqual([scopedQuery])
    expectConsistent(s.queryClient)
    expectConsistent(s.queryClient, 'admin')
  })

  it('reads an infinite query’s every page', async () => {
    const s = await cached()
    await s.observer.fetchNextPage()
    await s.observer.fetchNextPage()
    const infinite = s.queryClient.getQueryCache().find({ queryKey: s.infinite.queryKey })!
    expect(isInfiniteValue(infinite.state.data)).toBe(true)
    const view = cacheView(s.queryClient, undefined, descriptor)
    expect(new Set(view.copies(infinite).map((visit) => visit.part))).toEqual(new Set([0, 1, 2]))
    expectConsistent(s.queryClient)
    s.stop()
  })
})
