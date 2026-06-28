import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { matchQuery, QueryClient } from '@tanstack/query-core'
import { describe, expect, it } from 'vitest'
import { keyFor, operationKey, resourceKey, typeKey } from './keys'
import {
  createQueryApi,
  getQueryOptions,
  listQueryOptions,
  relatedQueryOptions,
  relationshipQueryOptions,
} from './read'

const BASE = 'https://music.example'

// A descriptor mirroring the music-catalog shape the client tests use; `as const satisfies` keeps
// the literal types so the bound API's narrowing is real (typed accessors, narrowed returns).
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

/** A resource object in a fixture document. */
const resource = (type: string, id: string, attributes: Record<string, unknown> = {}) => ({
  type,
  id,
  attributes,
})

/**
 * A mock transport: records each request and replies from a route table keyed by `METHOD path`
 * (path = the URL's pathname, query stripped). Captured requests let a test assert the URL the
 * option's `queryFn` drove (so a sparse-fieldset/include narrowing is provably serialised).
 */
function mockTransport(routes: Record<string, unknown>) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    const url = new URL(req.url)
    const route = `${req.method} ${url.pathname}`
    const body = routes[route]
    if (body === undefined) {
      return { status: 404, headers: {}, body: JSON.stringify({ errors: [{ status: '404' }] }) }
    }
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }
  return { transport, requests }
}

function makeClient(routes: Record<string, unknown>) {
  const { transport, requests } = mockTransport(routes)
  const client = createClient(descriptor, { baseUrl: BASE, transport })
  return { client, requests }
}

describe('listQueryOptions', () => {
  it('fetchQuery resolves the materialised collection under the expected key', async () => {
    const { client, requests } = makeClient({
      'GET /albums': {
        data: [resource('albums', '1', { title: 'A' }), resource('albums', '2', { title: 'B' })],
      },
    })
    const qc = new QueryClient()
    const options = listQueryOptions(client, 'albums')

    expect(options.queryKey).toEqual(keyFor({ type: 'albums', operation: 'fetchMany' }))

    const result = await qc.fetchQuery(options)
    expect(result.map((a) => a.id)).toEqual(['1', '2'])
    expect(result[0]?.title).toBe('A')

    // The result is cached under the deterministic key (a second fetchQuery is a cache hit).
    expect(qc.getQueryData(options.queryKey)).toBe(result)
    expect(requests).toHaveLength(1)
  })

  it('serialises include/fields into the request URL (narrowing is wired through)', async () => {
    const { client, requests } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'A' })] },
    })
    const qc = new QueryClient()
    const options = listQueryOptions(client, 'albums', {
      include: ['artist'],
      fields: { albums: ['title'] },
      sort: ['title'],
    })
    await qc.fetchQuery(options)
    const url = requests[0]?.url ?? ''
    expect(url).toContain('include=artist')
    // Bracketed family keys are kept literal by the client serializer; only values are encoded.
    expect(url).toContain('fields[albums]=title')
    expect(url).toContain('sort=title')
  })

  it('shares a key for param-reordered but equal queries (one cache entry)', async () => {
    const { client, requests } = makeClient({
      'GET /albums': { data: [resource('albums', '1')] },
    })
    // staleTime: Infinity so the second fetchQuery is a true cache hit (default staleTime 0 would
    // refetch even under the same key) — proving the two reorderings collapsed to one entry.
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const a = listQueryOptions(client, 'albums', { sort: 'title', filter: { q: 'x' } })
    const b = listQueryOptions(client, 'albums', { filter: { q: 'x' }, sort: 'title' })
    expect(a.queryKey).toEqual(b.queryKey)
    const first = await qc.fetchQuery(a)
    const second = await qc.fetchQuery(b)
    // One request: the second resolved from cache under the shared key.
    expect(requests).toHaveLength(1)
    expect(second).toBe(first)
    expect(qc.getQueryData(a.queryKey)).toBe(qc.getQueryData(b.queryKey))
  })
})

describe('getQueryOptions', () => {
  it('fetchQuery resolves the single resource under [type, fetchOne, id]', async () => {
    const { client } = makeClient({
      'GET /albums/1': { data: resource('albums', '1', { title: 'Solo' }) },
    })
    const qc = new QueryClient()
    const options = getQueryOptions(client, 'albums', '1')
    expect(options.queryKey).toEqual(keyFor({ type: 'albums', operation: 'fetchOne', id: '1' }))

    const result = await qc.fetchQuery(options)
    expect(result.id).toBe('1')
    expect(result.title).toBe('Solo')
  })

  it('narrows the result with an include (compound document materialises the relation)', async () => {
    const { client } = makeClient({
      'GET /albums/1': {
        data: {
          ...resource('albums', '1', { title: 'Solo' }),
          relationships: { artist: { data: { type: 'artists', id: '9' } } },
        },
        included: [resource('artists', '9', { name: 'Nina' })],
      },
    })
    const qc = new QueryClient()
    const result = await qc.fetchQuery(
      getQueryOptions(client, 'albums', '1', { include: ['artist'] }),
    )
    expect(result.artist?.name).toBe('Nina')
  })
})

describe('relationship + related options', () => {
  it('relationshipQueryOptions resolves linkage under [type, fetchRelationship, id, rel]', async () => {
    const { client } = makeClient({
      'GET /albums/1/relationships/tracks': {
        data: [
          { type: 'tracks', id: 't1' },
          { type: 'tracks', id: 't2' },
        ],
      },
    })
    const qc = new QueryClient()
    const options = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    expect(options.queryKey).toEqual(
      keyFor({ type: 'albums', operation: 'fetchRelationship', id: '1', rel: 'tracks' }),
    )
    const linkage = (await qc.fetchQuery(options)) as { id: string }[]
    expect(linkage.map((m) => m.id)).toEqual(['t1', 't2'])
  })

  it('relatedQueryOptions resolves the related collection under [type, fetchRelated, id, rel]', async () => {
    const { client } = makeClient({
      'GET /albums/1/tracks': {
        data: [resource('tracks', 't1', { title: 'One' })],
      },
    })
    const qc = new QueryClient()
    const options = relatedQueryOptions(client, 'albums', '1', 'tracks')
    expect(options.queryKey).toEqual(
      keyFor({ type: 'albums', operation: 'fetchRelated', id: '1', rel: 'tracks' }),
    )
    const related = (await qc.fetchQuery(options)) as { id: string; title: string }[]
    expect(related[0]?.title).toBe('One')
  })
})

describe('createQueryApi (bound)', () => {
  it('produces the same options as the standalone factories', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1', { title: 'A' })] },
      'GET /albums/1': { data: resource('albums', '1', { title: 'A' }) },
    })
    const api = createQueryApi(client)

    const bound = api.albums.list({ sort: 'title' })
    const standalone = listQueryOptions(client, 'albums', { sort: 'title' })
    expect(bound.queryKey).toEqual(standalone.queryKey)

    expect(api.albums.get('1').queryKey).toEqual(
      keyFor({ type: 'albums', operation: 'fetchOne', id: '1' }),
    )
    expect(api.albums.related('1', 'tracks').queryKey).toEqual(
      keyFor({ type: 'albums', operation: 'fetchRelated', id: '1', rel: 'tracks' }),
    )

    const qc = new QueryClient()
    const result = await qc.fetchQuery(api.albums.list())
    expect(result[0]?.title).toBe('A')
  })
})

describe('hierarchical keys drive targeted invalidation against a real cache', () => {
  it('a type-prefix invalidate matches every read of the type', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1')] },
      'GET /albums/1': { data: resource('albums', '1') },
      'GET /artists': { data: [resource('artists', '9')] },
    })
    const qc = new QueryClient()
    const list = listQueryOptions(client, 'albums')
    const one = getQueryOptions(client, 'albums', '1')
    const artists = listQueryOptions(client, 'artists')
    await qc.fetchQuery(list)
    await qc.fetchQuery(one)
    await qc.fetchQuery(artists)

    const cache = qc.getQueryCache()
    const matchesAlbums = cache
      .getAll()
      .filter((q) => matchQuery({ queryKey: typeKey('albums') }, q))
    expect(matchesAlbums.map((q) => q.queryKey)).toEqual(
      expect.arrayContaining([list.queryKey, one.queryKey]),
    )
    // The artists list is NOT under the albums subtree.
    expect(matchesAlbums.map((q) => q.queryKey)).not.toContainEqual(artists.queryKey)
  })

  it('an operation-prefix matches list reads and a resource-prefix matches a resource read', async () => {
    const { client } = makeClient({
      'GET /albums': { data: [resource('albums', '1')] },
      'GET /albums/1': { data: resource('albums', '1') },
    })
    const qc = new QueryClient()
    const listA = listQueryOptions(client, 'albums', { filter: { q: 'a' } })
    const listB = listQueryOptions(client, 'albums', { filter: { q: 'b' } })
    const one = getQueryOptions(client, 'albums', '1', { include: ['artist'] })
    await qc.fetchQuery(listA)
    await qc.fetchQuery(listB)
    await qc.fetchQuery(one)

    const cache = qc.getQueryCache()
    const listMatches = cache
      .getAll()
      .filter((q) => matchQuery({ queryKey: operationKey('albums', 'fetchMany') }, q))
    expect(listMatches.map((q) => q.queryKey)).toEqual(
      expect.arrayContaining([listA.queryKey, listB.queryKey]),
    )
    expect(listMatches.map((q) => q.queryKey)).not.toContainEqual(one.queryKey)

    const resourceMatches = cache
      .getAll()
      .filter((q) => matchQuery({ queryKey: resourceKey('albums', '1') }, q))
    expect(resourceMatches.map((q) => q.queryKey)).toContainEqual(one.queryKey)
  })
})
