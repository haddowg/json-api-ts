import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { QueryClient } from '@tanstack/query-core'
import { describe, expect, it } from 'vitest'
import { applyOptimisticMembership } from './normalize'
import { getQueryOptions, listQueryOptions, relatedQueryOptions } from './read'

const BASE = 'https://music.example'

const descriptor = {
  albums: {
    attributes: { title: 'string' },
    relations: { tracks: { cardinality: 'many', types: ['tracks'] } },
    paths: {
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
    },
    paginator: 'page',
    clientId: 'forbidden',
  },
  tracks: {
    attributes: { title: 'string' },
    relations: {},
    paths: { fetchMany: '/tracks', fetchOne: '/tracks/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

type Envelope = {
  $page?: unknown
  $next?: unknown
  $prev?: unknown
  $links?: unknown
  $self?: unknown
}

function setup() {
  let title = 'OK Computer'
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    const url = decodeURI(req.url)
    const album = { type: 'albums', id: '1', attributes: { title } }
    const body = url.includes('/albums/1/tracks')
      ? {
          data: [{ type: 'tracks', id: '1', attributes: { title: 'Airbag' } }],
          links: { next: `${BASE}/albums/1/tracks?page[number]=2` },
        }
      : url.includes('/albums/1')
        ? { data: album }
        : { data: [album], links: { next: `${BASE}/albums?page[number]=2` } }
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }
  const client = createClient(descriptor, { baseUrl: BASE, transport })
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  return {
    client,
    queryClient,
    rename: (next: string) => {
      title = next
    },
  }
}

describe('a materialised value in the cache keeps its accessors', () => {
  it('when a collection is refetched with changed data', async () => {
    const { client, queryClient, rename } = setup()
    const list = listQueryOptions(client, 'albums')
    await queryClient.fetchQuery(list)
    rename('Kid A')
    await queryClient.refetchQueries({ queryKey: list.queryKey })

    const data = queryClient.getQueryData(list.queryKey) as unknown as Envelope &
      (Envelope & { title: string })[]
    expect(data[0]!.title).toBe('Kid A')
    expect(data.$page).toBeDefined()
    expect(typeof data.$next).toBe('function')
    expect(Object.getOwnPropertyDescriptor(data[0], '$raw')).toBeDefined()
  })

  it('when a single read is refetched with changed data', async () => {
    const { client, queryClient, rename } = setup()
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(get)
    rename('Amnesiac')
    await queryClient.refetchQueries({ queryKey: get.queryKey })

    const data = queryClient.getQueryData(get.queryKey) as unknown as { title: string }
    expect(data.title).toBe('Amnesiac')
    expect(Object.getOwnPropertyDescriptor(data, '$raw')).toBeDefined()
  })

  it('when an optimistic membership change replaces a to-many, and when it rolls back', async () => {
    const { client, queryClient } = setup()
    const related = relatedQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(related)
    const before = queryClient.getQueryData(related.queryKey) as unknown as Envelope

    const snapshot = applyOptimisticMembership(queryClient, 'albums', '1', 'tracks', (members) => [
      ...members,
      { type: 'tracks', id: '2' },
    ])
    const optimistic = queryClient.getQueryData(related.queryKey) as unknown as Envelope & unknown[]
    expect(optimistic).toHaveLength(2)
    expect(optimistic.$page).toBe(before.$page)
    expect(typeof optimistic.$next).toBe('function')
    expect(optimistic.$links).toBe(before.$links)

    snapshot.restore()
    const restored = queryClient.getQueryData(related.queryKey) as unknown as Envelope & unknown[]
    expect(restored).toHaveLength(1)
    expect(restored.$page).toBe(before.$page)
  })
})
