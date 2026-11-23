import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { QueryClient, type QueryClientConfig } from '@tanstack/query-core'
import { describe, expect, it } from 'vitest'
import { installNormalization } from './install'
import { JsonApiMutationCache } from './mutation-cache'
import { createMutationApi, type MutationOptions } from './mutate'

const BASE = 'https://api.example'

// Core's witness `bookings`, whose writes declare their request meta, and `rooms`.
const descriptor = {
  bookings: {
    attributes: { title: 'string' },
    relations: {
      rooms: {
        cardinality: 'many',
        types: ['rooms'],
        pivot: false,
        mutations: { add: true },
        requestMeta: {
          add: { fields: { changedBy: 'string' }, required: [], additional: { format: 'unknown' } },
        },
        mutationMeta: { add: { fields: { moved: 'integer' } } },
      },
    },
    paths: {
      create: '/bookings',
      delete: '/bookings/{id}',
      fetchMany: '/bookings',
      fetchOne: '/bookings/{id}',
      fetchRelationship: '/bookings/{id}/relationships/{rel}',
      update: '/bookings/{id}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    requestMeta: {
      create: { fields: { idempotencyKey: 'string' } },
      update: { fields: { reason: 'string' }, required: [] },
      delete: { fields: { cancellationReason: 'string' } },
    },
    resourceMeta: {
      create: { fields: { source: 'string' }, required: [] },
    },
  },
  rooms: {
    attributes: {},
    relations: {},
    paths: { delete: '/rooms/{id}', fetchOne: '/rooms/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

interface WriteAttributes {
  bookings: { create: { title: string }; update: { title?: string } }
  rooms: { create: Record<string, never>; update: Record<string, never> }
}

const booking = { type: 'bookings', id: 'bk-1', attributes: { title: 'Weekend' } }

function setup(...replies: { status?: number; body?: unknown }[]) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    const next = replies.shift() ?? {}
    return {
      status: next.status ?? 200,
      headers: {},
      body: next.body === undefined ? '' : JSON.stringify(next.body),
    }
  }
  const client = createClient<typeof descriptor, unknown, WriteAttributes>(descriptor, {
    baseUrl: BASE,
    transport,
  })
  const qc = jsonApiQueryClient()
  const mutations = createMutationApi(qc, client, descriptor)
  const run = <TData, TVars>(options: MutationOptions<TData, TVars>, variables: TVars) =>
    qc
      .getMutationCache()
      .build<TData, unknown, TVars, unknown>(qc, options as never)
      .execute(variables)
  const sent = (index: number): unknown => JSON.parse(requests[index]!.body ?? 'null')
  return { mutations, requests, run, sent }
}

/**
 * A QueryClient as an app builds one for mutations: with the JsonApiMutationCache and the
 * descriptor installed.
 */
function jsonApiQueryClient(
  config: QueryClientConfig = { defaultOptions: { queries: { staleTime: Infinity } } },
): QueryClient {
  const qc = new QueryClient({ ...config, mutationCache: new JsonApiMutationCache() })
  installNormalization(qc, descriptor)
  return qc
}

describe('request meta through the mutation factories', () => {
  it('builds a create’s meta from each call’s variables', async () => {
    const { mutations, run, sent } = setup(
      { status: 201, body: { data: booking } },
      { status: 201, body: { data: booking } },
    )
    let calls = 0
    const create = mutations.bookings.create({
      meta: () => ({ idempotencyKey: `k-${++calls}` }),
    })
    await run(create, { title: 'Weekend', $meta: { source: 'web' } })
    await run(create, { title: 'Later' })
    expect(sent(0)).toEqual({
      data: { type: 'bookings', attributes: { title: 'Weekend' }, meta: { source: 'web' } },
      meta: { idempotencyKey: 'k-1' },
    })
    expect(sent(1)).toEqual({
      data: { type: 'bookings', attributes: { title: 'Later' } },
      meta: { idempotencyKey: 'k-2' },
    })
    // @ts-expect-error -- the create must send its idempotency key.
    void mutations.bookings.create()
  })

  it('sends an update’s and a delete’s meta as given', async () => {
    const { mutations, requests, run, sent } = setup({ body: { data: booking } }, { status: 204 })
    await run(mutations.bookings.id('bk-1').update({ meta: { reason: 'late' } }), {
      title: 'Later',
    })
    await run(
      mutations.bookings.id('bk-1').delete({ meta: { cancellationReason: 'ill' } }),
      undefined,
    )
    expect(sent(0)).toEqual({
      data: { type: 'bookings', id: 'bk-1', attributes: { title: 'Later' } },
      meta: { reason: 'late' },
    })
    expect(requests[1]!.method).toBe('DELETE')
    expect(sent(1)).toEqual({ meta: { cancellationReason: 'ill' } })
    const booked = mutations.bookings.id('bk-1')
    // @ts-expect-error -- the delete must send its reason.
    void booked.delete()
    // @ts-expect-error -- a delete declaring no meta takes none.
    void mutations.rooms.id('rm-1').delete({ meta: {} })
  })

  it('sends a relationship write’s meta and resolves its meta-only answer', async () => {
    const { mutations, run, sent } = setup({ body: { meta: { moved: 1 } } })
    const added = await run(
      mutations.bookings
        .id('bk-1')
        .rel('rooms')
        .add({ meta: (refs) => ({ changedBy: `desk:${refs.length}` }) }),
      [{ type: 'rooms', id: 'rm-1' }],
    )
    expect(sent(0)).toEqual({
      data: [{ type: 'rooms', id: 'rm-1' }],
      meta: { changedBy: 'desk:1' },
    })
    expect(added).toEqual({ moved: 1 })
  })
})
