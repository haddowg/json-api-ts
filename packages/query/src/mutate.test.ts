import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import {
  type MutationOptions as CoreMutationOptions,
  QueryClient,
  QueryObserver,
} from '@tanstack/query-core'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { installNormalization } from './install'
import { resourceKey } from './keys'
import {
  addRelationshipMutationOptions,
  atomicMutationOptions,
  createMutationApi,
  createMutationOptions,
  deleteMutationOptions,
  type MutationOptions,
  removeRelationshipMutationOptions,
  replaceRelationshipMutationOptions,
  setRelationshipMutationOptions,
  updateMutationOptions,
} from './mutate'
import { JsonApiMutationCache } from './mutation-cache'
import {
  getQueryOptions,
  listQueryOptions,
  relatedQueryOptions,
  relationshipQueryOptions,
} from './read'
import { ATOMIC_MUTATION_KEY, mutationKeyFor } from './upkeep'

const BASE = 'https://music.example'

// The music-catalog descriptor: albums (artist to-one + tracks to-many, both fully mutable),
// artists, tracks. `as const satisfies` keeps the literals so the bound API narrows for real.
const descriptor = {
  albums: {
    attributes: { title: 'string', year: 'number' },
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
      update: '/albums/{id}',
      delete: '/albums/{id}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['artist', 'tracks'],
    sortable: ['title', '-title'],
    filterable: ['q'],
    resourceCountable: {
      create: { tokens: ['tracks'], profile: 'https://music.example/profiles/countable/' },
      update: { tokens: ['tracks'], profile: 'https://music.example/profiles/countable/' },
    },
  },
  artists: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchMany: '/artists', fetchOne: '/artists/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
  tracks: {
    attributes: { title: 'string' },
    relations: {},
    paths: { fetchOne: '/tracks/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

const resource = (type: string, id: string, attributes: Record<string, unknown> = {}) => ({
  type,
  id,
  attributes,
})

/**
 * A mock transport replying from a route table keyed by `METHOD path` (query stripped). A route
 * value of `'error'` replies `422` so a mutation rejects (drives the rollback test).
 */
function makeClient(routes: Record<string, unknown>) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    const url = new URL(req.url)
    const route = routes[`${req.method} ${url.pathname}`]
    if (route === 'error') {
      return {
        status: 422,
        headers: {},
        body: JSON.stringify({ errors: [{ status: '422', code: 'NO' }] }),
      }
    }
    if (route === undefined) {
      return { status: 404, headers: {}, body: JSON.stringify({ errors: [{ status: '404' }] }) }
    }
    return { status: 200, headers: {}, body: JSON.stringify(route) }
  }
  const client = createClient(descriptor, { baseUrl: BASE, transport })
  return { client, requests }
}

/**
 * A QueryClient as an app builds one: with the {@link JsonApiMutationCache} and the descriptor
 * installed. Reads stay fresh so an invalidation shows as `isInvalidated` rather than a refetch.
 */
function jsonApiQueryClient(desc: ApiDescriptor = descriptor): QueryClient {
  const qc = new QueryClient({
    mutationCache: new JsonApiMutationCache(),
    defaultOptions: { queries: { staleTime: Infinity } },
  })
  installNormalization(qc, desc)
  return qc
}

/** Drive a mutation-options object through query-core's mutation cache (no framework adapter). */
function runMutation<TData, TVars>(
  qc: QueryClient,
  options: MutationOptions<TData, TVars> & MutationCallbacks<TData, TVars>,
  variables: TVars,
): Promise<TData> {
  return qc
    .getMutationCache()
    .build<TData, unknown, TVars, unknown>(qc, options as never)
    .execute(variables)
}

/** The lifecycle callbacks an app spreads alongside a factory's options. */
interface MutationCallbacks<TData, TVars> {
  onMutate?: (variables: TVars) => unknown
  onError?: (error: unknown, variables: TVars) => unknown
  onSuccess?: (data: TData, variables: TVars) => unknown
  onSettled?: (data: TData | undefined, error: unknown, variables: TVars) => unknown
}

describe('updateMutationOptions — patch, no invalidate', () => {
  it('patches a cached list + get silently on success (no refetch)', async () => {
    const { client, requests } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'Old', year: 1997 })] },
      'GET /albums/1': { data: resource('albums', '1', { title: 'Old', year: 1997 }) },
      'PATCH /albums/1': { data: resource('albums', '1', { title: 'Fresh', year: 2024 }) },
    })
    const qc = jsonApiQueryClient()

    const listOpts = listQueryOptions(client, 'albums')
    const getOpts = getQueryOptions(client, 'albums', '1')
    await qc.fetchQuery(listOpts)
    await qc.fetchQuery(getOpts)
    const requestsAfterReads = requests.length

    await runMutation(qc, updateMutationOptions(qc, client, descriptor, 'albums', '1'), {
      title: 'Fresh',
      year: 2024,
    })

    // The list + get caches reflect the fresh attributes — patched, not refetched.
    const cachedList = qc.getQueryData(listOpts.queryKey) as Array<Record<string, unknown>>
    expect(cachedList[0]?.['title']).toBe('Fresh')
    expect(cachedList[0]?.['year']).toBe(2024)
    const cachedGet = qc.getQueryData(getOpts.queryKey) as Record<string, unknown>
    expect(cachedGet['title']).toBe('Fresh')

    // No list/get read refetched: the only new request is the PATCH itself.
    expect(requests).toHaveLength(requestsAfterReads + 1)
    expect(requests.at(-1)?.method).toBe('PATCH')
    // The cached reads are not invalidated (still fresh).
    expect(qc.getQueryState(listOpts.queryKey)?.isInvalidated).toBe(false)
  })
})

describe('createMutationOptions — invalidate the list subtree', () => {
  it('invalidates every cached list of the type on settle', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'A' })] },
      'POST /albums': { data: resource('albums', '2', { title: 'New' }) },
    })
    const qc = jsonApiQueryClient()

    const listA = listQueryOptions(client, 'albums', { filter: { q: 'a' } })
    const listB = listQueryOptions(client, 'albums', { sort: 'title' })
    await qc.fetchQuery(listA)
    await qc.fetchQuery(listB)
    expect(qc.getQueryState(listA.queryKey)?.isInvalidated).toBe(false)

    await runMutation(qc, createMutationOptions(qc, client, descriptor, 'albums'), { title: 'New' })

    // Both lists (the whole `[albums, fetchMany]` subtree) are invalidated by the create.
    expect(qc.getQueryState(listA.queryKey)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(listB.queryKey)?.isInvalidated).toBe(true)
  })
})

describe('write mutations with withCount', () => {
  it('sends the counts on a create and an update and types them as numbers', async () => {
    const counted = {
      data: {
        ...resource('albums', '1', { title: 'New' }),
        relationships: { tracks: { meta: { total: 3 } } },
      },
    }
    const { client, requests } = makeClient({ 'POST /albums': counted, 'PATCH /albums/1': counted })
    const qc = jsonApiQueryClient()

    const created = await runMutation(
      qc,
      createMutationApi(qc, client, descriptor).albums.create({ withCount: ['tracks'] }),
      { title: 'New' },
    )
    expect(requests[0]!.url).toBe(`${BASE}/albums?withCount=tracks`)
    expect(requests[0]!.headers['Accept']).toBe(
      'application/vnd.api+json; profile="https://music.example/profiles/countable/"',
    )
    expect(created.$count('tracks')).toBe(3)
    expectTypeOf(created.$count('tracks')).toEqualTypeOf<number>()

    const updated = await runMutation(
      qc,
      updateMutationOptions(qc, client, descriptor, 'albums', '1', { withCount: ['tracks'] }),
      { title: 'New' },
    )
    expect(requests[1]!.url).toBe(`${BASE}/albums/1?withCount=tracks`)
    expectTypeOf(updated.$count('tracks')).toEqualTypeOf<number>()
  })

  it('takes only the relations the write counts', () => {
    const { client } = makeClient({})
    const qc = jsonApiQueryClient()
    // @ts-expect-error `_self_` counts a collection, which a created album is not
    createMutationOptions(qc, client, descriptor, 'albums', { withCount: ['_self_'] })
    const album = createMutationApi(qc, client, descriptor).albums.id('1')
    // @ts-expect-error `artist` is not a relation the update counts
    album.update({ withCount: ['artist'] })
  })
})

describe('deleteMutationOptions — invalidate list, remove resource', () => {
  it('invalidates the list subtree and removes the resource reads on success', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1')] },
      'GET /albums/1': { data: resource('albums', '1') },
      'DELETE /albums/1': { data: null },
    })
    const qc = jsonApiQueryClient()

    const listOpts = listQueryOptions(client, 'albums')
    const getOpts = getQueryOptions(client, 'albums', '1')
    await qc.fetchQuery(listOpts)
    await qc.fetchQuery(getOpts)
    expect(qc.getQueryState(getOpts.queryKey)?.isInvalidated).toBe(false)

    await runMutation(qc, deleteMutationOptions(qc, client, 'albums', '1'), undefined)

    // The list subtree is invalidated; the resource's own reads are removed, rather than
    // refetched into a 404 (D8).
    expect(qc.getQueryState(listOpts.queryKey)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(getOpts.queryKey)).toBeUndefined()
    // Sanity: the resource-prefix matches the get key.
    expect(resourceKey('albums', '1')).toEqual(['albums', 'fetchOne', '1'])
  })
})

describe('updateMutationOptions — optimistic apply + rollback', () => {
  it('applies the patch immediately, then rolls back on a transport error', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'Original', year: 2000 })] },
      'PATCH /albums/1': 'error', // the write rejects (422)
    })
    const qc = jsonApiQueryClient()

    const listOpts = listQueryOptions(client, 'albums')
    await qc.fetchQuery(listOpts)

    const options = updateMutationOptions(qc, client, descriptor, 'albums', '1', {
      optimistic: true,
    })

    // Run the lifecycle through the cache: its onMutate applies (and snapshots) the patch, the
    // write rejects, and its onError rolls back. The optimistic value lands as soon as the
    // mutation starts, before the rejection.
    const pending = runMutation(qc, options, { title: 'Optimistic' })

    // Right after the mutation starts the optimistic value is in the cache.
    const during = qc.getQueryData(listOpts.queryKey) as Array<Record<string, unknown>>
    expect(during[0]?.['title']).toBe('Optimistic')

    // The write rejects.
    await expect(pending).rejects.toBeDefined()

    // Rolled back to the original after the error (precise per-key restore).
    const after = qc.getQueryData(listOpts.queryKey) as Array<Record<string, unknown>>
    expect(after[0]?.['title']).toBe('Original')
    expect(after[0]?.['year']).toBe(2000)
  })

  it('sets no lifecycle callbacks: its upkeep is a plain-data plan in meta', () => {
    const { client } = makeClient({})
    const qc = jsonApiQueryClient()
    const opts = updateMutationOptions(qc, client, descriptor, 'albums', '1')
    expect(new Set(Object.keys(opts))).toEqual(new Set(['meta', 'mutationFn', 'mutationKey']))
    expect(opts.meta).toEqual({
      jsonApi: { verb: 'update', type: 'albums', id: '1' },
    })
    // The plan survives JSON, as a dehydrated mutation's meta must.
    expect(JSON.parse(JSON.stringify(opts.meta))).toEqual(opts.meta)
    expect(
      updateMutationOptions(qc, client, descriptor, 'albums', '1', { optimistic: true }).meta,
    ).toEqual({ jsonApi: { verb: 'update', type: 'albums', id: '1', optimistic: true } })
  })

  it('optimistic patch links a relation in the patch only where its member fits (an uncached artist is deferred)', async () => {
    const { client } = makeClient({
      'GET /albums/1': {
        data: {
          ...resource('albums', '1', { title: 'Keep' }),
          relationships: { artist: { data: { type: 'artists', id: '9' } } },
        },
        included: [resource('artists', '9', { name: 'Nina' })],
      },
      'PATCH /albums/1': 'error',
    })
    const qc = jsonApiQueryClient()
    const getOpts = getQueryOptions(client, 'albums', '1', { include: ['artist'] })
    const album = (await qc.fetchQuery(getOpts)) as Record<string, unknown> & {
      artist?: Record<string, unknown>
    }
    const artistBefore = album.artist

    const options = updateMutationOptions(qc, client, descriptor, 'albums', '1', {
      optimistic: true,
    })
    // The patch carries a relation (`artist`) alongside an attribute. Artist X isn't cached, so it
    // can't fill the included slot: the slot keeps its member and X is deferred.
    const pending = runMutation(qc, options, {
      title: 'Optimistic',
      artist: { type: 'artists', id: 'X' },
    } as never)

    expect(album['title']).toBe('Optimistic')
    expect(album.artist).toBe(artistBefore)
    expect(album.artist?.['name']).toBe('Nina')
    expect((album as unknown as { $pending(rel: string): unknown }).$pending('artist')).toEqual([
      { type: 'artists', id: 'X' },
    ])

    // The write rejects, and the rollback restores the attribute.
    await expect(pending).rejects.toBeDefined()
    expect(album['title']).toBe('Keep')
  })
})

describe('relationship mutations — patch-vs-invalidate', () => {
  it('set (to-one) invalidates the parent subtree on settle', async () => {
    const { client } = makeClient({
      'GET /albums/1/relationships/artist': { data: { type: 'artists', id: '9' } },
      'PATCH /albums/1/relationships/artist': { data: { type: 'artists', id: '5' } },
    })
    const qc = jsonApiQueryClient()
    const relOpts = relationshipQueryOptions(client, 'albums', '1', 'artist')
    await qc.fetchQuery(relOpts)

    await runMutation(
      qc,
      setRelationshipMutationOptions(qc, client, descriptor, 'albums', '1', 'artist'),
      { type: 'artists', id: '5' },
    )

    expect(qc.getQueryState(relOpts.queryKey)?.isInvalidated).toBe(true)
  })

  it('replace (to-many) invalidates the parent subtree on settle', async () => {
    const { client } = makeClient({
      'GET /albums/1/relationships/tracks': { data: [{ type: 'tracks', id: 't1' }] },
      'PATCH /albums/1/relationships/tracks': { data: [{ type: 'tracks', id: 't2' }] },
    })
    const qc = jsonApiQueryClient()
    const relOpts = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    await qc.fetchQuery(relOpts)

    await runMutation(
      qc,
      replaceRelationshipMutationOptions(qc, client, descriptor, 'albums', '1', 'tracks'),
      [{ type: 'tracks', id: 't2' }],
    )

    expect(qc.getQueryState(relOpts.queryKey)?.isInvalidated).toBe(true)
  })

  it('add + remove (to-many) invalidate the parent subtree on settle', async () => {
    const { client } = makeClient({
      'GET /albums/1/relationships/tracks': { data: [{ type: 'tracks', id: 't1' }] },
      'POST /albums/1/relationships/tracks': { data: [{ type: 'tracks', id: 't1' }] },
      'DELETE /albums/1/relationships/tracks': { data: [] },
    })
    const qc = jsonApiQueryClient()

    const relOpts = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    await qc.fetchQuery(relOpts)
    await runMutation(qc, addRelationshipMutationOptions(qc, client, 'albums', '1', 'tracks'), [
      { type: 'tracks', id: 't2' },
    ])
    expect(qc.getQueryState(relOpts.queryKey)?.isInvalidated).toBe(true)

    // Re-fetch to clear the invalidated flag, then remove.
    await qc.fetchQuery({ ...relOpts, queryKey: relOpts.queryKey })
    await qc.invalidateQueries({ queryKey: relOpts.queryKey, refetchType: 'none' })
    await qc.fetchQuery(relOpts)
    await runMutation(qc, removeRelationshipMutationOptions(qc, client, 'albums', '1', 'tracks'), [
      { type: 'tracks', id: 't1' },
    ])
    expect(qc.getQueryState(relOpts.queryKey)?.isInvalidated).toBe(true)
  })
})

describe('relationship mutations — TARGETED invalidation (regression: not the whole type subtree)', () => {
  it('set does NOT invalidate the type collection lists, only the parent + relation reads', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'A' })] },
      'GET /albums/1': { data: resource('albums', '1', { title: 'A' }) },
      'GET /albums/1/relationships/artist': { data: { type: 'artists', id: '9' } },
      'GET /albums/1/artist': { data: resource('artists', '9', { name: 'Nina' }) },
      'PATCH /albums/1/relationships/artist': { data: { type: 'artists', id: '5' } },
    })
    const qc = jsonApiQueryClient()

    const listOpts = listQueryOptions(client, 'albums')
    const getOpts = getQueryOptions(client, 'albums', '1')
    const relOpts = relationshipQueryOptions(client, 'albums', '1', 'artist')
    const relatedOpts = relatedQueryOptions(client, 'albums', '1', 'artist')
    await qc.fetchQuery(listOpts)
    await qc.fetchQuery(getOpts)
    await qc.fetchQuery(relOpts)
    await qc.fetchQuery(relatedOpts)

    await runMutation(
      qc,
      setRelationshipMutationOptions(qc, client, descriptor, 'albums', '1', 'artist'),
      { type: 'artists', id: '5' },
    )

    // The type's collection list is UNTOUCHED — a linkage change never alters collection membership.
    expect(qc.getQueryState(listOpts.queryKey)?.isInvalidated).toBe(false)
    // The parent resource read (its ?include of artist is now stale) + the relation reads ARE invalidated.
    expect(qc.getQueryState(getOpts.queryKey)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(relOpts.queryKey)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(relatedOpts.queryKey)?.isInvalidated).toBe(true)
  })

  it('a relationship set on one parent does not invalidate a DIFFERENT parent of the same type', async () => {
    const { client } = makeClient({
      'GET /albums/1': { data: resource('albums', '1') },
      'GET /albums/2': { data: resource('albums', '2') },
      'PATCH /albums/1/relationships/artist': { data: { type: 'artists', id: '5' } },
    })
    const qc = jsonApiQueryClient()
    const get1 = getQueryOptions(client, 'albums', '1')
    const get2 = getQueryOptions(client, 'albums', '2')
    await qc.fetchQuery(get1)
    await qc.fetchQuery(get2)

    await runMutation(
      qc,
      setRelationshipMutationOptions(qc, client, descriptor, 'albums', '1', 'artist'),
      { type: 'artists', id: '5' },
    )

    expect(qc.getQueryState(get1.queryKey)?.isInvalidated).toBe(true)
    // The sibling album:2 is a different id — its reads stay valid.
    expect(qc.getQueryState(get2.queryKey)?.isInvalidated).toBe(false)
  })
})

// A related-read key for a specific page (the page-param coupling apps used to hand-roll).
const trackPage = (c: ReturnType<typeof makeClient>['client'], size: number) =>
  relatedQueryOptions(c, 'albums', '1', 'tracks', { page: { size } })

describe('relationship mutations — optimistic membership (D35b)', () => {
  it('add: appends the ref to EVERY cached page variant of the relation, rolls back on error', async () => {
    const { client: c } = makeClient({
      'GET /albums/1/tracks': { data: [resource('tracks', 't1', { title: 'One' })] },
      'GET /tracks/t2': { data: resource('tracks', 't2', { title: 'Two' }) },
      'POST /albums/1/relationships/tracks': 'error', // the write rejects -> rollback
    })
    const qc = jsonApiQueryClient()

    // Two cached pages of the SAME relation (different page params -> different keys).
    const page50 = relatedQueryOptions(c, 'albums', '1', 'tracks', { page: { size: 50 } })
    const page10 = relatedQueryOptions(c, 'albums', '1', 'tracks', { page: { size: 10 } })
    await qc.fetchQuery(page50)
    await qc.fetchQuery(page10)
    // The added track is cached, so it fills the related reads' resource slots.
    await qc.fetchQuery(getQueryOptions(c, 'tracks', 't2'))

    const options = addRelationshipMutationOptions(qc, c, 'albums', '1', 'tracks', {
      optimistic: true,
    })
    const pending = runMutation(qc, options, [{ type: 'tracks', id: 't2' }])

    // Both page variants gained the added member immediately (patched by key PREFIX).
    for (const opts of [page50, page10]) {
      const cached = qc.getQueryData(opts.queryKey) as Array<Record<string, unknown>>
      expect(cached.map((m) => m['id'])).toEqual(['t1', 't2'])
    }

    // The write rejects, then the cache's onError rolls both pages back.
    await expect(pending).rejects.toBeDefined()

    for (const opts of [page50, page10]) {
      const cached = qc.getQueryData(opts.queryKey) as Array<Record<string, unknown>>
      expect(cached.map((m) => m['id'])).toEqual(['t1'])
    }
  })

  it('add: is idempotent on membership (an already-present ref is not duplicated)', async () => {
    const { client: c } = makeClient({
      'GET /albums/1/tracks': { data: [resource('tracks', 't1')] },
      'POST /albums/1/relationships/tracks': { data: [resource('tracks', 't1')] },
    })
    const qc = jsonApiQueryClient()
    const page = trackPage(c, 50)
    await qc.fetchQuery(page)

    const options = addRelationshipMutationOptions(qc, c, 'albums', '1', 'tracks', {
      optimistic: true,
    })
    const pending = runMutation(qc, options, [{ type: 'tracks', id: 't1' }])
    const cached = qc.getQueryData(page.queryKey) as Array<Record<string, unknown>>
    expect(cached.map((m) => m['id'])).toEqual(['t1'])
    await pending
  })

  it('remove: drops the ref from the cached membership', async () => {
    const { client: c } = makeClient({
      'GET /albums/1/tracks': { data: [resource('tracks', 't1'), resource('tracks', 't2')] },
      'DELETE /albums/1/relationships/tracks': { data: [resource('tracks', 't1')] },
    })
    const qc = jsonApiQueryClient()
    const page = trackPage(c, 50)
    await qc.fetchQuery(page)

    const options = removeRelationshipMutationOptions(qc, c, 'albums', '1', 'tracks', {
      optimistic: true,
    })
    const pending = runMutation(qc, options, [{ type: 'tracks', id: 't2' }])
    const cached = qc.getQueryData(page.queryKey) as Array<Record<string, unknown>>
    expect(cached.map((m) => m['id'])).toEqual(['t1'])
    await pending
  })

  it('replace: swaps the whole cached membership to the new refs (order preserved)', async () => {
    const { client: c } = makeClient({
      'GET /albums/1/tracks': { data: [resource('tracks', 't1'), resource('tracks', 't2')] },
      'GET /tracks/t3': { data: resource('tracks', 't3', { title: 'Three' }) },
      'PATCH /albums/1/relationships/tracks': { data: [resource('tracks', 't3')] },
    })
    const qc = jsonApiQueryClient()
    const page = trackPage(c, 50)
    await qc.fetchQuery(page)
    // The new member is cached, so it fills the related read's resource slot.
    await qc.fetchQuery(getQueryOptions(c, 'tracks', 't3'))

    const options = replaceRelationshipMutationOptions(qc, c, descriptor, 'albums', '1', 'tracks', {
      optimistic: true,
    })
    const pending = runMutation(qc, options, [
      { type: 'tracks', id: 't3' },
      { type: 'tracks', id: 't1' },
    ])
    const cached = qc.getQueryData(page.queryKey) as Array<Record<string, unknown>>
    expect(cached.map((m) => m['id'])).toEqual(['t3', 't1'])
    await pending
  })

  it('set (to-one): swaps the cached linkage value and rolls back on error', async () => {
    const { client: c } = makeClient({
      'GET /albums/1/relationships/artist': { data: { type: 'artists', id: '9' } },
      'PATCH /albums/1/relationships/artist': 'error',
    })
    const qc = jsonApiQueryClient()
    const rel = relationshipQueryOptions(c, 'albums', '1', 'artist')
    await qc.fetchQuery(rel)

    const options = setRelationshipMutationOptions(qc, c, descriptor, 'albums', '1', 'artist', {
      optimistic: true,
    })
    const pending = runMutation(qc, options, { type: 'artists', id: '5' })
    expect((qc.getQueryData(rel.queryKey) as Record<string, unknown>)['id']).toBe('5')

    await expect(pending).rejects.toBeDefined()
    // Rolled back to the original linkage.
    expect((qc.getQueryData(rel.queryKey) as Record<string, unknown>)['id']).toBe('9')
  })

  it('a relationship mutation sets no lifecycle callbacks: its plan names the relation', () => {
    const { client: c } = makeClient({})
    const qc = jsonApiQueryClient()
    const opts = addRelationshipMutationOptions(qc, c, 'albums', '1', 'tracks')
    expect(new Set(Object.keys(opts))).toEqual(new Set(['meta', 'mutationFn', 'mutationKey']))
    expect(opts.meta).toEqual({
      jsonApi: { verb: 'add', type: 'albums', id: '1', rel: 'tracks' },
    })
  })

  it('still invalidates the relation subtree on settle even when optimistic', async () => {
    const { client: c } = makeClient({
      'GET /albums/1/tracks': { data: [resource('tracks', 't1')] },
      'POST /albums/1/relationships/tracks': { data: [resource('tracks', 't1')] },
    })
    const qc = jsonApiQueryClient()
    const page = trackPage(c, 50)
    await qc.fetchQuery(page)

    await runMutation(
      qc,
      addRelationshipMutationOptions(qc, c, 'albums', '1', 'tracks', { optimistic: true }),
      [{ type: 'tracks', id: 't2' }],
    )
    // The settle invalidation runs regardless of the optimistic patch.
    expect(qc.getQueryState(page.queryKey)?.isInvalidated).toBe(true)
  })
})

describe('createMutationApi (bound)', () => {
  it('produces options equivalent to the standalone factories', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'A' })] },
      'PATCH /albums/1': { data: resource('albums', '1', { title: 'B' }) },
    })
    const qc = jsonApiQueryClient()
    const api = createMutationApi(qc, client, descriptor)

    const listOpts = listQueryOptions(client, 'albums')
    await qc.fetchQuery(listOpts)

    // The bound update is the same patch-on-success factory as the standalone.
    await runMutation(qc, api.albums.id('1').update(), { title: 'B' })
    const cached = qc.getQueryData(listOpts.queryKey) as Array<Record<string, unknown>>
    expect(cached[0]?.['title']).toBe('B')

    // The bound surface exposes create / delete / rel.* per type.
    expect(typeof api.albums.create().mutationFn).toBe('function')
    expect(typeof api.albums.id('1').delete().mutationFn).toBe('function')
    expect(typeof api.albums.id('1').rel('tracks').add().mutationFn).toBe('function')
    expect(typeof api.albums.id('1').rel('artist').set().mutationFn).toBe('function')
  })
})

describe('a structured list attribute', () => {
  type Step = { op: 'trim' } | { op: 'replace'; find: string; with?: string }
  const editors = {
    edits: {
      attributes: { name: 'string', steps: 'array' },
      relations: {},
      paths: { fetchOne: '/edits/{id}', create: '/edits', update: '/edits/{id}' },
      paginator: 'none',
      clientId: 'forbidden',
    },
  } as const satisfies ApiDescriptor
  interface Attributes {
    edits: { name: string; steps: Step[] | null }
  }
  interface WriteAttributes {
    edits: { create: { name: string; steps?: Step[] }; update: { name?: string; steps?: Step[] } }
  }

  function editsClient(routes: Record<string, unknown>) {
    const requests: TransportRequest[] = []
    const client = createClient<typeof editors, Attributes, WriteAttributes>(editors, {
      baseUrl: BASE,
      transport: async (req) => {
        requests.push(req)
        const route = routes[`${req.method} ${new URL(req.url).pathname}`]
        return { status: 200, headers: {}, body: JSON.stringify(route) }
      },
    })
    return { client, requests }
  }

  it('creates and optimistically replaces the whole list, typed from the write interface', async () => {
    const stored = { name: 'Tidy', steps: [{ op: 'trim' }, { op: 'replace', find: 'a' }] }
    const { client, requests } = editsClient({
      'POST /edits': { data: resource('edits', '1', stored) },
      'GET /edits/1': { data: resource('edits', '1', stored) },
      'PATCH /edits/1': { data: resource('edits', '1', { ...stored, steps: [{ op: 'trim' }] }) },
    })
    const qc = jsonApiQueryClient(editors)

    const created = await runMutation(qc, createMutationOptions(qc, client, editors, 'edits'), {
      name: 'Tidy',
      steps: [{ op: 'trim' }, { op: 'replace', find: 'a' }],
    })
    expectTypeOf(created.steps).toEqualTypeOf<Step[] | null>()

    const getOpts = getQueryOptions(client, 'edits', '1')
    await qc.fetchQuery(getOpts)
    const update = updateMutationOptions(qc, client, editors, 'edits', '1', { optimistic: true })
    const pending = runMutation(qc, update, { steps: [{ op: 'trim' }] })
    expect(qc.getQueryData(getOpts.queryKey)).toMatchObject({ steps: [{ op: 'trim' }] })
    await pending

    expect(JSON.parse(String(requests[0]!.body))).toMatchObject({
      data: { attributes: { steps: [{ op: 'trim' }, { op: 'replace', find: 'a' }] } },
    })
    // @ts-expect-error — `upper` is not a step.
    void (() => runMutation(qc, update, { steps: [{ op: 'upper' }] }))
  })
})

describe('spread-safe callbacks', () => {
  it('an app onSuccess/onSettled spread alongside a create keeps its normalization and invalidation', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'A' })] },
      'GET /albums/2': { data: resource('albums', '2', { title: 'Stale' }) },
      'POST /albums': { data: resource('albums', '2', { title: 'New' }) },
    })
    const qc = jsonApiQueryClient()
    const listOpts = listQueryOptions(client, 'albums')
    const getOpts = getQueryOptions(client, 'albums', '2')
    await qc.fetchQuery(listOpts)
    await qc.fetchQuery(getOpts)

    const seen: string[] = []
    await runMutation(
      qc,
      {
        ...createMutationOptions(qc, client, descriptor, 'albums'),
        // Each runs after the cache's upkeep of the same name, against the reconciled cache.
        onSuccess: () => {
          const fresh = qc.getQueryData(getOpts.queryKey) as Record<string, unknown>
          seen.push(`success:${String(fresh['title'])}`)
        },
        onSettled: () => {
          seen.push(`settled:${String(qc.getQueryState(listOpts.queryKey)?.isInvalidated)}`)
        },
      },
      { title: 'New' },
    )

    expect(seen).toEqual(['success:New', 'settled:true'])
  })

  it('an app onMutate/onError/onSettled spread alongside an optimistic update keeps the rollback', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'Original', year: 2000 })] },
      'PATCH /albums/1': 'error',
    })
    const qc = jsonApiQueryClient()
    const listOpts = listQueryOptions(client, 'albums')
    await qc.fetchQuery(listOpts)
    const title = () =>
      String((qc.getQueryData(listOpts.queryKey) as Array<Record<string, unknown>>)[0]?.['title'])

    const seen: string[] = []
    const pending = runMutation(
      qc,
      {
        ...updateMutationOptions(qc, client, descriptor, 'albums', '1', { optimistic: true }),
        onMutate: () => {
          seen.push(`mutate:${title()}`)
          return 'mine'
        },
        onError: () => {
          seen.push(`error:${title()}`)
        },
        onSettled: () => {
          seen.push(`settled:${title()}`)
        },
      },
      { title: 'Optimistic' },
    )
    await expect(pending).rejects.toBeDefined()

    // The app's onMutate saw the optimistic value; its onError and onSettled the rolled-back one.
    expect(seen).toEqual(['mutate:Optimistic', 'error:Original', 'settled:Original'])
    expect(title()).toBe('Original')
    // The app's own onMutate result is the mutation's context, untouched by the upkeep.
    expect(qc.getMutationCache().getAll().at(-1)?.state.context).toBe('mine')
  })

  it('an app onSettled spread alongside a relationship add keeps its invalidation', async () => {
    const { client: c } = makeClient({
      'GET /albums/1/tracks': { data: [resource('tracks', 't1')] },
      'POST /albums/1/relationships/tracks': { data: [resource('tracks', 't1')] },
    })
    const qc = jsonApiQueryClient()
    const page = trackPage(c, 50)
    await qc.fetchQuery(page)
    const mine = vi.fn()

    await runMutation(
      qc,
      { ...addRelationshipMutationOptions(qc, c, 'albums', '1', 'tracks'), onSettled: mine },
      [{ type: 'tracks', id: 't2' }],
    )
    expect(qc.getQueryState(page.queryKey)?.isInvalidated).toBe(true)
    expect(mine).toHaveBeenCalledOnce()
  })

  it('stays pending until the invalidation it started has refetched', async () => {
    const { held, release } = gate()
    let reads = 0
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport: async (req) => {
        if (req.method === 'GET') {
          reads += 1
          // The refetch the invalidation starts waits until the test releases it.
          if (reads > 1) {
            await held
          }
          return { status: 200, headers: {}, body: JSON.stringify({ data: [] }) }
        }
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ data: resource('albums', '2', { title: 'New' }) }),
        }
      },
    })
    const qc = jsonApiQueryClient()
    // An observed (active) list, so the invalidation refetches it.
    const observer = new QueryObserver(qc, listQueryOptions(client, 'albums'))
    const unsubscribe = observer.subscribe(() => {})
    await vi.waitFor(() => expect(observer.getCurrentResult().status).toBe('success'))

    const pending = runMutation(qc, createMutationOptions(qc, client, descriptor, 'albums'), {
      title: 'New',
    })
    await vi.waitFor(() => expect(reads).toBe(2))
    expect(qc.getMutationCache().getAll().at(-1)?.state.status).toBe('pending')

    release()
    await pending
    expect(qc.getMutationCache().getAll().at(-1)?.state.status).toBe('success')
    unsubscribe()
  })

  it('chains the config it is constructed with, after the upkeep, for every mutation', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'A' })] },
      'POST /albums': { data: resource('albums', '2', { title: 'New' }) },
    })
    const seen: string[] = []
    const qc: QueryClient = new QueryClient({
      mutationCache: new JsonApiMutationCache({
        onMutate: () => {
          seen.push('mutate')
        },
        onSuccess: () => {
          seen.push('success')
        },
        onError: () => {
          seen.push('error')
        },
        onSettled: () => {
          seen.push(`settled:${String(qc.getQueryState(listOpts.queryKey)?.isInvalidated)}`)
        },
      }),
      defaultOptions: { queries: { staleTime: Infinity } },
    })
    installNormalization(qc, descriptor)
    const listOpts = listQueryOptions(client, 'albums')
    await qc.fetchQuery(listOpts)

    await runMutation(qc, createMutationOptions(qc, client, descriptor, 'albums'), { title: 'New' })
    // A mutation of the app's own runs the chained hooks too.
    await runMutation(qc, { mutationFn: async () => 'x' } as never, undefined)
    await expect(
      runMutation(qc, { mutationFn: () => Promise.reject(new Error('no')) } as never, undefined),
    ).rejects.toThrow('no')

    expect(seen).toEqual([
      'mutate',
      'success',
      'settled:true',
      'mutate',
      'success',
      'settled:true',
      'mutate',
      'error',
      'settled:true',
    ])
  })
})

describe('loud failure where the upkeep cannot run', () => {
  it('throws on a QueryClient whose mutation cache is not a JsonApiMutationCache, before writing', async () => {
    const { client, requests } = makeClient({ 'POST /albums': { data: resource('albums', '2') } })
    const qc = new QueryClient()
    installNormalization(qc, descriptor)

    await expect(
      runMutation(qc, createMutationOptions(qc, client, descriptor, 'albums'), { title: 'New' }),
    ).rejects.toThrow('new QueryClient({ mutationCache: new JsonApiMutationCache() })')
    expect(requests).toHaveLength(0)
  })

  it('throws when no descriptor is installed, before writing', async () => {
    const { client, requests } = makeClient({ 'POST /albums': { data: resource('albums', '2') } })
    const qc = new QueryClient({ mutationCache: new JsonApiMutationCache() })

    await expect(
      runMutation(qc, createMutationOptions(qc, client, descriptor, 'albums'), { title: 'New' }),
    ).rejects.toThrow('installNormalization(queryClient, descriptor)')
    expect(requests).toHaveLength(0)
  })

  it('throws when an app meta replaces the plan rather than merging with it', async () => {
    const { client, requests } = makeClient({ 'POST /albums': { data: resource('albums', '2') } })
    const qc = jsonApiQueryClient()
    const options = createMutationOptions(qc, client, descriptor, 'albums')

    await expect(
      runMutation(qc, { ...options, meta: { mine: true } } as never, { title: 'New' }),
    ).rejects.toThrow('no "jsonApi" plan')
    expect(requests).toHaveLength(0)

    // Merged, the plan survives and the write runs.
    await runMutation(qc, { ...options, meta: { ...options.meta, mine: true } }, { title: 'New' })
    expect(requests).toHaveLength(1)
  })
})

/** A promise the test resolves when it chooses, to hold a request in flight. */
function gate(): { held: Promise<void>; release: () => void } {
  let resolveHeld: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    resolveHeld = resolve
  })
  return { held, release: () => resolveHeld?.() }
}

/** The key of an update of albums, or of one album's. */
const albumUpdate = (id?: string) => mutationKeyFor({ type: 'albums', verb: 'update', id })

describe('mutation keys', () => {
  it('keys each factory [type, verb, id?, rel?]', () => {
    const { client } = makeClient({})
    const qc = jsonApiQueryClient()
    const api = createMutationApi(qc, client, descriptor)
    const album = api.albums.id('1')
    expect(api.albums.create().mutationKey).toEqual(['albums', 'create'])
    expect(album.update().mutationKey).toEqual(['albums', 'update', '1'])
    expect(album.delete().mutationKey).toEqual(['albums', 'delete', '1'])
    expect(album.rel('tracks').add().mutationKey).toEqual(['albums', 'add', '1', 'tracks'])
    expect(album.rel('tracks').remove().mutationKey).toEqual(['albums', 'remove', '1', 'tracks'])
    expect(album.rel('tracks').replace().mutationKey).toEqual(['albums', 'replace', '1', 'tracks'])
    expect(album.rel('artist').set().mutationKey).toEqual(['albums', 'set', '1', 'artist'])
    expect(atomicMutationOptions(qc, client, descriptor).mutationKey).toEqual(['$atomic'])
    expect(ATOMIC_MUTATION_KEY).toEqual(['$atomic'])
    expect(mutationKeyFor({ type: 'albums', verb: 'set', id: '1', rel: 'artist' })).toEqual(
      album.rel('artist').set().mutationKey,
    )
    // A singleton's key leaves the id out, as its read keys do.
    expect(mutationKeyFor({ type: 'inboxes', verb: 'set', rel: 'owner' })).toEqual([
      'inboxes',
      'set',
      'owner',
    ])
  })

  it('finds a pending mutation by key prefix', async () => {
    const { held, release } = gate()
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport: async () => {
        await held
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ data: resource('albums', '1', { title: 'B' }) }),
        }
      },
    })
    const qc = jsonApiQueryClient()
    const pending = runMutation(qc, updateMutationOptions(qc, client, descriptor, 'albums', '1'), {
      title: 'B',
    })

    expect(qc.isMutating({ mutationKey: ['albums'] })).toBe(1)
    expect(qc.isMutating({ mutationKey: albumUpdate() })).toBe(1)
    expect(qc.isMutating({ mutationKey: albumUpdate('1') })).toBe(1)
    expect(qc.isMutating({ mutationKey: albumUpdate('2') })).toBe(0)
    expect(qc.isMutating({ mutationKey: mutationKeyFor({ type: 'albums', verb: 'create' }) })).toBe(
      0,
    )
    expect(
      qc.getMutationCache().findAll({ mutationKey: ['albums', 'update'], status: 'pending' }),
    ).toHaveLength(1)

    release()
    await pending
    expect(qc.isMutating({ mutationKey: ['albums'] })).toBe(0)
  })
})

describe('atomicMutationOptions', () => {
  it('normalizes the batch results and invalidates nothing', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'Old' })] },
      'GET /albums/1': { data: resource('albums', '1', { title: 'Batched' }) },
    })
    // The materialised resource the batch resolves to, read through the client.
    const batched = await new QueryClient().fetchQuery(getQueryOptions(client, 'albums', '1'))
    const atomicClient = { ...client, atomic: async () => [batched] } as unknown as typeof client
    const qc = jsonApiQueryClient()
    const listOpts = listQueryOptions(client, 'albums')
    await qc.fetchQuery(listOpts)

    const options = atomicMutationOptions(qc, atomicClient, descriptor)
    expect(options.meta).toEqual({ jsonApi: { verb: 'atomic' } })
    await runMutation(qc, options, (() => []) as never)

    const cached = qc.getQueryData(listOpts.queryKey) as Array<Record<string, unknown>>
    expect(cached[0]?.['title']).toBe('Batched')
    expect(qc.getQueryState(listOpts.queryKey)?.isInvalidated).toBe(false)
  })
})

describe('MutationOptions', () => {
  it("is assignable to query-core's MutationOptions, with the app's callbacks spread in", () => {
    const { client } = makeClient({})
    const qc = jsonApiQueryClient()
    const update = updateMutationOptions(qc, client, descriptor, 'albums', '1')
    type Update = typeof update
    type Data = Awaited<ReturnType<Update['mutationFn']>>
    type Vars = Parameters<Update['mutationFn']>[0]
    expectTypeOf(update).toExtend<CoreMutationOptions<Data, Error, Vars>>()
    const spread = { ...update, onSettled: () => {}, retry: 1 }
    expectTypeOf(spread).toExtend<CoreMutationOptions<Data, Error, Vars>>()
  })
})
