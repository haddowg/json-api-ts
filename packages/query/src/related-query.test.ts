import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { QueryClient } from '@tanstack/query-core'
import { describe, expect, it } from 'vitest'
import { keyFor } from './keys'
import { createMutationOptions, type MutationOptions, updateMutationOptions } from './mutate'
import { createQueryApi, relatedQueryOptions, relationshipQueryOptions } from './read'

const BASE = 'https://music.example'
const PROFILE = 'https://music.example/profiles/relationship-queries/'
const NEGOTIATED = `application/vnd.api+json; profile="${PROFILE}"`

// An album's tracks take the tracks' relatedQuery on their related read, which addresses a
// track's `album`. An album's create and update take the albums' relatedQuery.
const descriptor = {
  albums: {
    attributes: { title: 'string' },
    relations: {
      tracks: { cardinality: 'many', types: ['tracks'], relatedQuery: true },
    },
    paths: {
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      create: '/albums',
      update: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
      fetchRelationship: '/albums/{id}/relationships/{rel}',
    },
    paginator: 'none',
    clientId: 'forbidden',
    sortable: ['title', '-title'],
    filterable: ['title'],
    relatedQuery: {
      operations: ['create', 'update'],
      profile: PROFILE,
      relations: ['tracks'],
    },
  },
  tracks: {
    attributes: { title: 'string' },
    relations: { album: { cardinality: 'one', types: ['albums'] } },
    paths: { fetchOne: '/tracks/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    sortable: ['title', '-title'],
    filterable: ['title'],
    relatedQuery: { operations: [], profile: PROFILE, relations: ['album'] },
  },
} as const satisfies ApiDescriptor

const album = { type: 'albums', id: '1', attributes: { title: 'A' } }

function makeClient(body: unknown) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }
  return { client: createClient(descriptor, { baseUrl: BASE, transport }), requests }
}

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

describe('relatedQuery through the query options', () => {
  it("keys and sends a related read's relatedQuery", async () => {
    const { client, requests } = makeClient({ data: [] })
    const query = { relatedQuery: { album: { filter: { title: 'A' } } } } as const
    const options = relatedQueryOptions(client, 'albums', '1', 'tracks', query)
    expect(options.queryKey).toEqual(
      keyFor({ type: 'albums', operation: 'fetchRelated', id: '1', rel: 'tracks' }, query),
    )
    expect(createQueryApi(client).albums.related('1', 'tracks', query).queryKey).toEqual(
      options.queryKey,
    )
    await new QueryClient().fetchQuery(options)
    expect(decodeURI(requests[0]!.url)).toBe(
      `${BASE}/albums/1/tracks?relatedQuery[album][filter][title]=A`,
    )
    expect(requests[0]!.headers['Accept']).toBe(NEGOTIATED)
  })

  it('types it by the related type and keeps it off the relationship read', () => {
    const { client } = makeClient({ data: [] })
    // @ts-expect-error a track's relatedQuery addresses `album`, not `tracks`
    relatedQueryOptions(client, 'albums', '1', 'tracks', { relatedQuery: { tracks: {} } })
    // @ts-expect-error a to-one takes no sort
    relatedQueryOptions(client, 'albums', '1', 'tracks', { relatedQuery: { album: { sort: 'x' } } })
    // @ts-expect-error a relationship read takes no relatedQuery
    relationshipQueryOptions(client, 'albums', '1', 'tracks', { relatedQuery: { album: {} } })
  })

  it('passes it through the create and update mutations', async () => {
    const { client, requests } = makeClient({ data: album })
    const qc = new QueryClient()
    await runMutation(
      qc,
      createMutationOptions(qc, client, descriptor, 'albums', {
        relatedQuery: { tracks: { sort: '-title' } },
      }),
      { title: 'A' },
    )
    await runMutation(
      qc,
      updateMutationOptions(qc, client, descriptor, 'albums', '1', {
        relatedQuery: { tracks: { filter: { title: 'B' } } },
      }),
      { title: 'A' },
    )
    expect(decodeURI(requests[0]!.url)).toBe(`${BASE}/albums?relatedQuery[tracks][sort]=-title`)
    expect(decodeURI(requests[1]!.url)).toBe(
      `${BASE}/albums/1?relatedQuery[tracks][filter][title]=B`,
    )
    for (const req of requests) {
      expect(req.headers['Accept']).toBe(NEGOTIATED)
    }
  })

  it("types the mutations' relatedQuery by the written type", () => {
    const qc = new QueryClient()
    const { client } = makeClient({ data: album })
    createMutationOptions(qc, client, descriptor, 'albums', {
      // @ts-expect-error a dotted path is not a relation
      relatedQuery: { 'tracks.album': {} },
    })
  })
})
