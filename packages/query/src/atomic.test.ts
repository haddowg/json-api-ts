import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { QueryClient } from '@tanstack/query-core'
import { describe, expect, it } from 'vitest'
import { atomicMutationOptions } from './mutate'
import { getQueryOptions } from './read'

const BASE = 'https://api.example'

const descriptor = {
  bookings: {
    attributes: { title: 'string' },
    relations: {
      rooms: {
        cardinality: 'many',
        types: ['rooms'],
        pivot: false,
        atomicRequestMeta: { add: { fields: { changedBy: 'string' } } },
      },
    },
    paths: { fetchOne: '/bookings/{id}', update: '/bookings/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
  rooms: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchOne: '/rooms/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

interface WriteAttributes {
  bookings: { create: { title: string }; update: { title?: string } }
  rooms: { create: { name: string }; update: { name?: string } }
}

function setup(...replies: unknown[]) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    return { status: 200, headers: {}, body: JSON.stringify(replies.shift() ?? {}) }
  }
  const client = createClient<typeof descriptor, unknown, WriteAttributes>(descriptor, {
    baseUrl: BASE,
    transport,
    atomic: { path: '/operations' },
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  return { client, queryClient, requests }
}

describe('atomicMutationOptions with relationship operations', () => {
  it('posts a relationship operation with its typed meta, and leaves the cache to the update', async () => {
    const { client, queryClient, requests } = setup(
      { data: { type: 'rooms', id: 'rm-1', attributes: { name: 'Sea view' } } },
      {
        'atomic:results': [
          { data: [{ type: 'rooms', id: 'rm-1' }] },
          { data: { type: 'bookings', id: 'bk-1', attributes: { title: 'Later' } } },
        ],
      },
    )
    const read = getQueryOptions(client, 'rooms', 'rm-1')
    await queryClient.fetchQuery(read)

    const options = atomicMutationOptions(queryClient, client, descriptor)
    const build: Parameters<typeof options.mutationFn>[0] = (tx) => {
      tx.rel({ type: 'bookings', id: 'bk-1' }, 'rooms').add([{ type: 'rooms', id: 'rm-1' }], {
        meta: { changedBy: 'desk' },
      })
      tx.update({ type: 'bookings', id: 'bk-1', title: 'Later' })
    }
    options.onSuccess?.(await options.mutationFn(build), build, undefined)

    expect(JSON.parse(requests[1]!.body ?? 'null')).toEqual({
      'atomic:operations': [
        {
          op: 'add',
          ref: { type: 'bookings', id: 'bk-1', relationship: 'rooms' },
          data: [{ type: 'rooms', id: 'rm-1' }],
          meta: { changedBy: 'desk' },
        },
        {
          op: 'update',
          ref: { type: 'bookings', id: 'bk-1' },
          data: { type: 'bookings', id: 'bk-1', attributes: { title: 'Later' } },
        },
      ],
    })
    // The linkage the relationship operation answered with carries no attributes to patch.
    expect(queryClient.getQueryData(read.queryKey)).toMatchObject({ name: 'Sea view' })

    void options
      .mutationFn((tx) => {
        // @ts-expect-error -- adding rooms in a batch must send who changed them.
        tx.rel({ type: 'bookings', id: 'bk-1' }, 'rooms').add([])
      })
      .catch(() => undefined)
  })
})
