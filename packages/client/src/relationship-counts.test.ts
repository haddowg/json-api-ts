import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import type { Client } from './result-types'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'
const COUNTABLE = 'https://example.test/profiles/countable/'

// A run counts its items and its retries; `owner` is a to-one it can't count.
const descriptor = {
  runs: {
    attributes: { name: 'string' },
    relations: {
      items: { cardinality: 'many', types: ['items'] },
      retries: { cardinality: 'many', types: ['items'] },
      owner: { cardinality: 'one', types: ['users'] },
    },
    paths: { fetchMany: '/runs', fetchOne: '/runs/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    countable: { tokens: ['_self_', 'items', 'retries'], profile: COUNTABLE },
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
    relations: {},
    paths: { fetchOne: '/users/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

interface Attributes {
  runs: { name: string }
  items: { state: string }
  users: { name: string }
}

function respond(body: unknown) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }
  return {
    requests,
    client: createClient<typeof descriptor, Attributes>(descriptor, { baseUrl: BASE, transport }),
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

// Call-site probes: real calls whose types tsc checks. Declared, never run.
declare const typed: Client<typeof descriptor, Attributes>

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

describe('$count types', () => {
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
