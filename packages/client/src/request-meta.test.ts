import { describe, expect, expectTypeOf, it } from 'vitest'
import { isAccepted } from './accepted'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import { JsonApiError } from './errors'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'

const CHANGED_BY = {
  fields: { changedBy: 'string' },
  required: [],
  additional: { format: 'unknown' },
} as const

const QUEUED = {
  jobType: 'jobs',
  meta: { fields: { queuePosition: 'integer' }, required: [], nullable: ['queuePosition'] },
} as const

// Core's witness `bookings` and `rooms`, as the codegen describes them.
const descriptor = {
  bookings: {
    attributes: { title: 'string' },
    relations: {
      rooms: {
        cardinality: 'many',
        types: ['rooms'],
        pivot: true,
        readPivot: {
          fields: { nights: 'integer' },
          nullable: ['nights'],
          additional: { format: 'string', nullable: true },
        },
        identifierMeta: {
          fields: { view: 'string' },
          nullable: ['view'],
          additional: { format: 'unknown' },
        },
        writePivot: {
          fields: { nights: 'integer' },
          required: [],
          additional: { format: 'string' },
        },
        mutations: { add: true, remove: true, replace: true },
        requestMeta: { add: CHANGED_BY, remove: CHANGED_BY, replace: CHANGED_BY },
        mutationMeta: { add: { fields: { moved: 'integer' } } },
      },
      guest: { cardinality: 'one', types: ['rooms'], pivot: false, mutations: { set: true } },
    },
    paths: {
      create: '/bookings',
      delete: '/bookings/{id}',
      fetchMany: '/bookings',
      fetchOne: '/bookings/{id}',
      fetchRelated: '/bookings/{id}/{rel}',
      fetchRelationship: '/bookings/{id}/relationships/{rel}',
      update: '/bookings/{id}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    actions: {
      confirm: {
        scope: 'resource',
        path: '/bookings/{id}/-actions/confirm',
        input: 'none',
        output: 'none',
        accepted: QUEUED,
        requestMeta: { fields: { silent: 'boolean' }, required: [] },
      },
      quote: {
        scope: 'collection',
        path: '/bookings/-actions/quote',
        input: 'document',
        output: 'none',
        inputType: 'bookings',
        requestMeta: { fields: { currency: 'string' } },
      },
    },
    accepted: { create: QUEUED },
    requestMeta: {
      create: { fields: { idempotencyKey: 'string' } },
      update: { fields: { reason: 'string' }, required: [] },
      delete: { fields: { cancellationReason: 'string' } },
    },
    atomicRequestMeta: {
      create: { fields: { idempotencyKey: 'string' } },
      delete: { fields: { cancellationReason: 'string' } },
    },
    resourceMeta: {
      read: {
        fields: { heldUntil: 'date-time', nights: 'integer' },
        required: [],
        nullable: ['heldUntil', 'nights'],
        additional: { format: 'string', nullable: true },
      },
      create: { fields: { source: 'string' }, required: [], additional: { format: 'string' } },
      update: { fields: { source: 'string' }, required: [], additional: { format: 'string' } },
    },
  },
  rooms: {
    attributes: {},
    relations: {},
    paths: {
      create: '/rooms',
      delete: '/rooms/{id}',
      fetchMany: '/rooms',
      fetchOne: '/rooms/{id}',
      update: '/rooms/{id}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    resourceMeta: {
      read: { fields: { floor: 'integer', pivot: 'object' }, required: [], nullable: ['floor'] },
      create: { fields: {} },
      update: { fields: {} },
    },
  },
  jobs: { attributes: {}, relations: {}, paths: {}, paginator: 'none', clientId: 'forbidden' },
} as const satisfies ApiDescriptor

interface Attributes {
  bookings: { title: string }
  rooms: Record<string, never>
  jobs: Record<string, never>
}

interface WriteAttributes {
  bookings: { create: { title: string }; update: { title?: string } }
  rooms: { create: Record<string, never>; update: Record<string, never> }
  jobs: { create: Record<string, never>; update: Record<string, never> }
}

const booking = {
  type: 'bookings',
  id: 'bk-1',
  attributes: { title: 'Weekend' },
  meta: { nights: 3, heldUntil: null, channel: 'web' },
}

function answering(
  ...replies: { status?: number; body?: unknown; headers?: Record<string, string> }[]
) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    const next = replies.shift() ?? {}
    return {
      status: next.status ?? 200,
      headers: next.headers ?? {},
      body: next.body === undefined ? '' : JSON.stringify(next.body),
    }
  }
  const client = createClient<typeof descriptor, Attributes, WriteAttributes>(descriptor, {
    baseUrl: BASE,
    transport,
    atomic: { path: '/operations' },
  })
  const sent = (index: number): unknown => JSON.parse(requests[index]!.body ?? 'null')
  return { requests, client, sent }
}

describe('typed request meta', () => {
  it('sends a create’s meta and its resource object’s $meta, and types both', async () => {
    const { client, sent } = answering({ status: 201, body: { data: booking } })
    const created = await client.bookings.create(
      { title: 'Weekend', $meta: { source: 'web', campaign: 'autumn' } },
      { meta: { idempotencyKey: 'k-1' } },
    )
    expect(sent(0)).toEqual({
      data: {
        type: 'bookings',
        attributes: { title: 'Weekend' },
        meta: { source: 'web', campaign: 'autumn' },
      },
      meta: { idempotencyKey: 'k-1' },
    })
    if (isAccepted(created)) {
      throw new Error('expected the created booking')
    }
    expect(created.$meta).toEqual({ nights: 3, heldUntil: null, channel: 'web' })
    expectTypeOf(created.$meta?.nights).toEqualTypeOf<number | null | undefined>()
    expectTypeOf(created.$meta?.heldUntil).toEqualTypeOf<string | null | undefined>()
  })

  it('requires a member the write declares as required, and refuses one it doesn’t declare', () => {
    const { client } = answering()
    // @ts-expect-error -- the create must send its idempotency key.
    void client.bookings.create({ title: 'Weekend' }).catch(() => undefined)
    void client.bookings
      // @ts-expect-error -- the create declares no `other` member.
      .create({ title: 'Weekend' }, { meta: { idempotencyKey: 'k', other: 1 } })
      .catch(() => undefined)
    void client.bookings
      // @ts-expect-error -- an undeclared resource meta member is a string.
      .create({ title: 'W', $meta: { campaign: 1 } }, { meta: { idempotencyKey: 'k' } })
      .catch(() => undefined)
    // @ts-expect-error -- a room's writes take no resource meta member.
    void client.rooms.create({ $meta: { floor: 1 } }).catch(() => undefined)
  })

  it('sends an update’s optional meta only when given', async () => {
    const { client, sent } = answering({ body: { data: booking } }, { body: { data: booking } })
    await client.bookings.id('bk-1').update({ title: 'Later' })
    await client.bookings
      .id('bk-1')
      .update({ $meta: { source: 'desk' } }, { meta: { reason: 'late' } })
    expect(sent(0)).toEqual({
      data: { type: 'bookings', id: 'bk-1', attributes: { title: 'Later' } },
    })
    expect(sent(1)).toEqual({
      data: { type: 'bookings', id: 'bk-1', meta: { source: 'desk' } },
      meta: { reason: 'late' },
    })
  })

  it('sends a delete’s meta as a meta-only document, and no body for a delete declaring none', async () => {
    const { client, requests, sent } = answering({ status: 204 }, { status: 204 })
    await client.bookings.id('bk-1').delete({ meta: { cancellationReason: 'ill' } })
    await client.rooms.id('rm-1').delete()
    expect(requests[0]!.method).toBe('DELETE')
    expect(sent(0)).toEqual({ meta: { cancellationReason: 'ill' } })
    expect(requests[0]!.headers['Content-Type']).toBe('application/vnd.api+json')
    expect(requests[1]!.body).toBeUndefined()
    const handle = client.bookings.id('bk-1')
    const room = client.rooms.id('rm-1')
    // @ts-expect-error -- the delete must send its reason.
    void handle.delete().catch(() => undefined)
    // @ts-expect-error -- a delete declaring no meta takes no body.
    void room.delete({ meta: {} }).catch(() => undefined)
  })

  it('sends a relationship write’s meta and resolves a meta-only answer to its meta', async () => {
    const { client, sent } = answering(
      { body: { meta: { moved: 1 } } },
      {
        body: {
          data: [{ type: 'rooms', id: 'rm-2', meta: { view: 'sea', pivot: { nights: 2 } } }],
        },
      },
    )
    const added = await client.bookings
      .id('bk-1')
      .rooms.add([{ type: 'rooms', id: 'rm-1', $pivot: { nights: 2, note: 'x' } }], {
        meta: { changedBy: 'desk', batch: 4 },
      })
    expect(sent(0)).toEqual({
      data: [{ type: 'rooms', id: 'rm-1', meta: { pivot: { nights: 2, note: 'x' } } }],
      meta: { changedBy: 'desk', batch: 4 },
    })
    expect(added).toEqual({ moved: 1 })
    expectTypeOf(added.moved).toEqualTypeOf<number>()
    const replaced = await client.bookings.id('bk-1').rooms.replace([{ type: 'rooms', id: 'rm-2' }])
    expect(replaced).toHaveLength(1)
    expect(sent(1)).toEqual({ data: [{ type: 'rooms', id: 'rm-2' }] })
  })

  it('types an identifier meta that says it is open, pivot included', async () => {
    const { client } = answering({
      body: {
        data: [
          { type: 'rooms', id: 'rm-1', meta: { view: 'sea', pivot: { nights: 2 }, wing: 'east' } },
        ],
      },
    })
    const rooms = await client.bookings.id('bk-1').rooms.get()
    const meta = rooms[0]!.$edge?.meta
    expect(meta).toEqual({ view: 'sea', pivot: { nights: 2 }, wing: 'east' })
    expectTypeOf(meta?.view).toEqualTypeOf<string | null | undefined>()
    expectTypeOf(meta?.pivot?.nights).toEqualTypeOf<number | null | undefined>()
  })

  it('sends an action’s meta, meta-only when it takes no document', async () => {
    const { client, requests, sent } = answering({ status: 204 }, { status: 204 }, { status: 204 })
    await client.bookings.id('bk-1').actions.confirm({ meta: { silent: true } })
    await client.bookings.id('bk-1').actions.confirm()
    await client.bookings.actions.quote({ title: 'Weekend' }, { meta: { currency: 'EUR' } })
    expect(sent(0)).toEqual({ meta: { silent: true } })
    expect(requests[0]!.headers['Content-Type']).toBe('application/vnd.api+json')
    expect(requests[1]!.body).toBeUndefined()
    expect(sent(2)).toEqual({
      data: { type: 'bookings', attributes: { title: 'Weekend' } },
      meta: { currency: 'EUR' },
    })
    // @ts-expect-error -- the quote must send its currency.
    void client.bookings.actions.quote({ title: 'Weekend' }).catch(() => undefined)
  })

  it('types the meta of an accepted job document', async () => {
    const { client } = answering({
      status: 202,
      headers: { 'Content-Location': `${BASE}/jobs/job-1` },
      body: { data: { type: 'jobs', id: 'job-1' }, meta: { queuePosition: 4 } },
    })
    const created = await client.bookings.create({ title: 'W' }, { meta: { idempotencyKey: 'k' } })
    if (!isAccepted(created)) {
      throw new Error('expected an accepted job')
    }
    expect(created.meta).toEqual({ queuePosition: 4 })
    expect(Object.keys(created)).toEqual(['job', 'contentLocation', 'retryAfter'])
    expectTypeOf(created.meta?.queuePosition).toEqualTypeOf<number | null | undefined>()
  })

  it('carries each atomic operation’s meta, typed by the type’s atomic kinds', async () => {
    const { client, sent } = answering({ body: { 'atomic:results': [{ data: booking }, {}] } })
    await client.atomic((tx) => [
      tx.create(
        { type: 'bookings', title: 'Weekend', $meta: { source: 'import' } },
        { meta: { idempotencyKey: 'k-2' } },
      ),
      tx.delete({ type: 'bookings', id: 'bk-9' }, { meta: { cancellationReason: 'ill' } }),
      tx.update({ type: 'bookings', id: 'bk-1', title: 'Later' }),
    ])
    expect(sent(0)).toEqual({
      'atomic:operations': [
        {
          op: 'add',
          data: {
            type: 'bookings',
            lid: 'atomic-0',
            attributes: { title: 'Weekend' },
            meta: { source: 'import' },
          },
          meta: { idempotencyKey: 'k-2' },
        },
        {
          op: 'remove',
          ref: { type: 'bookings', id: 'bk-9' },
          meta: { cancellationReason: 'ill' },
        },
        {
          op: 'update',
          ref: { type: 'bookings', id: 'bk-1' },
          data: { type: 'bookings', id: 'bk-1', attributes: { title: 'Later' } },
        },
      ],
    })
    // @ts-expect-error -- an atomic add of a booking must send its idempotency key.
    void client.atomic((tx) => [tx.create({ type: 'bookings', title: 'W' })]).catch(() => undefined)
  })

  it('remaps a resource object meta pointer to $meta, and leaves a top-level one as sent', async () => {
    const { client } = answering({
      status: 422,
      body: {
        errors: [
          { status: '422', source: { pointer: '/data/meta/source' } },
          { status: '422', source: { pointer: '/meta/idempotencyKey' } },
        ],
      },
    })
    const error = await client.bookings
      .create({ title: 'W', $meta: { source: '' } }, { meta: { idempotencyKey: '' } })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JsonApiError)
    expect((error as JsonApiError).errors.map((e) => e.path)).toEqual([
      '$meta.source',
      '/meta/idempotencyKey',
    ])
  })
})
