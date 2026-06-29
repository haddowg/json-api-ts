import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { QueryClient } from '@tanstack/query-core'
import { afterEach, describe, expect, it } from 'vitest'
import { installNormalization } from './install'
import { getQueryOptions, listQueryOptions } from './read'
import { applyOptimisticPatch, normalize } from './normalize'
import { createMutationOptions } from './mutate'

const BASE = 'https://music.example'

// A descriptor mirroring the music-catalog shape: albums (with an artist to-one + a tracks
// to-many), artists, tracks, and a playlists type whose `orderedTracks` carries pivot data.
const descriptor = {
  albums: {
    attributes: { title: 'string', year: 'number' },
    relations: {
      artist: { cardinality: 'one', types: ['artists'], pivot: false },
      tracks: { cardinality: 'many', types: ['tracks'], pivot: false },
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
  },
  artists: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchMany: '/artists', fetchOne: '/artists/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
  tracks: {
    attributes: { title: 'string', duration: 'number' },
    relations: {},
    paths: { fetchMany: '/tracks', fetchOne: '/tracks/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
  playlists: {
    attributes: { name: 'string' },
    relations: {
      orderedTracks: { cardinality: 'many', types: ['tracks'], pivot: true },
    },
    paths: {
      fetchOne: '/playlists/{id}',
      fetchRelated: '/playlists/{id}/{rel}',
      fetchRelationship: '/playlists/{id}/relationships/{rel}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['orderedTracks'],
  },
} as const satisfies ApiDescriptor

/** A mock transport replying from a route table keyed by `METHOD path` (query stripped). */
function makeClient(routes: Record<string, unknown>) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    const url = new URL(req.url)
    const body = routes[`${req.method} ${url.pathname}`]
    if (body === undefined) {
      return { status: 404, headers: {}, body: JSON.stringify({ errors: [{ status: '404' }] }) }
    }
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }
  const client = createClient(descriptor, { baseUrl: BASE, transport })
  return { client, requests }
}

const resource = (type: string, id: string, attributes: Record<string, unknown> = {}) => ({
  type,
  id,
  attributes,
})

// Track teardown of installed subscriptions across tests.
const teardowns: (() => void)[] = []
afterEach(() => {
  while (teardowns.length > 0) {
    teardowns.pop()?.()
  }
})

describe('normalize — write-through patching across shared queries', () => {
  it('patches the same albums:1 in two queries (a list and a get) in place', async () => {
    const { client } = makeClient({
      'GET /albums': {
        data: [resource('albums', '1', { title: 'Old', year: 1997 }), resource('albums', '2')],
      },
      'GET /albums/1': { data: resource('albums', '1', { title: 'Fresh', year: 2024 }) },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

    const listOpts = listQueryOptions(client, 'albums')
    const list = await qc.fetchQuery(listOpts)
    expect(list[0]?.title).toBe('Old')

    // A fresh single-resource read of albums:1 carries newer attributes.
    const getOpts = getQueryOptions(client, 'albums', '1')
    const one = await qc.fetchQuery(getOpts)
    expect(one.title).toBe('Fresh')

    // Propagate that read across the cache: the list's albums:1 now reflects the fresh values.
    normalize(qc, one, descriptor)

    const cachedList = qc.getQueryData(listOpts.queryKey) as Array<Record<string, unknown>>
    expect(cachedList[0]?.['title']).toBe('Fresh')
    expect(cachedList[0]?.['year']).toBe(2024)
    // The untouched sibling (albums:2) is left alone.
    expect(cachedList[1]?.['id']).toBe('2')
    expect(cachedList[1]?.['title']).toBeUndefined()
  })

  it('patches in place, preserving the cached objects identity + $-accessors', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'Old' })] },
      'GET /albums/1': { data: resource('albums', '1', { title: 'New' }) },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const listOpts = listQueryOptions(client, 'albums')
    const list = await qc.fetchQuery(listOpts)
    const memberBefore = list[0]

    const one = await qc.fetchQuery(getQueryOptions(client, 'albums', '1'))
    normalize(qc, one, descriptor)

    const listAfter = qc.getQueryData(listOpts.queryKey) as Array<Record<string, unknown>>
    // Same array + same member object — patched in place, not rebuilt.
    expect(listAfter).toBe(list)
    expect(listAfter[0]).toBe(memberBefore)
    expect(listAfter[0]?.['title']).toBe('New')
    // The resource-level $-accessors still resolve (non-enumerable getters survive the patch).
    expect((listAfter[0] as { $raw?: { type?: string } }).$raw?.type).toBe('albums')
  })

  it('does nothing when the result carries no resources (empty / null)', () => {
    const qc = new QueryClient()
    // No throw, no cache writes.
    expect(() => normalize(qc, null, descriptor)).not.toThrow()
    expect(() => normalize(qc, undefined, descriptor)).not.toThrow()
    expect(() => normalize(qc, [], descriptor)).not.toThrow()
    expect(qc.getQueryCache().getAll()).toHaveLength(0)
  })
})

describe('normalize — pivot/edge preservation', () => {
  it('keeps a pivot to-many member $pivot after patching the underlying node', async () => {
    const { client } = makeClient({
      'GET /playlists/1': {
        data: {
          ...resource('playlists', '1', { name: 'Mix' }),
          relationships: {
            orderedTracks: {
              data: [{ type: 'tracks', id: 't1', meta: { pivot: { position: 1 } } }],
            },
          },
        },
        included: [resource('tracks', 't1', { title: 'Original', duration: 200 })],
      },
      // A standalone read of the track carries newer attributes (no pivot — it's not an edge).
      'GET /tracks/t1': { data: resource('tracks', 't1', { title: 'Remastered', duration: 210 }) },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

    const plOpts = getQueryOptions(client, 'playlists', '1', { include: ['orderedTracks'] })
    const playlist = (await qc.fetchQuery(plOpts)) as {
      orderedTracks: Array<Record<string, unknown> & { $pivot?: Record<string, unknown> }>
    }
    const member = playlist.orderedTracks[0]
    expect(member?.['title']).toBe('Original')
    expect(member?.$pivot).toEqual({ position: 1 })

    // Fetch the track standalone and propagate it.
    const freshTrack = await qc.fetchQuery(getQueryOptions(client, 'tracks', 't1'))
    normalize(qc, freshTrack, descriptor)

    // The member's shared attributes updated, but its edge-local pivot is untouched.
    expect(member?.['title']).toBe('Remastered')
    expect(member?.['duration']).toBe(210)
    expect(member?.$pivot).toEqual({ position: 1 })
  })

  it('never merges one edge data onto another — two playlists of the same track keep distinct pivots', async () => {
    const { client } = makeClient({
      'GET /playlists/1': {
        data: {
          ...resource('playlists', '1', { name: 'A' }),
          relationships: {
            orderedTracks: {
              data: [{ type: 'tracks', id: 't1', meta: { pivot: { position: 1 } } }],
            },
          },
        },
        included: [resource('tracks', 't1', { title: 'Song' })],
      },
      'GET /playlists/2': {
        data: {
          ...resource('playlists', '2', { name: 'B' }),
          relationships: {
            orderedTracks: {
              data: [{ type: 'tracks', id: 't1', meta: { pivot: { position: 9 } } }],
            },
          },
        },
        included: [resource('tracks', 't1', { title: 'Song' })],
      },
      'GET /tracks/t1': { data: resource('tracks', 't1', { title: 'Renamed' }) },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

    const p1 = (await qc.fetchQuery(
      getQueryOptions(client, 'playlists', '1', { include: ['orderedTracks'] }),
    )) as { orderedTracks: Array<Record<string, unknown> & { $pivot?: Record<string, unknown> }> }
    const p2 = (await qc.fetchQuery(
      getQueryOptions(client, 'playlists', '2', { include: ['orderedTracks'] }),
    )) as { orderedTracks: Array<Record<string, unknown> & { $pivot?: Record<string, unknown> }> }

    const fresh = await qc.fetchQuery(getQueryOptions(client, 'tracks', 't1'))
    normalize(qc, fresh, descriptor)

    // Both members' shared title updated; each keeps its own edge pivot — no cross-contamination.
    expect(p1.orderedTracks[0]?.['title']).toBe('Renamed')
    expect(p2.orderedTracks[0]?.['title']).toBe('Renamed')
    expect(p1.orderedTracks[0]?.$pivot).toEqual({ position: 1 })
    expect(p2.orderedTracks[0]?.$pivot).toEqual({ position: 9 })
  })
})

describe('normalize — attributes-only (relations are not corrupted)', () => {
  it('patches attributes but leaves a hydrated relation slot intact', async () => {
    const { client } = makeClient({
      'GET /albums/1': {
        data: {
          ...resource('albums', '1', { title: 'Debut', year: 2000 }),
          relationships: { artist: { data: { type: 'artists', id: '9' } } },
        },
        included: [resource('artists', '9', { name: 'Nina' })],
      },
      // A fresh album read with NO relationships block — only attributes change.
      'GET /albums': { data: [resource('albums', '1', { title: 'Debut (Deluxe)', year: 2001 })] },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

    const withRel = (await qc.fetchQuery(
      getQueryOptions(client, 'albums', '1', { include: ['artist'] }),
    )) as Record<string, unknown> & { artist?: Record<string, unknown> }
    const artistBefore = withRel.artist
    expect(artistBefore?.['name']).toBe('Nina')

    const list = await qc.fetchQuery(listQueryOptions(client, 'albums'))
    normalize(qc, list, descriptor)

    // Attributes updated; the artist relation slot is byte-for-byte the same object (untouched).
    expect(withRel['title']).toBe('Debut (Deluxe)')
    expect(withRel['year']).toBe(2001)
    expect(withRel.artist).toBe(artistBefore)
    expect(withRel.artist?.['name']).toBe('Nina')
  })

  it('propagates into a nested included resource (a relation member is itself patched)', async () => {
    const { client } = makeClient({
      'GET /albums/1': {
        data: {
          ...resource('albums', '1', { title: 'A' }),
          relationships: { artist: { data: { type: 'artists', id: '9' } } },
        },
        included: [resource('artists', '9', { name: 'Stale' })],
      },
      'GET /artists/9': { data: resource('artists', '9', { name: 'Fresh' }) },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

    const album = (await qc.fetchQuery(
      getQueryOptions(client, 'albums', '1', { include: ['artist'] }),
    )) as Record<string, unknown> & { artist?: Record<string, unknown> }
    expect(album.artist?.['name']).toBe('Stale')

    const artist = await qc.fetchQuery(getQueryOptions(client, 'artists', '9'))
    normalize(qc, artist, descriptor)

    // The nested artist member inside the album graph is patched with the standalone read.
    expect(album.artist?.['name']).toBe('Fresh')
  })
})

describe('installNormalization — auto-run on query success', () => {
  it('patches a cached list when a later get for a shared resource resolves', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'Old' })] },
      'GET /albums/1': { data: resource('albums', '1', { title: 'Auto' }) },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    teardowns.push(installNormalization(qc, descriptor))

    const listOpts = listQueryOptions(client, 'albums')
    await qc.fetchQuery(listOpts)
    // No explicit normalize() — the get's success event drives the patch.
    await qc.fetchQuery(getQueryOptions(client, 'albums', '1'))

    const cachedList = qc.getQueryData(listOpts.queryKey) as Array<Record<string, unknown>>
    expect(cachedList[0]?.['title']).toBe('Auto')
  })

  it('does not loop: a single fetch settles (re-entrancy guarded)', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'X' })] },
      'GET /albums/1': { data: resource('albums', '1', { title: 'Y' }) },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

    let successEvents = 0
    const unsub = qc.getQueryCache().subscribe((e) => {
      if (e.type === 'updated' && e.action.type === 'success') {
        successEvents++
      }
    })
    teardowns.push(unsub)
    teardowns.push(installNormalization(qc, descriptor))

    await qc.fetchQuery(listQueryOptions(client, 'albums'))
    await qc.fetchQuery(getQueryOptions(client, 'albums', '1'))

    // Two fetches => two success events. The normalizer's own setQueriesData patches fire while
    // the re-entrancy guard is up, so they do NOT re-trigger a normalize pass (no runaway).
    expect(successEvents).toBeGreaterThanOrEqual(2)
    expect(successEvents).toBeLessThan(10)
  })

  it('teardown stops further patching and is idempotent', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'Old' })] },
      'GET /albums/1': { data: resource('albums', '1', { title: 'Newer' }) },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const teardown = installNormalization(qc, descriptor)

    const listOpts = listQueryOptions(client, 'albums')
    await qc.fetchQuery(listOpts)

    teardown()
    teardown() // idempotent — no throw

    await qc.fetchQuery(getQueryOptions(client, 'albums', '1'))
    // With the subscription torn down, the list's albums:1 is NOT auto-patched.
    const cachedList = qc.getQueryData(listOpts.queryKey) as Array<Record<string, unknown>>
    expect(cachedList[0]?.['title']).toBe('Old')
  })
})

describe('installNormalization — auto-run on mutation success', () => {
  it('patches a cached list when a mutation resolves a fresh resource', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'Before' })] },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    teardowns.push(installNormalization(qc, descriptor))

    const listOpts = listQueryOptions(client, 'albums')
    await qc.fetchQuery(listOpts)

    // A write that resolves a freshly-materialised albums:1 (a `client.albums.id('1').update`
    // returns the updated resource). The mutation cache emits a success carrying that resource as
    // its data, which the installed subscription indexes + patches across the cache. We drive the
    // mutationFn directly through query-core (no framework adapter), materialising albums:1 with a
    // new title via a one-off update route.
    const updateClient = makeClient({
      'PATCH /albums/1': { data: resource('albums', '1', { title: 'After' }) },
    }).client
    await qc
      .getMutationCache()
      .build<unknown, Error, void, unknown>(qc, {
        mutationFn: () => updateClient.albums.id('1').update({ title: 'After' }),
      })
      .execute(undefined)

    const cachedList = qc.getQueryData(listOpts.queryKey) as Array<Record<string, unknown>>
    expect(cachedList[0]?.['title']).toBe('After')
  })
})

describe('normalize — does not clobber invalidation flags (regression: patch only changed queries)', () => {
  it('a create under installNormalization leaves an INACTIVE list isInvalidated === true', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'A' })] },
      'POST /albums': { data: resource('albums', '2', { title: 'New' }) },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    // installNormalization subscribes to mutation success — the exact path that previously
    // un-invalidated the cache by writing back every query via setQueriesData({}).
    teardowns.push(installNormalization(qc, descriptor))

    const listOpts = listQueryOptions(client, 'albums')
    // Prime the list, then drop its observer so it is INACTIVE (no in-flight refetch on invalidate).
    await qc.fetchQuery(listOpts)
    expect(qc.getQueryState(listOpts.queryKey)?.isInvalidated).toBe(false)

    // Drive a create: onSuccess(normalize) then onSettled(invalidateLists). The install mutation
    // subscription ALSO fires a normalize on the same success — which previously cleared the just-set
    // isInvalidated flag. The inactive list must remain invalidated so it refetches on next mount.
    await qc
      .getMutationCache()
      .build<unknown, Error, { title: string }, unknown>(
        qc,
        createMutationOptions(qc, client, descriptor, 'albums') as never,
      )
      .execute({ title: 'New' })

    expect(qc.getQueryState(listOpts.queryKey)?.isInvalidated).toBe(true)
  })

  it('a normalize pass does NOT reset isInvalidated on an untouched, invalidated query', async () => {
    const { client } = makeClient({
      'GET /tracks': { data: [resource('tracks', 't1', { title: 'T' })] },
      'GET /albums/1': { data: resource('albums', '1', { title: 'Fresh' }) },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

    const tracksOpts = listQueryOptions(client, 'tracks')
    await qc.fetchQuery(tracksOpts)
    await qc.invalidateQueries({ queryKey: tracksOpts.queryKey, refetchType: 'none' })
    expect(qc.getQueryState(tracksOpts.queryKey)?.isInvalidated).toBe(true)

    // Normalize an albums result — it touches nothing in the tracks list.
    const album = await qc.fetchQuery(getQueryOptions(client, 'albums', '1'))
    normalize(qc, album, descriptor)

    // The untouched tracks list keeps its invalidated flag (no blanket write-back).
    expect(qc.getQueryState(tracksOpts.queryKey)?.isInvalidated).toBe(true)
  })

  it('only fires a setData event on queries that actually changed (no over-notification)', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'Old' })] },
      'GET /tracks': { data: [resource('tracks', 't1', { title: 'T' })] },
      'GET /albums/1': { data: resource('albums', '1', { title: 'New' }) },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

    await qc.fetchQuery(listQueryOptions(client, 'albums'))
    const tracksOpts = listQueryOptions(client, 'tracks')
    await qc.fetchQuery(tracksOpts)
    const album = await qc.fetchQuery(getQueryOptions(client, 'albums', '1'))

    // Count success/setData events from here on — only the albums queries hold albums:1.
    let tracksEvents = 0
    const unsub = qc.getQueryCache().subscribe((e) => {
      if (e.type === 'updated' && e.action.type === 'success' && e.query.queryKey[0] === 'tracks') {
        tracksEvents++
      }
    })
    teardowns.push(unsub)

    normalize(qc, album, descriptor)
    // The tracks list does not hold albums:1, so it is never written back / notified.
    expect(tracksEvents).toBe(0)
  })
})

describe('applyOptimisticPatch — concurrent rollback (regression: no stale-snapshot stomp)', () => {
  it('an earlier patch rolling back does not stomp a later concurrent optimistic value', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'Original' })] },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const listOpts = listQueryOptions(client, 'albums')
    await qc.fetchQuery(listOpts)
    const cached = () =>
      (qc.getQueryData(listOpts.queryKey) as Array<Record<string, unknown>>)[0]?.['title']

    const snapA = applyOptimisticPatch(qc, 'albums', '1', { title: 'A' }, descriptor)
    const snapB = applyOptimisticPatch(qc, 'albums', '1', { title: 'B' }, descriptor)
    expect(cached()).toBe('B')

    // A fails first — the headline bug: its restore must NOT stomp B's newer optimistic value.
    // (Compare-and-swap: A only reverts a key still holding the value A itself wrote — here B
    // overwrote `title`, so A leaves it alone.)
    snapA.restore()
    expect(cached()).toBe('B')

    // B then fails — B owns `title` now, so its restore reverts to the value B snapshotted before
    // it wrote (which was A's optimistic value, since B layered on top of A). Both snapshots have
    // been consumed and the cache is no longer wedged at B.
    snapB.restore()
    expect(cached()).toBe('A')
  })

  it('a single optimistic patch still rolls back exactly to the prior value', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'Original', year: 2000 })] },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const listOpts = listQueryOptions(client, 'albums')
    await qc.fetchQuery(listOpts)

    const snap = applyOptimisticPatch(qc, 'albums', '1', { title: 'New' }, descriptor)
    const row = () => (qc.getQueryData(listOpts.queryKey) as Array<Record<string, unknown>>)[0]
    expect(row()?.['title']).toBe('New')
    snap.restore()
    expect(row()?.['title']).toBe('Original')
    expect(row()?.['year']).toBe(2000)
  })
})

describe('installNormalization — one descriptor per QueryClient (regression: cross-descriptor leak)', () => {
  it('refuses a second, different descriptor on the same QueryClient', () => {
    const qc = new QueryClient()
    teardowns.push(installNormalization(qc, descriptor))
    // A different descriptor object (even structurally similar) is rejected.
    const other = { ...descriptor } as unknown as ApiDescriptor
    expect(() => installNormalization(qc, other)).toThrow(/only one descriptor/i)
  })

  it('allows re-installing the SAME descriptor (idempotent-friendly)', () => {
    const qc = new QueryClient()
    teardowns.push(installNormalization(qc, descriptor))
    expect(() => teardowns.push(installNormalization(qc, descriptor))).not.toThrow()
  })

  it('a different descriptor can be installed after the first is torn down', () => {
    const qc = new QueryClient()
    const teardown = installNormalization(qc, descriptor)
    teardown()
    const other = { ...descriptor } as unknown as ApiDescriptor
    expect(() => teardowns.push(installNormalization(qc, other))).not.toThrow()
  })
})
