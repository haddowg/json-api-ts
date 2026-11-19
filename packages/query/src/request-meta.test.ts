import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { QueryClient } from '@tanstack/query-core'
import { describe, expect, it } from 'vitest'
import { createMutationApi } from './mutate'

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
  const mutations = createMutationApi(new QueryClient(), client, descriptor)
  const sent = (index: number): unknown => JSON.parse(requests[index]!.body ?? 'null')
  return { mutations, requests, sent }
}

describe('request meta through the mutation factories', () => {
  it('builds a create’s meta from each call’s variables', async () => {
    const { mutations, sent } = setup(
      { status: 201, body: { data: booking } },
      { status: 201, body: { data: booking } },
    )
    let calls = 0
    const create = mutations.bookings.create({
      meta: () => ({ idempotencyKey: `k-${++calls}` }),
    })
    await create.mutationFn({ title: 'Weekend', $meta: { source: 'web' } })
    await create.mutationFn({ title: 'Later' })
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
    const { mutations, requests, sent } = setup({ body: { data: booking } }, { status: 204 })
    await mutations.bookings
      .id('bk-1')
      .update({ meta: { reason: 'late' } })
      .mutationFn({ title: 'Later' })
    await mutations.bookings
      .id('bk-1')
      .delete({ meta: { cancellationReason: 'ill' } })
      .mutationFn()
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
    const { mutations, sent } = setup({ body: { meta: { moved: 1 } } })
    const added = await mutations.bookings
      .id('bk-1')
      .rel('rooms')
      .add({ meta: (refs) => ({ changedBy: `desk:${refs.length}` }) })
      .mutationFn([{ type: 'rooms', id: 'rm-1' }])
    expect(sent(0)).toEqual({
      data: [{ type: 'rooms', id: 'rm-1' }],
      meta: { changedBy: 'desk:1' },
    })
    expect(added).toEqual({ moved: 1 })
  })
})
