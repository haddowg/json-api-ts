import { describe, expect, expectTypeOf, it } from 'vitest'
import { isAccepted } from './accepted'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'

const SOURCE = {
  fields: { source: 'string' },
  values: { source: ['web', 'import', 'api'] },
} as const

const SHIFT = {
  fields: { shift: 'integer' },
  required: [],
  values: { shift: [1, 2, 3] },
} as const

const QUEUED = {
  jobType: 'jobs',
  meta: {
    fields: { lane: 'string' },
    required: [],
    nullable: ['lane'],
    values: { lane: ['fast', 'slow'] },
  },
} as const

// The codegen's descriptor of a server that lists the values of every kind of meta member.
const descriptor = {
  bookings: {
    attributes: { title: 'string' },
    relations: {
      rooms: {
        cardinality: 'many',
        types: ['rooms'],
        pivot: true,
        readPivot: {
          fields: { board: 'string', nights: 'integer' },
          nullable: ['board'],
          values: { board: ['full', 'half'] },
        },
        writePivot: {
          fields: { board: 'string', nights: 'integer' },
          required: [],
          values: { board: ['full', 'half'] },
        },
        identifierMeta: {
          fields: { view: 'string' },
          nullable: ['view'],
          additional: false,
          values: { view: ['sea', 'garden'] },
        },
        mutations: { add: true, remove: true, replace: true },
        requestMeta: { add: SHIFT, remove: SHIFT, replace: SHIFT },
        mutationMeta: { add: { fields: { outcome: 'string' }, values: { outcome: ['moved'] } } },
      },
    },
    paths: {
      create: '/bookings',
      fetchMany: '/bookings',
      fetchOne: '/bookings/{id}',
      fetchRelated: '/bookings/{id}/{rel}',
      fetchRelationship: '/bookings/{id}/relationships/{rel}',
      update: '/bookings/{id}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    documentMeta: {
      fetchMany: {
        fields: { region: 'string' },
        values: { region: ['eu', 'us'] },
      },
    },
    actions: {
      confirm: {
        scope: 'resource',
        path: '/bookings/{id}/-actions/confirm',
        input: 'none',
        output: 'none',
        accepted: QUEUED,
        requestMeta: { fields: { tier: 'string' }, required: [], values: { tier: ['gold'] } },
      },
    },
    accepted: { create: QUEUED },
    requestMeta: { create: SOURCE },
    atomicRequestMeta: { create: SOURCE },
    resourceMeta: {
      read: {
        fields: { state: 'string' },
        required: [],
        nullable: ['state'],
        additional: { format: 'string', values: ['x', 'y'] },
        values: { state: ['held', 'paid'] },
      },
      create: { fields: { channel: 'string' }, required: [], values: { channel: ['desk'] } },
    },
  },
  rooms: {
    attributes: {},
    relations: {},
    paths: { fetchOne: '/rooms/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
  jobs: { attributes: {}, relations: {}, paths: {}, paginator: 'none', clientId: 'forbidden' },
} as const satisfies ApiDescriptor

// The same server described without `values`, as an older codegen wrote it.
const older = {
  bookings: {
    attributes: { title: 'string' },
    relations: {},
    paths: { create: '/bookings' },
    paginator: 'none',
    clientId: 'forbidden',
    requestMeta: { create: { fields: { source: 'string' } } },
  },
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

function answering(...replies: { status?: number; body?: unknown }[]) {
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
  const client = createClient<typeof descriptor, Attributes, WriteAttributes>(descriptor, {
    baseUrl: BASE,
    transport,
    atomic: { path: '/operations' },
  })
  return { client, requests }
}

const booking = {
  type: 'bookings',
  id: 'bk-1',
  attributes: { title: 'W' },
  meta: { state: 'held' },
}

describe('meta members limited to listed values', () => {
  it('types a write’s request meta as one of its values, and refuses any other', async () => {
    const { client, requests } = answering({ status: 201, body: { data: booking } })
    await client.bookings.create({ title: 'W' }, { meta: { source: 'import' } })
    expect(JSON.parse(requests[0]!.body!)).toMatchObject({ meta: { source: 'import' } })
    // @ts-expect-error -- source is web, import or api.
    void client.bookings.create({ title: 'W' }, { meta: { source: 'nope' } }).catch(() => 0)
    void client
      .atomic((tx) => [
        // @ts-expect-error -- inside a batch too.
        tx.create({ type: 'bookings', title: 'W' }, { meta: { source: 'x' } }),
      ])
      .catch(() => 0)
  })

  it('types resource object meta, read and written, with an open member’s values', async () => {
    const { client } = answering({ body: { data: booking } })
    const read = await client.bookings.get('bk-1')
    expectTypeOf(read.$meta?.state).toEqualTypeOf<'held' | 'paid' | null | undefined>()
    expectTypeOf(read.$meta?.['other']).toEqualTypeOf<
      'x' | 'y' | 'held' | 'paid' | null | undefined
    >()
    const meta = { meta: { source: 'web' } } as const
    // @ts-expect-error -- channel is desk.
    void client.bookings.create({ title: 'W', $meta: { channel: 'web' } }, meta).catch(() => 0)
  })

  it('types document meta, pivots, identifier meta and relationship meta by their values', async () => {
    const { client } = answering(
      { body: { data: [booking], meta: { region: 'eu' } } },
      {
        body: {
          data: [
            {
              type: 'rooms',
              id: 'rm-1',
              meta: { view: 'sea', pivot: { nights: 1, board: 'full' } },
            },
          ],
        },
      },
      { body: { meta: { outcome: 'moved' } } },
    )
    const list = await client.bookings.list()
    expectTypeOf(list.$meta.region).toEqualTypeOf<'eu' | 'us'>()
    const rooms = await client.bookings.id('bk-1').rooms.get()
    expectTypeOf(rooms[0]!.$edge?.meta?.view).toEqualTypeOf<'sea' | 'garden' | null | undefined>()
    expectTypeOf(rooms[0]!.$edge?.meta?.pivot?.board).toEqualTypeOf<
      'full' | 'half' | null | undefined
    >()
    expectTypeOf(rooms[0]!.$edge?.meta?.pivot?.nights).toEqualTypeOf<number | undefined>()
    const added = await client.bookings
      .id('bk-1')
      .rooms.add([{ type: 'rooms', id: 'rm-1', $pivot: { board: 'half' } }], { meta: { shift: 2 } })
    expectTypeOf(added.outcome).toEqualTypeOf<'moved'>()
    const handle = client.bookings.id('bk-1')
    // @ts-expect-error -- board is full or half.
    void handle.rooms.add([{ type: 'rooms', id: 'rm-1', $pivot: { board: 'none' } }]).catch(() => 0)
    // @ts-expect-error -- shift is 1, 2 or 3.
    void handle.rooms.remove([], { meta: { shift: 4 } }).catch(() => 0)
  })

  it('types action and accepted meta by their values', async () => {
    const { client } = answering(
      { status: 204 },
      { status: 202, body: { data: { type: 'jobs', id: 'j-1' }, meta: { lane: 'fast' } } },
    )
    await client.bookings.id('bk-1').actions.confirm({ meta: { tier: 'gold' } })
    const actions = client.bookings.id('bk-1').actions
    // @ts-expect-error -- tier is gold.
    void actions.confirm({ meta: { tier: 'silver' } }).catch(() => 0)
    const created = await client.bookings.create({ title: 'W' }, { meta: { source: 'api' } })
    if (isAccepted(created)) {
      expectTypeOf(created.meta?.lane).toEqualTypeOf<'fast' | 'slow' | null | undefined>()
    }
  })

  it('types a member by its hint when the descriptor lists no values', () => {
    const client = createClient<typeof older, Attributes, WriteAttributes>(older, { baseUrl: BASE })
    // oxlint-disable-next-line no-constant-condition -- type-level probe only, never run
    if (false as boolean) {
      void client.bookings.create({ title: 'W' }, { meta: { source: 'anything' } })
    }
  })
})
