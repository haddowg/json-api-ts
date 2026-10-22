import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import { type PageParams, resolvePaginator, type TypedPage } from './pagination'
import type { Client, ListPageParams, RelationPageParams } from './result-types'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'

// One collection per paginator shape: renamed keys, each canonical kind, and a MultiPaginator
// menu whose arm names (`kind`) differ from their strategies.
const resourceMap = {
  pages: {
    attributes: {},
    relations: {
      menu: { cardinality: 'many', types: ['menus'], pivot: false },
      owner: { cardinality: 'one', types: ['plain'], pivot: false },
    },
    paths: { fetchMany: '/pages', fetchRelated: '/pages/{id}/{rel}' },
    paginator: { strategy: 'page', keys: { number: 'p', size: 'per' } },
    clientId: 'forbidden',
  },
  offsets: {
    attributes: {},
    relations: {},
    paths: { fetchMany: '/offsets' },
    paginator: 'offset',
    clientId: 'forbidden',
  },
  cursors: {
    attributes: {},
    relations: {},
    paths: { fetchMany: '/cursors' },
    paginator: 'cursor',
    clientId: 'forbidden',
  },
  fixeds: {
    attributes: {},
    relations: {},
    paths: { fetchMany: '/fixeds' },
    paginator: { strategy: 'fixed', keys: { number: 'n' } },
    clientId: 'forbidden',
  },
  plain: {
    attributes: {},
    relations: {},
    paths: { fetchMany: '/plain' },
    paginator: 'none',
    clientId: 'forbidden',
  },
  menus: {
    attributes: {},
    relations: {},
    paths: { fetchMany: '/menus' },
    paginator: {
      strategy: 'multi',
      default: 'numbered',
      arms: {
        numbered: 'page',
        stream: { strategy: 'cursor', keys: { after: 'after', before: 'before', size: 'size' } },
      },
    },
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

type Map = typeof resourceMap

const respond = (body: unknown): TransportResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
})

function client(requests: TransportRequest[] = []): Client<Map> {
  return createClient(resourceMap, {
    baseUrl: BASE,
    transport: async (req) => {
      requests.push(req)
      return respond({ data: [], links: { next: `${BASE}/next` } })
    },
  })
}

describe('resolvePaginator', () => {
  it('reads a bare kind with its canonical keys', () => {
    expect(resolvePaginator('page')).toEqual({
      kind: 'page',
      keys: { number: 'number', size: 'size' },
    })
    expect(resolvePaginator('none')).toEqual({ kind: 'none', keys: {} })
    expect(resolvePaginator(undefined)).toEqual({ kind: 'none', keys: {} })
  })

  it('keeps renamed keys', () => {
    expect(resolvePaginator(resourceMap.pages.paginator)).toEqual({
      kind: 'page',
      keys: { number: 'p', size: 'per' },
    })
  })

  it('answers a menu with the picked arm, or the default when none is picked', () => {
    const menu = resourceMap.menus.paginator
    expect(resolvePaginator(menu, { kind: 'stream', after: 'x' })).toEqual({
      kind: 'cursor',
      keys: { after: 'after', before: 'before', size: 'size' },
      arm: 'stream',
    })
    expect(resolvePaginator(menu, { number: 2 })).toEqual({
      kind: 'page',
      keys: { number: 'number', size: 'size' },
    })
    expect(resolvePaginator(menu, { kind: 'unknown' }).kind).toBe('page')
  })
})

describe('paginated reads', () => {
  it('sends renamed keys as given and reports them on $page', async () => {
    const requests: TransportRequest[] = []
    const pages = await client(requests).pages.list({ page: { p: 2, per: 10 } })
    expect(requests[0]!.url).toBe(`${BASE}/pages?page[p]=2&page[per]=10`)
    expect(pages.$page.kind).toBe('page')
    expect(pages.$page.keys).toEqual({ number: 'p', size: 'per' })
  })

  it('sends page[kind] for a picked menu arm and reports that arm', async () => {
    const requests: TransportRequest[] = []
    const menus = await client(requests).menus.list({ page: { kind: 'stream', after: 'c1' } })
    expect(requests[0]!.url).toBe(`${BASE}/menus?page[kind]=stream&page[after]=c1`)
    expect(menus.$page.kind).toBe('cursor')
    expect(menus.$page.arm).toBe('stream')
  })

  it("reports the menu's default strategy when no arm is picked", async () => {
    const requests: TransportRequest[] = []
    const menus = await client(requests).menus.list({ page: { number: 2 } })
    expect(requests[0]!.url).toBe(`${BASE}/menus?page[number]=2`)
    expect(menus.$page.kind).toBe('page')
    expect(menus.$page.arm).toBeUndefined()
  })

  it('keeps the picked arm on the page $next() follows', async () => {
    const menus = await client().menus.list({ page: { kind: 'stream' } })
    const next = await menus.$next()
    expect(next?.$page.kind).toBe('cursor')
    expect(next?.$page.arm).toBe('stream')
  })

  it("resolves a related read's menu pick from the relation's paginator", async () => {
    const requests: TransportRequest[] = []
    const related = await client(requests)
      .pages.id('1')
      .menu.related({ page: { kind: 'stream', size: 5 } })
    expect(requests[0]!.url).toBe(`${BASE}/pages/1/menu?page[kind]=stream&page[size]=5`)
    expect(related.$page.kind).toBe('cursor')
  })
})

describe('page parameter typing', () => {
  it('keys each strategy by its wire names, counts as numbers and cursors as strings', () => {
    expectTypeOf<ListPageParams<Map, 'pages'>>().toEqualTypeOf<{ p?: number; per?: number }>()
    expectTypeOf<ListPageParams<Map, 'offsets'>>().toEqualTypeOf<{
      offset?: number
      limit?: number
    }>()
    expectTypeOf<ListPageParams<Map, 'cursors'>>().toEqualTypeOf<{
      after?: string
      before?: string
      size?: number
    }>()
    expectTypeOf<ListPageParams<Map, 'fixeds'>>().toEqualTypeOf<{ n?: number }>()
    expectTypeOf<ListPageParams<Map, 'plain'>>().toBeNever()
  })

  it('types a menu as one arm tagged by kind, or the default untagged', () => {
    type Menu = ListPageParams<Map, 'menus'>
    expectTypeOf<{ kind: 'stream'; after: string }>().toMatchTypeOf<Menu>()
    expectTypeOf<{ kind: 'numbered'; number: number }>().toMatchTypeOf<Menu>()
    expectTypeOf<{ number: number; size: number }>().toMatchTypeOf<Menu>()
    // A member only another arm reads would make the server pick that arm, so it needs `kind`.
    expectTypeOf<{ after: string }>().not.toMatchTypeOf<Menu>()
  })

  it('types a relation by its paginator, and a to-one as unpageable', () => {
    expectTypeOf<RelationPageParams<Map, 'pages', 'menu'>>().toEqualTypeOf<
      ListPageParams<Map, 'menus'>
    >()
    expectTypeOf<RelationPageParams<Map, 'pages', 'owner'>>().toBeNever()
  })

  it('falls back to a loose record for a descriptor that is not a literal', () => {
    expectTypeOf<PageParams<ApiDescriptor[string]['paginator']>>().toEqualTypeOf<
      Readonly<Record<string, unknown>>
    >()
  })
})

// Declared, never run: the assertions are tsc.
declare const typed: Client<Map>

async function pageTypingFollowsTheAnsweringStrategy() {
  const pages = await typed.pages.list({ page: { p: 1 } })
  expectTypeOf(pages.$page).toEqualTypeOf<
    TypedPage<'page', { readonly number: 'p'; readonly size: 'per' }>
  >()
  expectTypeOf(pages.$page.meta).toEqualTypeOf<
    | {
        currentPage: number
        perPage: number
        from: number
        to?: number
        total?: number
        lastPage?: number
      }
    | undefined
  >()
  const next = await pages.$next()
  expectTypeOf(next).toEqualTypeOf<typeof pages | undefined>()

  const picked = await typed.menus.list({ page: { kind: 'stream', after: 'c' } })
  expectTypeOf(picked.$page.kind).toEqualTypeOf<'cursor'>()
  expectTypeOf(picked.$page.arm).toEqualTypeOf<'stream'>()

  const defaulted = await typed.menus.list({ page: { size: 5 } })
  expectTypeOf(defaulted.$page.kind).toEqualTypeOf<'page'>()
  const unpaged = await typed.menus.list()
  expectTypeOf(unpaged.$page.kind).toEqualTypeOf<'page'>()

  const fixed = await typed.fixeds.list()
  expectTypeOf(fixed.$page.meta).toEqualTypeOf<
    { currentPage: number; total?: number; lastPage?: number } | undefined
  >()

  const related = await typed.pages.id('1').menu.related({ page: { kind: 'stream' } })
  expectTypeOf(related.$page.kind).toEqualTypeOf<'cursor'>()
}

async function pageArgumentsAreChecked() {
  // @ts-expect-error — `number` is renamed to `p` on this collection.
  await typed.pages.list({ page: { number: 1 } })
  // @ts-expect-error — a page size is a number.
  await typed.pages.list({ page: { per: '10' } })
  // @ts-expect-error — an unpaginated collection takes no page.
  await typed.plain.list({ page: { number: 1 } })
  // @ts-expect-error — `after` selects the stream arm, so it must name it.
  await typed.menus.list({ page: { after: 'c' } })
  // @ts-expect-error — `after` belongs to the stream arm, not the numbered one.
  await typed.menus.list({ page: { kind: 'numbered', after: 'c' } })
  // @ts-expect-error — no arm is called `pages`.
  await typed.menus.list({ page: { kind: 'pages' } })
  // @ts-expect-error — a to-one related read does not paginate.
  await typed.pages.id('1').owner.related({ page: { number: 1 } })
}

void pageTypingFollowsTheAnsweringStrategy
void pageArgumentsAreChecked
