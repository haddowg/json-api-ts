import {
  type ApiDescriptor,
  createClient,
  type DefaultActionTypes,
  type DefaultWriteAttributes,
  nextPageParams,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import {
  type InfiniteData,
  InfiniteQueryObserver,
  type InfiniteQueryObserverOptions,
  matchQuery,
  QueryClient,
  type SkipToken,
  skipToken,
} from '@tanstack/query-core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { INFINITE_SEGMENT, keyHasPrefix, operationKey, parentRelationReadKeys } from './keys'
import {
  addRelationshipMutationOptions,
  createMutationOptions,
  deleteMutationOptions,
  type MutationOptions,
} from './mutate'
import {
  createQueryApi,
  infiniteListQueryOptions,
  infiniteRelatedQueryOptions,
  type ListPageParam,
  type ListResult,
  type ReadError,
} from './read'

const BASE = 'https://music.example'

const descriptor = {
  albums: {
    attributes: { title: 'string' },
    relations: {
      artist: { cardinality: 'one', types: ['artists'], pivot: false, mutations: { set: true } },
      tracks: {
        cardinality: 'many',
        types: ['tracks'],
        pivot: false,
        mutations: { add: true, remove: true, replace: true },
      },
    },
    paths: {
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
      fetchRelationship: '/albums/{id}/relationships/{rel}',
      create: '/albums',
      delete: '/albums/{id}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['artist'],
  },
  artists: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchMany: '/artists', fetchOne: '/artists/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
  tracks: {
    attributes: { title: 'string' },
    relations: {},
    paths: { fetchMany: '/tracks', fetchOne: '/tracks/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
  inboxes: {
    attributes: { unread: 'number' },
    relations: {
      owner: { cardinality: 'one', types: ['artists'], pivot: false },
      messages: { cardinality: 'many', types: ['tracks'], pivot: false },
    },
    paths: { fetchOne: '/inbox', fetchRelated: '/inbox/{rel}' },
    paginator: 'none',
    clientId: 'forbidden',
    singleton: true,
  },
} as const satisfies ApiDescriptor
type D = typeof descriptor

type Attributes = {
  albums: { title: string }
  artists: { name: string }
  tracks: { title: string }
  inboxes: { unread: number }
}
type ErrorCode = 'ALBUM_GONE'

const TOTAL = 5

/**
 * A paged collection of `type` at `path`: `page[number]` (default 1) of `page[size]` (default 2)
 * out of {@link TOTAL} resources, with `prev`/`next` links carrying both members.
 */
function pageOf(type: string, url: URL) {
  const number = Number(url.searchParams.get('page[number]') ?? '1')
  const size = Number(url.searchParams.get('page[size]') ?? '2')
  const first = (number - 1) * size
  const ids = Array.from({ length: TOTAL }, (_, i) => String(i + 1)).slice(first, first + size)
  const link = (n: number) => `${BASE}${url.pathname}?page%5Bnumber%5D=${n}&page%5Bsize%5D=${size}`
  return {
    data: ids.map((id) => ({ type, id, attributes: { title: `${type} ${id}` } })),
    links: {
      ...(number > 1 ? { prev: link(number - 1) } : {}),
      ...(first + size < TOTAL ? { next: link(number + 1) } : {}),
    },
    meta: { page: { currentPage: number, perPage: size, from: first + 1 } },
  }
}

const reply = (body: unknown): TransportResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
})

function makeClient() {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/albums') {
      return reply(pageOf('albums', url))
    }
    if (
      req.method === 'GET' &&
      (url.pathname === '/albums/1/tracks' || url.pathname === '/inbox/messages')
    ) {
      return reply(pageOf('tracks', url))
    }
    if (req.method === 'POST' && url.pathname === '/albums') {
      return reply({ data: { type: 'albums', id: '9', attributes: { title: 'New' } } })
    }
    if (req.method === 'POST' && url.pathname === '/albums/1/relationships/tracks') {
      return reply({ data: [{ type: 'tracks', id: '1' }] })
    }
    if (req.method === 'DELETE') {
      return { status: 204, headers: {}, body: '' }
    }
    return { status: 404, headers: {}, body: JSON.stringify({ errors: [{ status: '404' }] }) }
  }
  const client = createClient<
    D,
    Attributes,
    DefaultWriteAttributes<D>,
    DefaultActionTypes,
    ErrorCode
  >(descriptor, { baseUrl: BASE, transport })
  return { client, requests }
}

/** What `useInfiniteQuery`/`injectInfiniteQuery` infer from options, via query-core's own types. */
function inferred<TQueryFnData, TError, TQueryKey extends readonly unknown[], TPageParam>(
  options: InfiniteQueryObserverOptions<
    TQueryFnData,
    TError,
    InfiniteData<TQueryFnData, TPageParam>,
    TQueryKey,
    TPageParam
  >,
): { page: TQueryFnData; error: TError; pageParam: TPageParam } {
  return options as never
}

function runMutation<TData, TVars, TContext>(
  qc: QueryClient,
  options: MutationOptions<TData, TVars, TContext>,
  variables: TVars,
): Promise<TData> {
  return qc
    .getMutationCache()
    .build<TData, unknown, TVars, TContext>(qc, options as never)
    .execute(variables)
}

/** Subscribe an observer and wait until it holds data and is idle. */
async function settle(observer: {
  subscribe(listener: (result: { data: unknown; fetchStatus: string }) => void): () => void
}) {
  await new Promise<void>((resolve) => {
    const unsubscribe = observer.subscribe((result) => {
      if (result.data !== undefined && result.fetchStatus === 'idle') {
        unsubscribe()
        resolve()
      }
    })
  })
}

describe('infiniteListQueryOptions', () => {
  it('reads the first page under the list key plus $infinite', async () => {
    const { client, requests } = makeClient()
    const options = infiniteListQueryOptions(client, 'albums')
    expect(options.queryKey).toEqual(['albums', 'fetchMany', INFINITE_SEGMENT])
    expect(options.initialPageParam).toBeUndefined()

    const data = await new QueryClient().fetchInfiniteQuery(options)
    expect(data.pages).toHaveLength(1)
    expect(data.pages[0]?.map((album) => album.id)).toEqual(['1', '2'])
    expect(data.pageParams).toEqual([undefined])
    expect(requests[0]?.url).not.toContain('page')
    expect(Object.hasOwn(options, 'retry')).toBe(false)
  })

  it("starts at the query's page and keeps its other members in the key", () => {
    const { client } = makeClient()
    const options = infiniteListQueryOptions(client, 'albums', {
      include: ['artist'],
      page: { size: 3 },
    })
    expect(options.initialPageParam).toEqual({ size: 3 })
    expect(options.queryKey).toEqual([
      'albums',
      'fetchMany',
      { include: ['artist'], page: { size: 3 } },
      INFINITE_SEGMENT,
    ])
  })

  it('reads the next page from the next link, replacing the whole page param', async () => {
    const { client, requests } = makeClient()
    const qc = new QueryClient()
    const observer = new InfiniteQueryObserver(
      qc,
      createQueryApi(client).albums.infinite({ include: ['artist'], page: { size: 2 } }),
    )
    await settle(observer)
    expect(observer.getCurrentResult().hasNextPage).toBe(true)

    await observer.fetchNextPage()
    await observer.fetchNextPage()
    const result = observer.getCurrentResult()
    expect(result.data?.pages.map((page) => page.map((album) => album.id))).toEqual([
      ['1', '2'],
      ['3', '4'],
      ['5'],
    ])
    expect(result.data?.pageParams).toEqual([
      { size: 2 },
      { number: 2, size: 2 },
      { number: 3, size: 2 },
    ])
    expect(result.hasNextPage).toBe(false)
    expect(result.hasPreviousPage).toBe(false)
    const second = new URL(requests[1]?.url ?? '')
    expect(second.searchParams.get('page[number]')).toBe('2')
    expect(second.searchParams.get('page[size]')).toBe('2')
    expect(second.searchParams.get('include')).toBe('artist')
    // Each page passes TanStack's abort signal to the read.
    expect(requests.every((request) => request.signal instanceof AbortSignal)).toBe(true)
    observer.destroy()
  })

  it('reads the previous page from the prev link', async () => {
    const { client } = makeClient()
    const observer = new InfiniteQueryObserver(
      new QueryClient(),
      infiniteListQueryOptions(client, 'albums', { page: { number: 2, size: 2 } }),
    )
    await settle(observer)
    expect(observer.getCurrentResult().hasPreviousPage).toBe(true)
    await observer.fetchPreviousPage()
    expect(observer.getCurrentResult().data?.pages.map((page) => page[0]?.id)).toEqual(['1', '3'])
    expect(observer.getCurrentResult().hasPreviousPage).toBe(false)
    observer.destroy()
  })

  it('types the pages, page params, key and error', async () => {
    const { client } = makeClient()
    const options = createQueryApi(client).albums.infinite({ page: { size: 2 } })
    type Page = ListResult<D, Attributes, 'albums', [], {}, { readonly size: 2 }>
    const what = inferred(options)
    expectTypeOf(what.error).toEqualTypeOf<ReadError<ErrorCode>>()
    expectTypeOf(what.pageParam).toEqualTypeOf<ListPageParam<D, 'albums'>>()
    expectTypeOf(what.page).toEqualTypeOf<Page>()
    expectTypeOf<(typeof what.page)[number]['title']>().toEqualTypeOf<string>()

    const qc = new QueryClient()
    const data = await qc.fetchInfiniteQuery(options)
    expectTypeOf(data.pages[0]?.$page.kind).toEqualTypeOf<'page' | undefined>()
    expectTypeOf(qc.getQueryData(options.queryKey)).toEqualTypeOf<
      InfiniteData<Page, ListPageParam<D, 'albums'>> | undefined
    >()

    // A hand-written getNextPageParam reads the client's helper with no cast.
    inferred({ ...options, getNextPageParam: (last) => nextPageParams(last) })
    // @ts-expect-error a page size is a number
    createQueryApi(client).albums.infinite({ page: { size: '2' } })
  })

  it('skips in place of the query', async () => {
    const { client, requests } = makeClient()
    const options = createQueryApi(client).albums.infinite(skipToken)
    expect(options.queryFn).toBe(skipToken)
    expect(options.queryKey).toEqual(['albums', 'fetchMany', { $skip: true }, INFINITE_SEGMENT])
    expectTypeOf(options.queryFn).toExtend<SkipToken | ((...args: never[]) => unknown)>()
    expect(infiniteListQueryOptions(client, 'albums', skipToken).queryKey).toEqual(options.queryKey)
    const observer = new InfiniteQueryObserver(new QueryClient(), options)
    const unsubscribe = observer.subscribe(() => undefined)
    await Promise.resolve()
    expect(observer.getCurrentResult().fetchStatus).toBe('idle')
    expect(requests).toHaveLength(0)
    unsubscribe()
  })
})

describe('infiniteRelatedQueryOptions', () => {
  it("pages through a to-many relation's related collection", async () => {
    const { client, requests } = makeClient()
    const options = infiniteRelatedQueryOptions(client, 'albums', '1', 'tracks', {
      page: { size: 2 },
    })
    expect(options.queryKey).toEqual([
      'albums',
      'fetchRelated',
      '1',
      'tracks',
      { page: { size: 2 } },
      INFINITE_SEGMENT,
    ])
    const observer = new InfiniteQueryObserver(new QueryClient(), options)
    await settle(observer)
    await observer.fetchNextPage()
    expect(observer.getCurrentResult().data?.pages.map((page) => page.map((t) => t.id))).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
    expect(new URL(requests[1]?.url ?? '').pathname).toBe('/albums/1/tracks')
    expectTypeOf(inferred(options).error).toEqualTypeOf<ReadError<ErrorCode>>()
    observer.destroy()
  })

  it('takes to-many relations only', () => {
    const { client } = makeClient()
    // @ts-expect-error a to-one related read has no pages
    infiniteRelatedQueryOptions(client, 'albums', '1', 'artist')
    // @ts-expect-error a to-one related read has no pages
    createQueryApi(client).albums.relatedInfinite('1', 'artist')
    // @ts-expect-error a to-one related read has no pages
    createQueryApi(client).inboxes.relatedInfinite('owner')
  })

  it("reads a singleton's relation with no id", async () => {
    const { client } = makeClient()
    const options = createQueryApi(client).inboxes.relatedInfinite('messages')
    expect(options.queryKey).toEqual(['inboxes', 'fetchRelated', 'messages', INFINITE_SEGMENT])
    const data = await new QueryClient().fetchInfiniteQuery(options)
    expect(data.pages[0]?.map((t) => t.id)).toEqual(['1', '2'])
  })

  it('skips in place of the id, keeping the relation in the key', () => {
    const { client } = makeClient()
    const api = createQueryApi(client)
    const options = api.albums.relatedInfinite(skipToken, 'tracks')
    expect(options.queryFn).toBe(skipToken)
    expect(options.queryKey).toEqual([
      'albums',
      'fetchRelated',
      { $skip: true },
      'tracks',
      INFINITE_SEGMENT,
    ])
    expect(infiniteRelatedQueryOptions(client, 'albums', skipToken, 'tracks').queryFn).toBe(
      skipToken,
    )
    expect(api.inboxes.relatedInfinite('messages', skipToken).queryKey).toEqual([
      'inboxes',
      'fetchRelated',
      { $skip: true },
      'messages',
      INFINITE_SEGMENT,
    ])
  })
})

describe('infinite keys and invalidation', () => {
  it('sit under the prefixes of their plain reads', () => {
    const { client } = makeClient()
    const list = infiniteListQueryOptions(client, 'albums', { page: { size: 2 } }).queryKey
    const related = infiniteRelatedQueryOptions(client, 'albums', '1', 'tracks').queryKey
    expect(keyHasPrefix(list, operationKey('albums', 'fetchMany'))).toBe(true)
    expect(
      parentRelationReadKeys('albums', '1', 'tracks').some((p) => keyHasPrefix(related, p)),
    ).toBe(true)
    expect(keyHasPrefix(related, ['albums', 'fetchRelated', '2'])).toBe(false)
    // TanStack's own prefix matching agrees.
    const qc = new QueryClient()
    const query = qc.getQueryCache().build(qc, { queryKey: list })
    expect(matchQuery({ queryKey: operationKey('albums', 'fetchMany') }, query)).toBe(true)
  })

  it('are invalidated by a create and a delete of the type', async () => {
    const { client } = makeClient()
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const options = infiniteListQueryOptions(client, 'albums')
    await qc.fetchInfiniteQuery(options)

    await runMutation(qc, createMutationOptions(qc, client, descriptor, 'albums'), {
      title: 'New',
    })
    expect(qc.getQueryState(options.queryKey)?.isInvalidated).toBe(true)

    await qc.refetchQueries({ queryKey: options.queryKey })
    expect(qc.getQueryState(options.queryKey)?.isInvalidated).toBe(false)
    await runMutation(qc, deleteMutationOptions(qc, client, 'albums', '1'), undefined)
    expect(qc.getQueryState(options.queryKey)?.isInvalidated).toBe(true)
  })

  it("are invalidated by a write to the parent's relationship", async () => {
    const { client } = makeClient()
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const options = infiniteRelatedQueryOptions(client, 'albums', '1', 'tracks')
    await qc.fetchInfiniteQuery(options)
    await runMutation(qc, addRelationshipMutationOptions(qc, client, 'albums', '1', 'tracks'), [
      { type: 'tracks', id: '1' },
    ])
    expect(qc.getQueryState(options.queryKey)?.isInvalidated).toBe(true)
  })
})

describe('unpaginated reads', () => {
  const unpaged = {
    genres: {
      attributes: { name: 'string' },
      relations: {
        // Paged through its related type's collection paginator.
        albums: { cardinality: 'many', types: ['albums'], pivot: false },
        // Unpaged through its related type's collection paginator.
        children: { cardinality: 'many', types: ['genres'], pivot: false },
        // Unpaged through its own paginator, though its related type pages.
        top: { cardinality: 'many', types: ['albums'], pivot: false, paginator: 'none' },
      },
      paths: {
        fetchMany: '/genres',
        fetchOne: '/genres/{id}',
        fetchRelated: '/genres/{id}/{rel}',
      },
      paginator: 'none',
      clientId: 'forbidden',
    },
    albums: {
      attributes: { title: 'string' },
      relations: {},
      paths: { fetchMany: '/albums', fetchOne: '/albums/{id}' },
      paginator: 'page',
      clientId: 'forbidden',
    },
  } as const satisfies ApiDescriptor
  const client = createClient(unpaged, {
    baseUrl: BASE,
    transport: async () => reply({ data: [] }),
  })

  it('has no infinite list read for a type whose paginator is none', () => {
    const api = createQueryApi(client)
    // @ts-expect-error an unpaginated collection has no pages
    infiniteListQueryOptions(client, 'genres')
    // @ts-expect-error an unpaginated collection has no pages
    void api.genres.infinite
    expectTypeOf(api.albums).toHaveProperty('infinite')
    expectTypeOf(api.genres).not.toHaveProperty('infinite')
    expect(infiniteListQueryOptions(client, 'albums').queryKey).toEqual([
      'albums',
      'fetchMany',
      INFINITE_SEGMENT,
    ])
  })

  it('takes only to-many relations whose related read paginates', () => {
    const api = createQueryApi(client)
    expect(api.genres.relatedInfinite('1', 'albums').queryKey).toEqual([
      'genres',
      'fetchRelated',
      '1',
      'albums',
      INFINITE_SEGMENT,
    ])
    expect(infiniteRelatedQueryOptions(client, 'genres', '1', 'albums').queryKey).toEqual(
      api.genres.relatedInfinite('1', 'albums').queryKey,
    )
    // @ts-expect-error the related type's collection paginator is none
    api.genres.relatedInfinite('1', 'children')
    // @ts-expect-error the related type's collection paginator is none
    infiniteRelatedQueryOptions(client, 'genres', '1', 'children')
    // @ts-expect-error the relation's own paginator is none
    api.genres.relatedInfinite('1', 'top')
    // @ts-expect-error the relation's own paginator is none
    infiniteRelatedQueryOptions(client, 'genres', '1', 'top')
  })
})
