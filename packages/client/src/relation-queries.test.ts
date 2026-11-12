import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import type { RelationFilterQuery, RelationSortQuery } from './result-types'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'

// Shaped like codegen output for core's witness: `sponsors` is a polymorphic to-many identified
// by its link rows, with pivot fields and the filters and sorts its reads declare over them.
// `attachments` is polymorphic too but declares none, `tags` is monomorphic and declares none,
// `author` is a to-one whose reads take no sort and no filter, and `editor` has no read at all.
const descriptor = {
  articles: {
    attributes: { title: 'string' },
    relations: {
      sponsors: {
        cardinality: 'many',
        types: ['people', 'images'],
        polymorphic: true,
        pivot: true,
        readPivot: { fields: { rank: 'integer', since: 'date-time' }, nullable: ['since'] },
        writePivot: { fields: { rank: 'integer' } },
        mutations: { add: true, remove: true, replace: true },
        sortable: ['rank', '-rank', 'since', '-since'],
        filterable: ['minRank', 'ranks'],
        listFilters: ['ranks'],
      },
      attachments: {
        cardinality: 'many',
        types: ['people', 'images'],
        polymorphic: true,
        pivot: false,
        mutations: { add: true, remove: true, replace: true },
      },
      tags: {
        cardinality: 'many',
        types: ['people'],
        pivot: false,
        mutations: { add: true, remove: true, replace: true },
      },
      author: {
        cardinality: 'one',
        types: ['people'],
        pivot: false,
        mutations: { set: true },
        sortable: [],
        filterable: [],
      },
      editor: {
        cardinality: 'one',
        types: ['people'],
        pivot: false,
        writeOnly: true,
        related: false,
        relationship: false,
        mutations: {},
        sortable: [],
        filterable: [],
      },
    },
    paths: {
      fetchOne: '/articles/{id}',
      fetchRelated: '/articles/{id}/{rel}',
      fetchRelationship: '/articles/{id}/relationships/{rel}',
    },
    paginator: 'none',
    clientId: 'forbidden',
  },
  people: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchOne: '/people/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    sortable: ['name', '-name'],
    filterable: ['name', 'roles'],
    listFilters: ['roles'],
  },
  images: {
    attributes: { url: 'string' },
    relations: {},
    paths: { fetchOne: '/images/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

interface Attributes {
  articles: { title: string }
  people: { name: string }
  images: { url: string }
}

function recorder(body: unknown) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }
  return { requests, transport }
}

const linkage = {
  data: [
    { type: 'people', id: 'per-1', meta: { pivot: { rank: 1, since: '2026-01-01T00:00:00Z' } } },
    { type: 'images', id: 'img-1', meta: { pivot: { rank: 2, since: null } } },
  ],
}

const client = (transport: (req: TransportRequest) => Promise<TransportResponse>) =>
  createClient<typeof descriptor, Attributes>(descriptor, { baseUrl: BASE, transport })

type Handle = ReturnType<ReturnType<typeof client>['articles']['id']>
type Query<R extends keyof Handle> = Handle[R] extends { get: (query?: infer Q) => unknown }
  ? NonNullable<Q>
  : never
type RelatedQuery<R extends keyof Handle> = Handle[R] extends {
  related: (query?: infer Q) => unknown
}
  ? NonNullable<Q>
  : never

describe("a relation's own sorts and filters", () => {
  it('sends them on the relationship and related reads', async () => {
    const { requests, transport } = recorder(linkage)
    const sponsors = client(transport).articles.id('1').sponsors
    await sponsors.get({ sort: ['-rank', 'since'], filter: { minRank: 2 } })
    await sponsors.related({ sort: '-since', filter: { minRank: 1 } })
    expect(requests.map((req) => decodeURI(req.url))).toEqual([
      `${BASE}/articles/1/relationships/sponsors?filter[minRank]=2&sort=-rank%2Csince`,
      `${BASE}/articles/1/sponsors?filter[minRank]=1&sort=-since`,
    ])
  })

  it("sends a list filter in the array form the relation's descriptor names", async () => {
    const { requests, transport } = recorder(linkage)
    await client(transport)
      .articles.id('1')
      .sponsors.get({ filter: { ranks: ['1', '2,3'] } })
    expect(decodeURI(requests[0]!.url)).toBe(
      `${BASE}/articles/1/relationships/sponsors?filter[ranks][]=1&filter[ranks][]=2%2C3`,
    )
  })

  it('narrows sort and filter to what the relation declares', () => {
    expectTypeOf<Query<'sponsors'>['sort']>().toEqualTypeOf<
      | 'rank'
      | '-rank'
      | 'since'
      | '-since'
      | readonly ('rank' | '-rank' | 'since' | '-since')[]
      | undefined
    >()
    expectTypeOf<RelatedQuery<'sponsors'>['sort']>().toEqualTypeOf<Query<'sponsors'>['sort']>()
    type Filter = NonNullable<Query<'sponsors'>['filter']>
    expectTypeOf<Filter['minRank']>().toEqualTypeOf<unknown>()
    expectTypeOf<Filter['ranks']>().toEqualTypeOf<readonly string[] | undefined>()
    expectTypeOf<'name'>().not.toMatchTypeOf<NonNullable<Query<'sponsors'>['sort']>>()
    expectTypeOf<keyof NonNullable<Query<'sponsors'>['filter']>>().toEqualTypeOf<
      'minRank' | 'ranks'
    >()
  })

  it('leaves a polymorphic relation declaring none open', () => {
    expectTypeOf<Query<'attachments'>['sort']>().toEqualTypeOf<
      string | readonly string[] | undefined
    >()
    expectTypeOf<Query<'attachments'>['filter']>().toEqualTypeOf<
      Record<string, unknown> | undefined
    >()
  })

  it("types a monomorphic relation declaring none with its related type's filters", () => {
    type Filter = NonNullable<Query<'tags'>['filter']>
    expectTypeOf<keyof Filter>().toEqualTypeOf<'name' | 'roles'>()
    expectTypeOf<Filter['name']>().toEqualTypeOf<unknown>()
    expectTypeOf<Filter['roles']>().toEqualTypeOf<readonly string[] | undefined>()
    expectTypeOf<RelatedQuery<'tags'>['filter']>().toEqualTypeOf<Query<'tags'>['filter']>()
  })

  it("types a monomorphic relation declaring none with its related type's sorts", () => {
    type Sort = 'name' | '-name' | readonly ('name' | '-name')[] | undefined
    expectTypeOf<Query<'tags'>['sort']>().toEqualTypeOf<Sort>()
    expectTypeOf<RelatedQuery<'tags'>['sort']>().toEqualTypeOf<Sort>()
    expectTypeOf<'rank'>().not.toMatchTypeOf<NonNullable<Query<'tags'>['sort']>>()
  })

  it('types `sort` and `filter` as never on a relation whose reads take none', () => {
    expectTypeOf<Query<'author'>['sort']>().toEqualTypeOf<undefined>()
    expectTypeOf<RelatedQuery<'author'>['sort']>().toEqualTypeOf<undefined>()
    expectTypeOf<Query<'author'>['filter']>().toEqualTypeOf<undefined>()
    expectTypeOf<RelatedQuery<'author'>['filter']>().toEqualTypeOf<undefined>()
  })

  it('types `sort` and `filter` as never on a relation with no read', () => {
    expectTypeOf<Handle['editor']['get']>().toBeNever()
    expectTypeOf<Handle['editor']['related']>().toBeNever()
    expectTypeOf<RelationSortQuery<typeof descriptor, 'articles', 'editor'>>().toBeNever()
    expectTypeOf<RelationFilterQuery<typeof descriptor, 'articles', 'editor'>>().toBeNever()
  })

  it("matches a monomorphic relation's list filters against its related type", async () => {
    const { requests, transport } = recorder({ data: [] })
    await client(transport)
      .articles.id('1')
      .tags.related({ filter: { roles: ['a', 'b'] } })
    expect(decodeURI(requests[0]!.url)).toBe(
      `${BASE}/articles/1/tags?filter[roles][]=a&filter[roles][]=b`,
    )
  })
})

describe('the pivot of a polymorphic relation', () => {
  it('types each member’s $pivot from its readPivot', async () => {
    const { transport } = recorder(linkage)
    const members = await client(transport).articles.id('1').sponsors.get()
    expect(members.map((member) => member.$pivot)).toEqual([
      { rank: 1, since: '2026-01-01T00:00:00Z' },
      { rank: 2, since: null },
    ])
    type Pivot = NonNullable<(typeof members)[number]['$pivot']>
    expectTypeOf<Pivot['rank']>().toEqualTypeOf<number>()
    expectTypeOf<Pivot['since']>().toEqualTypeOf<string | null>()
    type Related = Awaited<ReturnType<Handle['sponsors']['related']>>[number]
    expectTypeOf<NonNullable<Related['$pivot']>['rank']>().toEqualTypeOf<number>()
  })

  it('sends a member’s $pivot as its meta.pivot', async () => {
    const { requests, transport } = recorder(linkage)
    await client(transport)
      .articles.id('1')
      .sponsors.add([
        { type: 'people', id: 'per-1', $pivot: { rank: 3 } },
        { type: 'images', id: 'img-1' },
      ])
    expect(JSON.parse(requests[0]!.body as string)).toEqual({
      data: [
        { type: 'people', id: 'per-1', meta: { pivot: { rank: 3 } } },
        { type: 'images', id: 'img-1' },
      ],
    })
  })

  it('types the writable pivot fields on a write', () => {
    type Add = Parameters<Handle['sponsors']['add']>[0][number]
    expectTypeOf<NonNullable<Add['$pivot']>['rank']>().toEqualTypeOf<number>()
  })
})

// Call-site probes: real calls whose types tsc checks. Declared, never run.
declare const typed: ReturnType<typeof client>

async function sortsEachRelationAsItsReadsDo() {
  await typed.articles.id('1').sponsors.related({ sort: ['-since', 'rank'] })
  await typed.articles.id('1').tags.related({ sort: '-name' })
  await typed.articles.id('1').attachments.get({ sort: 'anything' })
  await typed.articles.id('1').author.related()
  // @ts-expect-error a to-one's reads take no sort
  await typed.articles.id('1').author.related({ sort: 'name' })
  // @ts-expect-error a to-one's reads take no sort
  await typed.articles.id('1').author.get({ sort: [] })
  // @ts-expect-error `title` is not a sort of the people collection
  await typed.articles.id('1').tags.get({ sort: 'title' })
  // @ts-expect-error `name` is not a sort the sponsors relation records
  await typed.articles.id('1').sponsors.get({ sort: 'name' })
}

async function filtersEachRelationAsItsReadsDo() {
  await typed.articles.id('1').sponsors.related({ filter: { minRank: 1, ranks: ['1'] } })
  await typed.articles.id('1').tags.related({ filter: { name: 'ada', roles: ['admin'] } })
  await typed.articles.id('1').attachments.get({ filter: { anything: 1 } })
  // @ts-expect-error `name` is not a filter the sponsors relation records
  await typed.articles.id('1').sponsors.get({ filter: { name: 'ada' } })
  // @ts-expect-error `title` is not a filter of the people collection
  await typed.articles.id('1').tags.get({ filter: { title: 'x' } })
  // @ts-expect-error the people collection's `roles` filter takes a list
  await typed.articles.id('1').tags.related({ filter: { roles: 'admin' } })
  // @ts-expect-error a to-one's reads take no filter
  await typed.articles.id('1').author.related({ filter: { name: 'ada' } })
  // @ts-expect-error a to-one's reads take no filter
  await typed.articles.id('1').author.get({ filter: {} })
}

describe("a relation's sort and filter at the call site", () => {
  it("takes what each relation's reads take", () => {
    expectTypeOf(sortsEachRelationAsItsReadsDo).returns.resolves.toBeVoid()
    expectTypeOf(filtersEachRelationAsItsReadsDo).returns.resolves.toBeVoid()
  })
})
