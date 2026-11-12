import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import type { Client } from './result-types'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'
const COUNTABLE = 'https://example.test/profiles/countable/'

// A run counts its items and its retries; `owner` is a to-one it can't count. Reading one run
// counts either, creating one counts only its items, and updating one documents no `withCount`.
// The owner's related read counts the user's runs.
const descriptor = {
  runs: {
    attributes: { name: 'string' },
    relations: {
      items: { cardinality: 'many', types: ['items'] },
      retries: { cardinality: 'many', types: ['items'] },
      owner: {
        cardinality: 'one',
        types: ['users'],
        countable: { tokens: ['runs'], profile: COUNTABLE },
      },
    },
    paths: {
      fetchMany: '/runs',
      fetchOne: '/runs/{id}',
      create: '/runs',
      update: '/runs/{id}',
      fetchRelated: '/runs/{id}/{rel}',
    },
    paginator: 'none',
    clientId: 'forbidden',
    countable: { tokens: ['_self_', 'items', 'retries'], profile: COUNTABLE },
    resourceCountable: {
      fetchOne: { tokens: ['items', 'retries'], profile: COUNTABLE },
      create: { tokens: ['items'], profile: COUNTABLE },
    },
    includable: ['items', 'owner'],
  },
  items: {
    attributes: { state: 'string' },
    relations: {},
    paths: { fetchOne: '/items/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
  users: {
    attributes: { name: 'string' },
    relations: { runs: { cardinality: 'many', types: ['runs'] } },
    paths: { fetchOne: '/users/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    resourceCountable: { fetchOne: { tokens: ['runs'], profile: COUNTABLE } },
  },
} as const satisfies ApiDescriptor

interface Attributes {
  runs: { name: string }
  items: { state: string }
  users: { name: string }
}

interface WriteAttributes {
  runs: { create: { name: string }; update: { name?: string } }
  items: { create: Record<string, never>; update: Record<string, never> }
  users: { create: Record<string, never>; update: Record<string, never> }
}

function respond(body: unknown) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }
  return {
    requests,
    client: createClient<typeof descriptor, Attributes, WriteAttributes>(descriptor, {
      baseUrl: BASE,
      transport,
    }),
  }
}

const run = (relationships: Record<string, unknown>) => ({
  data: [{ type: 'runs', id: '1', attributes: { name: 'Nightly' }, relationships }],
})

describe('$count', () => {
  it("reads a meta-only relationship's total, which has no node property", async () => {
    const { client } = respond(
      run({ items: { links: { related: `${BASE}/runs/1/items` }, meta: { total: 7 } } }),
    )
    const [first] = await client.runs.list({ withCount: ['items'] })
    expect(first!.$count('items')).toBe(7)
    expect((first as unknown as Record<string, unknown>)['items']).toBeUndefined()
  })

  it('reads a data-bearing relationship on the node and on the array', async () => {
    const { client } = respond({
      ...run({
        items: {
          data: [{ type: 'items', id: 'i1' }],
          meta: { total: 3 },
        },
      }),
      included: [{ type: 'items', id: 'i1', attributes: { state: 'failed' } }],
    })
    const [first] = await client.runs.list({ include: ['items'], withCount: ['items'] })
    expect(first!.$count('items')).toBe(3)
    expect(first!.items.$count).toBe(3)
    expect(first!.items[0]!.state).toBe('failed')
  })

  it('is undefined when the relationship carries no total, or one that is not a finite number', async () => {
    const { client } = respond(
      run({
        items: { data: [], meta: { total: '3' } },
        retries: { meta: { total: null } },
      }),
    )
    const [first] = await client.runs.list()
    expect(first!.$count('items')).toBeUndefined()
    expect(first!.items.$count).toBeUndefined()
    expect(first!.$count('retries')).toBeUndefined()
  })

  it('is undefined for a relationship the resource does not render', async () => {
    const { client } = respond(run({}))
    const [first] = await client.runs.list()
    expect(first!.$count('items')).toBeUndefined()
  })

  it('is not enumerable, so spreading a resource leaves it behind', async () => {
    const { client } = respond(run({ items: { meta: { total: 7 } } }))
    const [first] = await client.runs.list({ withCount: ['items'] })
    expect(Object.keys(first!)).not.toContain('$count')
  })
})

const one = (relationships: Record<string, unknown>) => ({
  data: { type: 'runs', id: '1', attributes: { name: 'Nightly' }, relationships },
})

const COUNTED_ACCEPT = `application/vnd.api+json; profile="${COUNTABLE}"`

describe('withCount on one resource', () => {
  it('counts relations on a single read, negotiating the Countable profile', async () => {
    const { client, requests } = respond(one({ items: { meta: { total: 4 } } }))
    const counted = await client.runs.get('1', { withCount: ['items'] })
    expect(requests[0]!.url).toBe(`${BASE}/runs/1?withCount=items`)
    expect(requests[0]!.headers['Accept']).toBe(COUNTED_ACCEPT)
    expect(counted.$count('items')).toBe(4)
  })

  it('counts through a handle read too', async () => {
    const { client, requests } = respond(one({ retries: { meta: { total: 2 } } }))
    const counted = await client.runs.id('1').get({ withCount: ['retries'] })
    expect(requests[0]!.url).toBe(`${BASE}/runs/1?withCount=retries`)
    expect(requests[0]!.headers['Accept']).toBe(COUNTED_ACCEPT)
    expect(counted.$count('retries')).toBe(2)
  })

  it('counts relations on a create, naming the profile in Accept only', async () => {
    const { client, requests } = respond(one({ items: { meta: { total: 0 } } }))
    const created = await client.runs.create({ name: 'Nightly' }, { withCount: ['items'] })
    expect(requests[0]!.method).toBe('POST')
    expect(requests[0]!.url).toBe(`${BASE}/runs?withCount=items`)
    expect(requests[0]!.headers['Accept']).toBe(COUNTED_ACCEPT)
    expect(requests[0]!.headers['Content-Type']).toBe('application/vnd.api+json')
    expect(created.$count('items')).toBe(0)
  })

  it('sends withCount on an update, with the type profile when the update records none', async () => {
    const { client, requests } = respond(one({ items: { meta: { total: 5 } } }))
    const loose = client.runs.id('1').update as (
      patch: unknown,
      opts: { withCount: string[] },
    ) => Promise<unknown>
    await loose({ name: 'Weekly' }, { withCount: ['items'] })
    expect(requests[0]!.method).toBe('PATCH')
    expect(requests[0]!.url).toBe(`${BASE}/runs/1?withCount=items`)
    expect(requests[0]!.headers['Accept']).toBe(COUNTED_ACCEPT)
  })

  it('negotiates nothing for a write without withCount', async () => {
    const { client, requests } = respond(one({}))
    await client.runs.create({ name: 'Nightly' }, { include: ['items'] })
    expect(requests[0]!.url).toBe(`${BASE}/runs?include=items`)
    expect(requests[0]!.headers['Accept']).toBe('application/vnd.api+json')
  })

  it("counts on a to-one related read through the relation's profile", async () => {
    const { client, requests } = respond({
      data: {
        type: 'users',
        id: 'u1',
        attributes: { name: 'Ada' },
        relationships: { runs: { meta: { total: 9 } } },
      },
    })
    const owner = await client.runs.id('1').owner.related({ withCount: ['runs'] })
    expect(requests[0]!.url).toBe(`${BASE}/runs/1/owner?withCount=runs`)
    expect(requests[0]!.headers['Accept']).toBe(COUNTED_ACCEPT)
    expect(owner!.$count('runs')).toBe(9)
  })
})

// Call-site probes: real calls whose types tsc checks. Declared, never run.
declare const typed: Client<typeof descriptor, Attributes, WriteAttributes>

async function narrowsCountedRelations() {
  const [counted] = await typed.runs.list({ withCount: ['_self_', 'items'] })
  expectTypeOf(counted!.$count('items')).toEqualTypeOf<number>()
  expectTypeOf(counted!.$count('retries')).toEqualTypeOf<number | undefined>()
  const [plain] = await typed.runs.list()
  expectTypeOf(plain!.$count('items')).toEqualTypeOf<number | undefined>()
}

async function takesCountableRelations() {
  const [first] = await typed.runs.list()
  // @ts-expect-error `_self_` counts the collection, not a relation
  first!.$count('_self_')
  // @ts-expect-error `owner` is not a countable relation
  first!.$count('owner')
  // @ts-expect-error `owner` is not a count token
  await typed.runs.list({ withCount: ['owner'] })
}

async function typesTheArrayCount() {
  const [first] = await typed.runs.list({ include: ['items'], withCount: ['items'] })
  expectTypeOf(first!.items.$count).toEqualTypeOf<number | undefined>()
  expectTypeOf(first!.items[0]!.state).toEqualTypeOf<string>()
}

async function countsOneResource() {
  const read = await typed.runs.get('1', { withCount: ['items'] })
  expectTypeOf(read.$count('items')).toEqualTypeOf<number>()
  expectTypeOf(read.$count('retries')).toEqualTypeOf<number | undefined>()
  const handle = await typed.runs.id('1').get({ withCount: ['items', 'retries'] })
  expectTypeOf(handle.$count('retries')).toEqualTypeOf<number>()
  const created = await typed.runs.create({ name: 'Nightly' }, { withCount: ['items'] })
  expectTypeOf(created.$count('items')).toEqualTypeOf<number>()
  const plain = await typed.runs.get('1')
  expectTypeOf(plain.$count('items')).toEqualTypeOf<number | undefined>()
}

async function takesOneResourceTokens() {
  // @ts-expect-error `_self_` counts a collection, and one resource has none
  await typed.runs.get('1', { withCount: ['_self_'] })
  // @ts-expect-error `owner` is not a countable relation
  await typed.runs.id('1').get({ withCount: ['owner'] })
  // @ts-expect-error a create counts only the items
  await typed.runs.create({ name: 'Nightly' }, { withCount: ['retries'] })
  // @ts-expect-error `_self_` is never a create token
  await typed.runs.create({ name: 'Nightly' }, { withCount: ['_self_'] })
  // @ts-expect-error the update documents no withCount
  await typed.runs.id('1').update({ name: 'Weekly' }, { withCount: ['items'] })
  // An empty list is still accepted where nothing can be counted.
  await typed.runs.id('1').update({ name: 'Weekly' }, { withCount: [] })
}

describe('$count types', () => {
  it('narrows a single read and a create to number for the relations they count', () => {
    expectTypeOf(countsOneResource).returns.resolves.toBeVoid()
  })

  it('takes only the relations each single-resource operation counts', () => {
    expectTypeOf(takesOneResourceTokens).returns.resolves.toBeVoid()
  })

  it('narrows to number for a relation the withCount tuple names', () => {
    expectTypeOf(narrowsCountedRelations).returns.resolves.toBeVoid()
  })

  it("takes only the type's countable relations, never _self_", () => {
    expectTypeOf(takesCountableRelations).returns.resolves.toBeVoid()
  })

  it('types $count on a to-many relationship array as number | undefined', () => {
    expectTypeOf(typesTheArrayCount).returns.resolves.toBeVoid()
  })
})
