import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { QueryClient } from '@tanstack/query-core'
import { describe, expect, it } from 'vitest'
import { resourceKey } from './keys'
import {
  addRelationshipMutationOptions,
  createMutationApi,
  createMutationOptions,
  deleteMutationOptions,
  type MutationOptions,
  removeRelationshipMutationOptions,
  replaceRelationshipMutationOptions,
  setRelationshipMutationOptions,
  updateMutationOptions,
} from './mutate'
import {
  getQueryOptions,
  listQueryOptions,
  relatedQueryOptions,
  relationshipQueryOptions,
} from './read'

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

/** Drive a mutation-options object through query-core's mutation cache (no framework adapter). */
function runMutation<TData, TVars, TContext>(
  qc: QueryClient,
  options: MutationOptions<TData, TVars, TContext>,
  variables: TVars,
): Promise<TData> {
  return qc
    .getMutationCache()
    .build<TData, unknown, TVars, TContext>(qc, options as never)
    .execute(variables)
}

describe('updateMutationOptions — patch, no invalidate', () => {
  it('patches a cached list + get silently on success (no refetch)', async () => {
    const { client, requests } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'Old', year: 1997 })] },
      'GET /albums/1': { data: resource('albums', '1', { title: 'Old', year: 1997 }) },
      'PATCH /albums/1': { data: resource('albums', '1', { title: 'Fresh', year: 2024 }) },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

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
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

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

describe('deleteMutationOptions — invalidate list + resource', () => {
  it('invalidates the list subtree and the resource reads on settle', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1')] },
      'GET /albums/1': { data: resource('albums', '1') },
      'DELETE /albums/1': { data: null },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

    const listOpts = listQueryOptions(client, 'albums')
    const getOpts = getQueryOptions(client, 'albums', '1')
    await qc.fetchQuery(listOpts)
    await qc.fetchQuery(getOpts)
    expect(qc.getQueryState(getOpts.queryKey)?.isInvalidated).toBe(false)

    await runMutation(qc, deleteMutationOptions(qc, client, 'albums', '1'), undefined)

    // List subtree + the resource's reads are invalidated.
    expect(qc.getQueryState(listOpts.queryKey)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(getOpts.queryKey)?.isInvalidated).toBe(true)
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
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

    const listOpts = listQueryOptions(client, 'albums')
    await qc.fetchQuery(listOpts)

    const options = updateMutationOptions(qc, client, descriptor, 'albums', '1', {
      optimistic: true,
    })

    // Drive the lifecycle exactly as query-core would: onMutate (apply + snapshot) -> mutationFn
    // (rejects) -> onError (rollback). We assert the optimistic value landed between onMutate and
    // the rejection, then was rolled back after onError.
    const vars = { title: 'Optimistic' }
    const context = await options.onMutate?.(vars)

    // Right after onMutate the optimistic value is in the cache.
    const during = qc.getQueryData(listOpts.queryKey) as Array<Record<string, unknown>>
    expect(during[0]?.['title']).toBe('Optimistic')

    // The write rejects.
    let error: unknown
    try {
      await options.mutationFn(vars)
    } catch (e) {
      error = e
    }
    expect(error).toBeDefined()

    options.onError?.(error, vars, context)

    // Rolled back to the original after the error (precise per-key restore).
    const after = qc.getQueryData(listOpts.queryKey) as Array<Record<string, unknown>>
    expect(after[0]?.['title']).toBe('Original')
    expect(after[0]?.['year']).toBe(2000)
  })

  it('non-optimistic update exposes no onMutate/onError (a plain patch-on-success)', () => {
    const { client } = makeClient({})
    const qc = new QueryClient()
    const opts = updateMutationOptions(qc, client, descriptor, 'albums', '1')
    expect(opts.onMutate).toBeUndefined()
    expect(opts.onError).toBeUndefined()
    expect(typeof opts.onSuccess).toBe('function')
  })

  it('optimistic patch touches only declared attributes (a relation key in the patch is ignored)', async () => {
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
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const getOpts = getQueryOptions(client, 'albums', '1', { include: ['artist'] })
    const album = (await qc.fetchQuery(getOpts)) as Record<string, unknown> & {
      artist?: Record<string, unknown>
    }
    const artistBefore = album.artist

    const options = updateMutationOptions(qc, client, descriptor, 'albums', '1', {
      optimistic: true,
    })
    // Patch carries a relation slot (`artist`) alongside an attribute — only `title` is optimistic.
    const snapshot = await (
      options.onMutate as (v: unknown) => Promise<{ snapshot: { restore(): void } }>
    )({ title: 'Optimistic', artist: { type: 'artists', id: 'X' } })

    expect(album['title']).toBe('Optimistic')
    // The relation slot is untouched (same object) — optimism is attributes-only.
    expect(album.artist).toBe(artistBefore)
    expect(album.artist?.['name']).toBe('Nina')

    snapshot.snapshot.restore()
    expect(album['title']).toBe('Keep')
  })
})

describe('relationship mutations — patch-vs-invalidate', () => {
  it('set (to-one) invalidates the parent subtree on settle', async () => {
    const { client } = makeClient({
      'GET /albums/1/relationships/artist': { data: { type: 'artists', id: '9' } },
      'PATCH /albums/1/relationships/artist': { data: { type: 'artists', id: '5' } },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
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
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
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
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

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
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

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
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
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

describe('createMutationApi (bound)', () => {
  it('produces options equivalent to the standalone factories', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'A' })] },
      'PATCH /albums/1': { data: resource('albums', '1', { title: 'B' }) },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
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
