import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import type { Client } from './result-types'
import { serializeQuery } from './request'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'
const COUNTABLE = 'https://example.test/profiles/countable/'
const RELATIONSHIP_QUERIES = 'https://example.test/profiles/relationship-queries/'
const JSON_API = 'application/vnd.api+json'
const NEGOTIATED = `${JSON_API}; profile="${RELATIONSHIP_QUERIES}"`

// A run's `items` declare their own sorts and filters, `states` taking a list. A run's `owner`
// declares nothing, so it takes the users collection's sorts and filters, and its `checker` is
// read with neither a sort nor a filter and can't be included. `subject` is polymorphic and
// `secret` write-only, so a run's relatedQuery addresses neither. An item's `product` declares
// sorts only. `templates` take relatedQuery nowhere, and `drafts` only on the single read, with no
// recorded relations.
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
        countable: { tokens: ['_self_'], profile: COUNTABLE },
        relatedQuery: true,
      },
      owner: { cardinality: 'one', types: ['users'], relatedQuery: true },
      checker: { cardinality: 'one', types: ['users'], sortable: [], filterable: [] },
      subject: { cardinality: 'one', types: ['items', 'users'], polymorphic: true },
      secret: { cardinality: 'one', types: ['users'], writeOnly: true },
    },
    paths: {
      fetchMany: '/runs',
      fetchOne: '/runs/{id}',
      create: '/runs',
      update: '/runs/{id}',
      fetchRelated: '/runs/{id}/{rel}',
      fetchRelationship: '/runs/{id}/relationships/{rel}',
    },
    paginator: 'none',
    clientId: 'forbidden',
    countable: { tokens: ['_self_', 'items'], profile: COUNTABLE },
    resourceCountable: {
      create: { tokens: ['items'], profile: COUNTABLE },
    },
    relatedQuery: {
      operations: ['fetchMany', 'fetchOne', 'create', 'update'],
      profile: RELATIONSHIP_QUERIES,
      relations: ['items', 'owner', 'checker'],
    },
    includable: ['items', 'items.product', 'owner'],
    actions: {
      rerun: {
        scope: 'resource',
        path: '/runs/{id}/-actions/rerun',
        input: 'none',
        output: 'document',
        outputType: 'runs',
        outputCardinality: 'one',
        relatedQuery: true,
      },
      cancel: {
        scope: 'resource',
        path: '/runs/{id}/-actions/cancel',
        input: 'none',
        output: 'document',
        outputType: 'runs',
        outputCardinality: 'one',
      },
      latest: {
        scope: 'collection',
        path: '/runs/-actions/latest',
        method: 'GET',
        input: 'none',
        output: 'document',
        outputType: 'runs',
        outputCardinality: 'one',
        filterable: ['name'],
        relatedQuery: true,
      },
    },
  },
  items: {
    attributes: { state: 'string' },
    relations: {
      product: {
        cardinality: 'one',
        types: ['products'],
        sortable: ['name', '-name'],
        filterable: ['names'],
        listFilters: ['names'],
      },
      runs: { cardinality: 'many', types: ['runs'] },
    },
    paths: { fetchOne: '/items/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    relatedQuery: { operations: [], profile: RELATIONSHIP_QUERIES, relations: ['product'] },
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
    filterable: ['name', 'roles'],
    listFilters: ['roles'],
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
    relations: {
      owner: { cardinality: 'one', types: ['users'] },
      reviewers: { cardinality: 'many', types: ['users'] },
    },
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

const run = {
  type: 'runs',
  id: '1',
  attributes: { name: 'Nightly' },
  relationships: { items: { meta: { total: 2 } } },
}
const runs = { data: [run] }
const items = { data: [{ type: 'items', id: '7', attributes: { state: 'failed' } }] }

describe('relatedQuery serialisation', () => {
  it('sends a filter and sort per relation', () => {
    expect(
      decodeURI(
        serializeQuery({
          relatedQuery: {
            items: { filter: { state: 'failed' }, sort: ['-position', 'state'] },
            owner: { filter: { name: 'ada' } },
          },
        }),
      ),
    ).toBe(
      'relatedQuery[items][filter][state]=failed&relatedQuery[items][sort]=-position%2Cstate&relatedQuery[owner][filter][name]=ada',
    )
  })

  it('comma-joins a list value unless the relation names it a list filter', () => {
    const query = { relatedQuery: { items: { filter: { states: ['a', 'b,c'] } } } }
    expect(decodeURI(serializeQuery(query))).toBe('relatedQuery[items][filter][states]=a%2Cb%2Cc')
    expect(
      decodeURI(
        serializeQuery(query, undefined, (rel, key) => rel === 'items' && key === 'states'),
      ),
    ).toBe('relatedQuery[items][filter][states][]=a&relatedQuery[items][filter][states][]=b%2Cc')
  })

  it('skips an empty entry and an empty sort', () => {
    expect(serializeQuery({ relatedQuery: { items: {}, owner: { sort: [] } } })).toBe('')
  })

  it("sends a list filter in the array form the relation's vocabulary names", async () => {
    const { client, requests } = recorder(runs)
    await client.runs.list({ relatedQuery: { items: { filter: { states: ['failed', 'stuck'] } } } })
    expect(decodeURI(requests[0]!.url)).toBe(
      `${BASE}/runs?relatedQuery[items][filter][states][]=failed&relatedQuery[items][filter][states][]=stuck`,
    )
  })

  it("matches a relation declaring no filters against its related type's", async () => {
    const { client, requests } = recorder(runs)
    await client.runs.list({ relatedQuery: { owner: { filter: { roles: ['admin', 'ops'] } } } })
    expect(decodeURI(requests[0]!.url)).toBe(
      `${BASE}/runs?relatedQuery[owner][filter][roles][]=admin&relatedQuery[owner][filter][roles][]=ops`,
    )
  })

  it("does not borrow the related type's list filters for a relation read with no filter", async () => {
    const { client, requests } = recorder(runs)
    // An untyped caller can still send one; the empty vocabulary names no list filter.
    const loose = client as unknown as {
      runs: { list(query: { relatedQuery: unknown }): Promise<unknown> }
    }
    await loose.runs.list({ relatedQuery: { checker: { filter: { roles: ['admin', 'ops'] } } } })
    expect(decodeURI(requests[0]!.url)).toBe(
      `${BASE}/runs?relatedQuery[checker][filter][roles]=admin%2Cops`,
    )
  })
})

describe('relatedQuery negotiation', () => {
  it('negotiates the Relationship Queries profile on a collection read', async () => {
    const { client, requests } = recorder(runs)
    await client.runs.list({ relatedQuery: { items: { filter: { state: 'failed' } } } })
    expect(requests[0]!.headers['Accept']).toBe(NEGOTIATED)
  })

  it('composes it after the Countable profile when withCount is also set', async () => {
    const { client, requests } = recorder(runs)
    const [first] = await client.runs.list({
      withCount: ['items'],
      relatedQuery: { items: { filter: { state: 'failed' } } },
    })
    expect(decodeURI(requests[0]!.url)).toBe(
      `${BASE}/runs?withCount=items&relatedQuery[items][filter][state]=failed`,
    )
    expect(requests[0]!.headers['Accept']).toBe(
      `${JSON_API}; profile="${COUNTABLE} ${RELATIONSHIP_QUERIES}"`,
    )
    expect(first!.$count('items')).toBe(2)
  })

  it('negotiates it on a single read', async () => {
    const { client, requests } = recorder({ data: run })
    await client.runs.get('1', { relatedQuery: { items: { sort: '-position' } } })
    await client.runs.id('1').get({ relatedQuery: { items: { sort: '-position' } } })
    for (const req of requests) {
      expect(decodeURI(req.url)).toBe(`${BASE}/runs/1?relatedQuery[items][sort]=-position`)
      expect(req.headers['Accept']).toBe(NEGOTIATED)
    }
  })

  it('negotiates nothing for an empty relatedQuery', async () => {
    const { client, requests } = recorder(runs)
    await client.runs.list({ relatedQuery: { items: {} } })
    expect(requests[0]!.url).toBe(`${BASE}/runs`)
    expect(requests[0]!.headers['Accept']).toBe(JSON_API)
  })
})

describe('relatedQuery on writes', () => {
  it('sends it on a create and names the profile in Accept only', async () => {
    const { client, requests } = recorder({ data: run })
    await client.runs.create(
      { name: 'Nightly' },
      { relatedQuery: { items: { filter: { states: ['failed'] }, sort: '-position' } } },
    )
    expect(requests[0]!.method).toBe('POST')
    expect(decodeURI(requests[0]!.url)).toBe(
      `${BASE}/runs?relatedQuery[items][filter][states][]=failed&relatedQuery[items][sort]=-position`,
    )
    expect(requests[0]!.headers['Accept']).toBe(NEGOTIATED)
    expect(requests[0]!.headers['Content-Type']).toBe(JSON_API)
  })

  it('composes it after the Countable profile on a create', async () => {
    const { client, requests } = recorder({ data: run })
    await client.runs.create(
      { name: 'Nightly' },
      { withCount: ['items'], relatedQuery: { owner: { filter: { name: 'ada' } } } },
    )
    expect(decodeURI(requests[0]!.url)).toBe(
      `${BASE}/runs?withCount=items&relatedQuery[owner][filter][name]=ada`,
    )
    expect(requests[0]!.headers['Accept']).toBe(
      `${JSON_API}; profile="${COUNTABLE} ${RELATIONSHIP_QUERIES}"`,
    )
    expect(requests[0]!.headers['Content-Type']).toBe(JSON_API)
  })

  it('sends it on an update', async () => {
    const { client, requests } = recorder({ data: run })
    await client.runs
      .id('1')
      .update({ name: 'Weekly' }, { relatedQuery: { owner: { filter: { roles: ['admin'] } } } })
    expect(requests[0]!.method).toBe('PATCH')
    expect(decodeURI(requests[0]!.url)).toBe(
      `${BASE}/runs/1?relatedQuery[owner][filter][roles][]=admin`,
    )
    expect(requests[0]!.headers['Accept']).toBe(NEGOTIATED)
    expect(requests[0]!.headers['Content-Type']).toBe(JSON_API)
  })
})

describe('relatedQuery on related reads', () => {
  it("sends it keyed by the related type's relations and negotiates the profile", async () => {
    const { client, requests } = recorder(items)
    await client.runs
      .id('1')
      .items.related({ relatedQuery: { product: { filter: { names: ['a', 'b'] } } } })
    expect(decodeURI(requests[0]!.url)).toBe(
      `${BASE}/runs/1/items?relatedQuery[product][filter][names][]=a&relatedQuery[product][filter][names][]=b`,
    )
    expect(requests[0]!.headers['Accept']).toBe(NEGOTIATED)
  })

  it("composes it after the relation's Countable profile", async () => {
    const { client, requests } = recorder(items)
    await client.runs.id('1').items.related({
      withCount: ['_self_'],
      relatedQuery: { product: { filter: { names: ['a'] } } },
    })
    expect(decodeURI(requests[0]!.url)).toBe(
      `${BASE}/runs/1/items?withCount=_self_&relatedQuery[product][filter][names][]=a`,
    )
    expect(requests[0]!.headers['Accept']).toBe(
      `${JSON_API}; profile="${COUNTABLE} ${RELATIONSHIP_QUERIES}"`,
    )
  })

  it('negotiates nothing on a relationship read', async () => {
    const { client, requests } = recorder({ data: [{ type: 'items', id: '7' }] })
    const loose = client.runs.id('1').rel('items') as unknown as {
      get(query: unknown): Promise<unknown>
    }
    await loose.get({ relatedQuery: { product: { filter: { names: 'a' } } } })
    expect(requests[0]!.headers['Accept']).toBe(JSON_API)
  })
})

describe('relatedQuery on actions', () => {
  it('sends it on an action answering with a resource and negotiates the profile', async () => {
    const { client, requests } = recorder({ data: run })
    await client.runs.id('1').actions.rerun({ relatedQuery: { items: { sort: '-position' } } })
    expect(requests[0]!.method).toBe('POST')
    expect(decodeURI(requests[0]!.url)).toBe(
      `${BASE}/runs/1/-actions/rerun?relatedQuery[items][sort]=-position`,
    )
    expect(requests[0]!.headers['Accept']).toBe(NEGOTIATED)
    expect(requests[0]!.headers['Content-Type']).toBe(JSON_API)
  })

  it("sends it beside a collection action's filters", async () => {
    const { client, requests } = recorder({ data: run })
    await client.runs.actions.latest({
      filter: { name: 'Nightly' },
      relatedQuery: { owner: { filter: { roles: ['ops'] } } },
    })
    expect(requests[0]!.method).toBe('GET')
    expect(decodeURI(requests[0]!.url)).toBe(
      `${BASE}/runs/-actions/latest?filter[name]=Nightly&relatedQuery[owner][filter][roles][]=ops`,
    )
    expect(requests[0]!.headers['Accept']).toBe(NEGOTIATED)
  })
})

// Call-site probes: real calls whose types tsc checks. Declared, never run.
declare const typed: Client<typeof descriptor, Attributes>

async function keysEntriesByRelation() {
  await typed.runs.list({
    relatedQuery: {
      items: { filter: { state: 'failed', states: ['a'] }, sort: ['-position'] },
      // `owner` declares no vocabulary of its own, so its entry takes the users collection's
      // filters. A to-one takes no sort.
      owner: { filter: { name: 'ada', roles: ['admin'] } },
      // `checker` can't be included, but the server sorts and filters it all the same.
      checker: {},
    },
  })
}

async function rejectsWhatTheServerRejects() {
  // @ts-expect-error a dotted path is not a relation
  await typed.runs.list({ relatedQuery: { 'items.product': { sort: 'name' } } })
  // @ts-expect-error `subject` is polymorphic
  await typed.runs.list({ relatedQuery: { subject: {} } })
  // @ts-expect-error `secret` is write-only
  await typed.runs.list({ relatedQuery: { secret: {} } })
  // @ts-expect-error a to-one takes no sort
  await typed.runs.list({ relatedQuery: { owner: { sort: 'name' } } })
  // @ts-expect-error a dotted path is not a relation
  await typed.runs.get('1', { relatedQuery: { 'items.product': {} } })
  // @ts-expect-error a to-one takes no sort
  await typed.runs.id('1').get({ relatedQuery: { owner: { sort: '-name' } } })
}

async function narrowsEachEntry() {
  // @ts-expect-error items declare no `colour` filter
  await typed.runs.list({ relatedQuery: { items: { filter: { colour: 'red' } } } })
  // @ts-expect-error items declare no `state` sort
  await typed.runs.list({ relatedQuery: { items: { sort: 'state' } } })
  // @ts-expect-error `states` takes a list
  await typed.runs.list({ relatedQuery: { items: { filter: { states: 'failed' } } } })
  // @ts-expect-error the users collection takes no `anything` filter
  await typed.runs.list({ relatedQuery: { owner: { filter: { anything: 1 } } } })
  // @ts-expect-error the users collection's `roles` filter takes a list
  await typed.runs.list({ relatedQuery: { owner: { filter: { roles: 'admin' } } } })
  // @ts-expect-error a checker is read with no filter
  await typed.runs.list({ relatedQuery: { checker: { filter: { name: 'ada' } } } })
}

async function typesWrites() {
  await typed.runs.create({ name: 'Nightly' }, { relatedQuery: { items: { sort: '-position' } } })
  await typed.runs.id('1').update({ name: 'Weekly' }, { relatedQuery: { owner: {} } })
  // @ts-expect-error a dotted path is not a relation
  await typed.runs.create({ name: 'x' }, { relatedQuery: { 'items.product': {} } })
  // @ts-expect-error `subject` is polymorphic
  await typed.runs.create({ name: 'x' }, { relatedQuery: { subject: {} } })
  // @ts-expect-error `secret` is write-only
  await typed.runs.id('1').update({ name: 'x' }, { relatedQuery: { secret: {} } })
  // @ts-expect-error a to-one takes no sort
  await typed.runs.id('1').update({ name: 'x' }, { relatedQuery: { owner: { sort: 'name' } } })
}

async function typesRelatedReads() {
  await typed.runs
    .id('1')
    .items.related({ relatedQuery: { product: { filter: { names: ['a'] } } } })
  await typed.runs.id('1').owner.related({ relatedQuery: {} })
  // @ts-expect-error a dotted path is not a relation
  await typed.runs.id('1').items.related({ relatedQuery: { 'product.x': {} } })
  // @ts-expect-error an item's `runs` is not among the relations its relatedQuery addresses
  await typed.runs.id('1').items.related({ relatedQuery: { runs: {} } })
  // @ts-expect-error a to-one takes no sort
  await typed.runs.id('1').items.related({ relatedQuery: { product: { sort: 'name' } } })
  // @ts-expect-error the related read of `checker` takes no relatedQuery
  await typed.runs.id('1').checker.related({ relatedQuery: {} })
  // @ts-expect-error a relationship read takes no relatedQuery
  await typed.runs.id('1').items.get({ relatedQuery: { product: {} } })
}

async function typesActions() {
  await typed.runs.id('1').actions.rerun({ relatedQuery: { items: { sort: 'position' } } })
  await typed.runs.actions.latest({ filter: { name: 'x' }, relatedQuery: { owner: {} } })
  // @ts-expect-error a dotted path is not a relation
  await typed.runs.id('1').actions.rerun({ relatedQuery: { 'items.product': {} } })
  // @ts-expect-error `subject` is polymorphic
  await typed.runs.id('1').actions.rerun({ relatedQuery: { subject: {} } })
  // @ts-expect-error `secret` is write-only
  await typed.runs.actions.latest({ relatedQuery: { secret: {} } })
  // @ts-expect-error a to-one takes no sort
  await typed.runs.actions.latest({ relatedQuery: { owner: { sort: 'name' } } })
  // @ts-expect-error `cancel` takes no relatedQuery
  await typed.runs.id('1').actions.cancel({ relatedQuery: { items: {} } })
}

async function onlyWhereAdvertised() {
  // @ts-expect-error templates take no relatedQuery
  await typed.templates.list({ relatedQuery: { owner: {} } })
  // @ts-expect-error drafts take relatedQuery only on the single read
  await typed.drafts.list({ relatedQuery: { owner: {} } })
  // Without recorded relations, a draft's relatedQuery takes any relation it renders.
  await typed.drafts.get('1', { relatedQuery: { owner: {}, reviewers: { sort: 'name' } } })
  await typed.drafts.id('1').get({ relatedQuery: { owner: { filter: { name: 'ada' } } } })
}

async function countsFailedItems() {
  const [first] = await typed.runs.list({
    withCount: ['items'],
    relatedQuery: { items: { filter: { state: 'failed' } } },
  })
  expectTypeOf(first!.$count('items')).toEqualTypeOf<number>()
}

describe('relatedQuery types', () => {
  it('keys entries by the relations the type addresses, includable or not', () => {
    expectTypeOf(keysEntriesByRelation).returns.resolves.toBeVoid()
  })

  it('rejects dotted paths, polymorphic and write-only relations, and sort on a to-one', () => {
    expectTypeOf(rejectsWhatTheServerRejects).returns.resolves.toBeVoid()
  })

  it("narrows each entry's filter and sort to its relation's vocabulary", () => {
    expectTypeOf(narrowsEachEntry).returns.resolves.toBeVoid()
  })

  it('types it on create and update', () => {
    expectTypeOf(typesWrites).returns.resolves.toBeVoid()
  })

  it('types it on a related read by the related type', () => {
    expectTypeOf(typesRelatedReads).returns.resolves.toBeVoid()
  })

  it('types it on an action by its output type', () => {
    expectTypeOf(typesActions).returns.resolves.toBeVoid()
  })

  it('is absent from an operation that does not advertise it', () => {
    expectTypeOf(onlyWhereAdvertised).returns.resolves.toBeVoid()
  })

  it("reads the failed items' count as a number", () => {
    expectTypeOf(countsFailedItems).returns.resolves.toBeVoid()
  })
})
