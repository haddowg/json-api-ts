import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import type { SingletonAccessor, TypeAccessor } from './result-types'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'
const RELATIONSHIP_QUERIES = 'https://example.test/profiles/relationship-queries/'
const JSON_API = 'application/vnd.api+json'

// The caller's inbox, served at /inbox with no id, as the codegen describes core's witness.
const descriptor = {
  inboxes: {
    attributes: { seenUpTo: 'date-time', unread: 'integer', unseen: 'integer' },
    relations: {
      owner: {
        cardinality: 'one',
        types: ['people'],
        pivot: false,
        relatedQuery: true,
        mutations: { set: true },
        sortable: [],
      },
    },
    paths: {
      fetchOne: '/inbox',
      fetchRelated: '/inbox/{rel}',
      fetchRelationship: '/inbox/relationships/{rel}',
      update: '/inbox',
    },
    paginator: 'none',
    clientId: 'forbidden',
    singleton: true,
    relatedQuery: {
      operations: ['fetchOne', 'update'],
      profile: RELATIONSHIP_QUERIES,
      relations: ['owner'],
    },
    actions: {
      'mark-all-read': {
        scope: 'resource',
        path: '/inbox/-actions/mark-all-read',
        input: 'none',
        output: 'document',
        outputType: 'inboxes',
        outputCardinality: 'one',
        relatedQuery: true,
      },
    },
  },
  people: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchMany: '/people', fetchOne: '/people/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    filterable: ['name'],
  },
} as const satisfies ApiDescriptor

interface Attributes {
  inboxes: { seenUpTo: string | null; unread: number | null; unseen: number | null }
  people: { name: string }
}

interface WriteAttributes {
  inboxes: { update: { seenUpTo?: string } }
}

const inbox = {
  type: 'inboxes',
  id: '42',
  attributes: { seenUpTo: null, unread: 5, unseen: 3 },
  relationships: { owner: { data: { type: 'people', id: 'per-1' } } },
}

function recorder(body: unknown = { data: inbox }) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }
  const client = createClient<typeof descriptor, Attributes, WriteAttributes>(descriptor, {
    baseUrl: BASE,
    transport,
  })
  return { requests, client }
}

describe('a singleton type', () => {
  it('reads the resource at its own path, which still carries its id', async () => {
    const { requests, client } = recorder()
    const read = await client.inboxes.get()
    expect(requests[0]).toMatchObject({ method: 'GET', url: `${BASE}/inbox` })
    expect(read.id).toBe('42')
    expect(read.unread).toBe(5)
  })

  it('negotiates Relationship Queries for a relatedQuery on the read', async () => {
    const { requests, client } = recorder()
    await client.inboxes.get({ relatedQuery: { owner: { filter: { name: 'Ada' } } } })
    expect(decodeURI(requests[0]!.url)).toBe(`${BASE}/inbox?relatedQuery[owner][filter][name]=Ada`)
    expect(requests[0]!.headers['Accept']).toBe(`${JSON_API}; profile="${RELATIONSHIP_QUERIES}"`)
  })

  it('updates at its own path with the id the input carries in the body', async () => {
    const { requests, client } = recorder()
    const read = await client.inboxes.get()
    await client.inboxes.update({ id: read.id, seenUpTo: '2026-11-16T09:30:00+00:00' })
    expect(requests[1]).toMatchObject({ method: 'PATCH', url: `${BASE}/inbox` })
    expect(JSON.parse(requests[1]!.body!)).toEqual({
      data: { type: 'inboxes', id: '42', attributes: { seenUpTo: '2026-11-16T09:30:00+00:00' } },
    })
  })

  it('refuses an update without an id before sending anything', async () => {
    const { requests, client } = recorder()
    const update = client.inboxes.update as (input: object) => Promise<unknown>
    await expect(update({ seenUpTo: '2026-11-16T09:30:00+00:00' })).rejects.toThrow(
      'Updating the "inboxes" singleton needs its id in the input',
    )
    expect(requests).toHaveLength(0)
  })

  it('reaches its relations and actions under its own path', async () => {
    const { requests, client } = recorder()
    await client.inboxes.owner.get()
    await client.inboxes.rel('owner').related()
    await client.inboxes.owner.set({ type: 'people', id: 'per-2' })
    await client.inboxes.actions['mark-all-read']()
    expect(requests.map((req) => `${req.method} ${req.url}`)).toEqual([
      `GET ${BASE}/inbox/relationships/owner`,
      `GET ${BASE}/inbox/owner`,
      `PATCH ${BASE}/inbox/relationships/owner`,
      `POST ${BASE}/inbox/-actions/mark-all-read`,
    ])
    expect(JSON.parse(requests[2]!.body!)).toEqual({ data: { type: 'people', id: 'per-2' } })
  })

  it('has no collection, create, id or delete', () => {
    const { client } = recorder()
    const accessor = client.inboxes as unknown as Record<string, unknown>
    for (const member of ['list', 'create', 'id', 'delete']) {
      expect(accessor[member]).toBeUndefined()
    }
    expect(client.inboxes.type).toBe('inboxes')
    expect(typeof client.people.id('per-1').get).toBe('function')
  })

  it('is typed as a singleton accessor', () => {
    const { client } = recorder()
    expectTypeOf(client.inboxes).toEqualTypeOf<
      SingletonAccessor<typeof descriptor, Attributes, WriteAttributes, 'inboxes'>
    >()
    expectTypeOf(client.people).toEqualTypeOf<
      TypeAccessor<typeof descriptor, Attributes, WriteAttributes, 'people'>
    >()
    expectTypeOf(client.inboxes.update).parameter(0).toHaveProperty('id').toEqualTypeOf<string>()
    expectTypeOf(client.inboxes.update).parameter(0).toHaveProperty('seenUpTo')
    expectTypeOf(client.inboxes.update).parameter(0).toHaveProperty('owner')
    // @ts-expect-error a singleton has no id handle
    void client.inboxes.id
    // @ts-expect-error nor a collection read
    void client.inboxes.list
    // @ts-expect-error nor a delete
    void client.inboxes.delete
    // @ts-expect-error the update needs the resource's id
    const withoutId = () => client.inboxes.update({ seenUpTo: '2026-11-16T09:30:00+00:00' })
    expect(withoutId).toBeTypeOf('function')
  })
})
