import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import type { Client } from './result-types'
import { serializeQuery } from './request'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'
const COUNTABLE = 'https://example.test/profiles/countable/'
const RELATIONSHIP_QUERIES = 'https://example.test/profiles/relationship-queries/'

// A run's `items` declare their own sorts and filters, `states` taking a list. An item's
// `product` declares sorts only, and a run's `owner` declares nothing, so it takes the users
// collection's sorts. `templates` take relatedQuery on neither read, `drafts` only on the
// single read.
const descriptor = {
  runs: {
    attributes: { name: 'string' },
    relations: {
      items: {
        cardinality: 'many',
        types: ['items'],
        sortable: ['position', '-position'],
        filterable: ['state', 'states'],
        listFilters: ['states'],
      },
      owner: { cardinality: 'one', types: ['users'] },
    },
    paths: { fetchMany: '/runs', fetchOne: '/runs/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    countable: { tokens: ['_self_', 'items'], profile: COUNTABLE },
    relatedQuery: { operations: ['fetchMany', 'fetchOne'], profile: RELATIONSHIP_QUERIES },
    includable: ['items', 'items.product', 'owner'],
  },
  items: {
    attributes: { state: 'string' },
    relations: {
      product: { cardinality: 'one', types: ['products'], sortable: ['name', '-name'] },
    },
    paths: { fetchOne: '/items/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
  products: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchOne: '/products/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
  users: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchOne: '/users/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    sortable: ['name', '-name'],
  },
  templates: {
    attributes: { name: 'string' },
    relations: { owner: { cardinality: 'one', types: ['users'] } },
    paths: { fetchMany: '/templates', fetchOne: '/templates/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    includable: ['owner'],
  },
  drafts: {
    attributes: { name: 'string' },
    relations: { owner: { cardinality: 'one', types: ['users'] } },
    paths: { fetchMany: '/drafts', fetchOne: '/drafts/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    relatedQuery: { operations: ['fetchOne'], profile: RELATIONSHIP_QUERIES },
    includable: ['owner'],
  },
} as const satisfies ApiDescriptor

interface Attributes {
  runs: { name: string }
  items: { state: string }
  products: { name: string }
  users: { name: string }
  templates: { name: string }
  drafts: { name: string }
}

function recorder(body: unknown) {
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

const runs = {
  data: [
    {
      type: 'runs',
      id: '1',
      attributes: { name: 'Nightly' },
      relationships: { items: { meta: { total: 2 } } },
    },
  ],
}

describe('relatedQuery serialisation', () => {
  it('sends a filter and sort per include path', () => {
    expect(
      decodeURI(
        serializeQuery({
          relatedQuery: {
            items: { filter: { state: 'failed' }, sort: ['-position', 'state'] },
            'items.product': { sort: 'name' },
          },
        }),
      ),
    ).toBe(
      'relatedQuery[items][filter][state]=failed&relatedQuery[items][sort]=-position%2Cstate&relatedQuery[items.product][sort]=name',
    )
  })

  it('comma-joins a list value unless the path names it a list filter', () => {
    const query = { relatedQuery: { items: { filter: { states: ['a', 'b,c'] } } } }
    expect(decodeURI(serializeQuery(query))).toBe('relatedQuery[items][filter][states]=a%2Cb%2Cc')
    expect(
      decodeURI(
        serializeQuery(query, undefined, (path, key) => path === 'items' && key === 'states'),
      ),
    ).toBe('relatedQuery[items][filter][states][]=a&relatedQuery[items][filter][states][]=b%2Cc')
  })

  it('skips an empty entry and an empty sort', () => {
    expect(serializeQuery({ relatedQuery: { items: {}, owner: { sort: [] } } })).toBe('')
  })

  it("sends a list filter in the array form the path's relation names", async () => {
    const { client, requests } = recorder(runs)
    await client.runs.list({ relatedQuery: { items: { filter: { states: ['failed', 'stuck'] } } } })
    expect(decodeURI(requests[0]!.url)).toBe(
      `${BASE}/runs?relatedQuery[items][filter][states][]=failed&relatedQuery[items][filter][states][]=stuck`,
    )
  })
})

describe('relatedQuery negotiation', () => {
  it('negotiates the Relationship Queries profile on a collection read', async () => {
    const { client, requests } = recorder(runs)
    await client.runs.list({ relatedQuery: { items: { filter: { state: 'failed' } } } })
    expect(requests[0]!.headers['Accept']).toBe(
      `application/vnd.api+json; profile="${RELATIONSHIP_QUERIES}"`,
    )
  })

  it('composes it after the Countable profile when withCount is also set', async () => {
    const { client, requests } = recorder(runs)
    const [run] = await client.runs.list({
      withCount: ['items'],
      relatedQuery: { items: { filter: { state: 'failed' } } },
    })
    expect(decodeURI(requests[0]!.url)).toBe(
      `${BASE}/runs?withCount=items&relatedQuery[items][filter][state]=failed`,
    )
    expect(requests[0]!.headers['Accept']).toBe(
      `application/vnd.api+json; profile="${COUNTABLE} ${RELATIONSHIP_QUERIES}"`,
    )
    expect(run!.$count('items')).toBe(2)
  })

  it('negotiates it on a single read', async () => {
    const { client, requests } = recorder({ data: runs.data[0] })
    await client.runs.get('1', { relatedQuery: { items: { sort: '-position' } } })
    await client.runs.id('1').get({ relatedQuery: { items: { sort: '-position' } } })
    for (const req of requests) {
      expect(decodeURI(req.url)).toBe(`${BASE}/runs/1?relatedQuery[items][sort]=-position`)
      expect(req.headers['Accept']).toBe(
        `application/vnd.api+json; profile="${RELATIONSHIP_QUERIES}"`,
      )
    }
  })

  it('negotiates nothing for an empty relatedQuery', async () => {
    const { client, requests } = recorder(runs)
    await client.runs.list({ relatedQuery: { items: {} } })
    expect(requests[0]!.url).toBe(`${BASE}/runs`)
    expect(requests[0]!.headers['Accept']).toBe('application/vnd.api+json')
  })
})

// Call-site probes: real calls whose types tsc checks. Declared, never run.
declare const typed: Client<typeof descriptor, Attributes>

async function keysEntriesByIncludePath() {
  await typed.runs.list({
    relatedQuery: {
      items: { filter: { state: 'failed', states: ['a'] }, sort: ['-position'] },
      'items.product': { sort: '-name' },
      // `owner` declares no vocabulary of its own, so its entry takes any filter and the users
      // collection's sorts.
      owner: { filter: { anything: 1 }, sort: '-name' },
    },
  })
  // @ts-expect-error `product` is not an include path of runs
  await typed.runs.list({ relatedQuery: { product: { sort: 'name' } } })
}

async function narrowsEachEntry() {
  // @ts-expect-error items declare no `colour` filter
  await typed.runs.list({ relatedQuery: { items: { filter: { colour: 'red' } } } })
  // @ts-expect-error items declare no `state` sort
  await typed.runs.list({ relatedQuery: { items: { sort: 'state' } } })
  // @ts-expect-error an item's product declares no `-position` sort
  await typed.runs.get('1', { relatedQuery: { 'items.product': { sort: '-position' } } })
  // @ts-expect-error `states` takes a list
  await typed.runs.list({ relatedQuery: { items: { filter: { states: 'failed' } } } })
}

async function onlyWhereAdvertised() {
  // @ts-expect-error templates take no relatedQuery
  await typed.templates.list({ relatedQuery: { owner: { sort: 'name' } } })
  // @ts-expect-error drafts take relatedQuery only on the single read
  await typed.drafts.list({ relatedQuery: { owner: { sort: 'name' } } })
  await typed.drafts.get('1', { relatedQuery: { owner: { sort: 'name' } } })
  await typed.drafts.id('1').get({ relatedQuery: { owner: { sort: 'name' } } })
}

async function countsFailedItems() {
  const [run] = await typed.runs.list({
    withCount: ['items'],
    relatedQuery: { items: { filter: { state: 'failed' } } },
  })
  expectTypeOf(run!.$count('items')).toEqualTypeOf<number>()
}

describe('relatedQuery types', () => {
  it("keys entries by the type's include paths, dotted ones included", () => {
    expectTypeOf(keysEntriesByIncludePath).returns.resolves.toBeVoid()
  })

  it("narrows each entry's filter and sort to its relation's vocabulary", () => {
    expectTypeOf(narrowsEachEntry).returns.resolves.toBeVoid()
  })

  it('is absent from a read that does not advertise it', () => {
    expectTypeOf(onlyWhereAdvertised).returns.resolves.toBeVoid()
  })

  it("reads the failed items' count as a number", () => {
    expectTypeOf(countsFailedItems).returns.resolves.toBeVoid()
  })
})
