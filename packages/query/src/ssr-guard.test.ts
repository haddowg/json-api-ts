import {
  type ApiDescriptor,
  createClient,
  isMaterialised,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import {
  defaultShouldDehydrateQuery,
  dehydrate,
  hydrate,
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from '@tanstack/query-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installNormalization, jsonApiShouldDehydrateQuery } from './install'
import { isMaterialisedData } from './normalize'
import { infiniteListQueryOptions, listQueryOptions } from './read'

const descriptor = {
  albums: {
    attributes: { title: 'string' },
    relations: {},
    paths: { fetchMany: '/albums', fetchOne: '/albums/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

const album = (id: string, title: string) => ({ type: 'albums', id, attributes: { title } })

function makeClient(title = 'A') {
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    const path = new URL(req.url).pathname
    if (req.method === 'GET' && path === '/albums') {
      return { status: 200, headers: {}, body: JSON.stringify({ data: [album('1', title)] }) }
    }
    return { status: 404, headers: {}, body: JSON.stringify({ errors: [{ status: '404' }] }) }
  }
  return createClient(descriptor, { baseUrl: 'https://music.example', transport })
}

const previous = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] !== 'hidden'

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** A server-side client that has fetched a binding read and a non-binding query. */
async function serverWithData() {
  const client = makeClient()
  const server = new QueryClient()
  installNormalization(server, descriptor)
  await server.fetchQuery(listQueryOptions(client, 'albums'))
  await server.fetchQuery({ queryKey: ['other'], queryFn: () => 'x' })
  return { client, server }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('server side', () => {
  it('dehydrates non-binding queries only', async () => {
    const { server } = await serverWithData()
    expect(dehydrate(server).queries.map((q) => q.queryKey)).toEqual([['other']])
  })

  it('leaves out a query of your own holding a client result, whatever its key', async () => {
    const client = makeClient()
    const server = new QueryClient()
    installNormalization(server, descriptor)
    await server.fetchQuery({
      queryKey: ['albums', 'top'],
      queryFn: () => client.albums.list(),
      structuralSharing: false,
    })
    await server.fetchInfiniteQuery({
      queryKey: ['albums', 'pages'],
      queryFn: () => client.albums.list(),
      initialPageParam: 1,
      getNextPageParam: () => undefined,
      structuralSharing: false,
    })
    await server.fetchQuery({ queryKey: ['other'], queryFn: () => 'x' })
    expect(dehydrate(server).queries.map((q) => q.queryKey)).toEqual([['other']])
  })

  it('dehydrates a query holding plain data, even under a binding-shaped key', async () => {
    const server = new QueryClient()
    installNormalization(server, descriptor)
    await server.fetchQuery({
      queryKey: ['albums', 'fetchMany'],
      queryFn: () => [{ id: '1', title: 'A' }],
    })
    expect(dehydrate(server).queries.map((q) => q.queryKey)).toEqual([['albums', 'fetchMany']])
  })

  it('honours a previously configured default and restores it on teardown', async () => {
    const client = makeClient()
    const server = new QueryClient()
    server.setDefaultOptions({
      queries: { staleTime: 5 },
      dehydrate: { shouldDehydrateQuery: previous, shouldRedactErrors: () => false },
    })
    const teardown = installNormalization(server, descriptor)
    await server.fetchQuery(listQueryOptions(client, 'albums'))
    await server.fetchQuery({ queryKey: ['other'], queryFn: () => 'x' })
    await server.fetchQuery({ queryKey: ['hidden'], queryFn: () => 'y' })

    expect(dehydrate(server).queries.map((q) => q.queryKey)).toEqual([['other']])
    expect(server.getDefaultOptions().queries?.staleTime).toBe(5)
    expect(server.getDefaultOptions().dehydrate?.shouldRedactErrors).toBeDefined()

    teardown()
    expect(server.getDefaultOptions().dehydrate?.shouldDehydrateQuery).toBe(previous)
  })

  it('removes its default on teardown when none was set', () => {
    const qc = new QueryClient()
    const teardown = installNormalization(qc, descriptor)
    expect(qc.getDefaultOptions().dehydrate?.shouldDehydrateQuery).toBeDefined()
    teardown()
    expect(qc.getDefaultOptions().dehydrate?.shouldDehydrateQuery).toBeUndefined()
  })
})

describe('jsonApiShouldDehydrateQuery', () => {
  it('excludes queries holding a client result and otherwise calls next', async () => {
    const { client, server } = await serverWithData()
    await server.fetchQuery({
      queryKey: ['albums', 'top'],
      queryFn: () => client.albums.list(),
      structuralSharing: false,
    })
    await server.fetchQuery({ queryKey: ['albums', 'fetchMany', 'plain'], queryFn: () => ['x'] })
    const next = vi.fn(() => true)
    const predicate = jsonApiShouldDehydrateQuery(next)
    const binding = server.getQueryCache().find({ queryKey: ['albums', 'fetchMany'], exact: true })
    const own = server.getQueryCache().find({ queryKey: ['albums', 'top'] })
    const plain = server.getQueryCache().find({ queryKey: ['albums', 'fetchMany', 'plain'] })
    const other = server.getQueryCache().find({ queryKey: ['other'] })
    expect(binding && predicate(binding)).toBe(false)
    expect(own && predicate(own)).toBe(false)
    expect(next).not.toHaveBeenCalled()
    expect(plain && predicate(plain)).toBe(true)
    expect(other && predicate(other)).toBe(true)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('defaults next to defaultShouldDehydrateQuery', async () => {
    const { server } = await serverWithData()
    const pending = server.getQueryCache().build(server, { queryKey: ['p'] as readonly unknown[] })
    expect(jsonApiShouldDehydrateQuery()(pending)).toBe(defaultShouldDehydrateQuery(pending))
  })
})

describe('hydration check for a streamed pending read', () => {
  it('refetches a pending binding read that resolves without its accessors, once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A server whose albums list answers only when the test releases it, so it dehydrates pending.
    const latch: { release?: () => void } = {}
    const gate = new Promise<void>((resolve) => {
      latch.release = resolve
    })
    const slow = createClient(descriptor, {
      baseUrl: 'https://music.example',
      transport: async () => {
        await gate
        return { status: 200, headers: {}, body: JSON.stringify({ data: [album('1', 'A')] }) }
      },
    })
    const server = new QueryClient()
    installNormalization(server, descriptor)
    void server.prefetchQuery(listQueryOptions(slow, 'albums'))
    const dehydrated = dehydrate(server, {
      shouldDehydrateQuery: (q) => q.state.status === 'pending' || jsonApiShouldDehydrateQuery()(q),
    })
    expect(dehydrated.queries.map((q) => q.state.status)).toEqual(['pending'])
    // The wire: JSON for the state, and the promise streamed as its result's JSON.
    const wire = {
      ...(JSON.parse(JSON.stringify(dehydrated)) as typeof dehydrated),
      queries: dehydrated.queries.map((q) => ({
        ...(JSON.parse(JSON.stringify(q)) as typeof q),
        promise: q.promise?.then((data) => JSON.parse(JSON.stringify(data)) as unknown),
      })),
    }

    const browser = new QueryClient()
    installNormalization(browser, descriptor)
    const options = listQueryOptions(makeClient('B'), 'albums')
    const reset = vi.spyOn(browser, 'resetQueries')
    hydrate(browser, wire)
    const observer = new QueryObserver(browser, { ...options, staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => {})

    latch.release?.()
    for (let i = 0; i < 5; i++) {
      await flush()
    }

    expect(reset).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('albums')
    const data = browser.getQueryData(options.queryKey)
    expect(isMaterialised(data)).toBe(true)
    expect(data?.[0]?.title).toBe('B')
    expect(observer.getCurrentResult().data?.$page.kind).toBe('page')
    unsubscribe()
  })

  it('never resets a normal fetch or a setQueryData of a binding read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const qc = new QueryClient()
    installNormalization(qc, descriptor)
    const reset = vi.spyOn(qc, 'resetQueries')
    const options = listQueryOptions(makeClient(), 'albums')
    await qc.fetchQuery(options)
    await qc.refetchQueries({ queryKey: options.queryKey })
    qc.setQueryData(['albums', 'fetchMany', 'plain'] as readonly unknown[], ['x'])
    await flush()
    expect(reset).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('never resets a query of your own keyed like a binding read, holding plain data', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const qc = new QueryClient()
    installNormalization(qc, descriptor)
    const reset = vi.spyOn(qc, 'resetQueries')
    const queryFn = vi.fn(() => Promise.resolve([{ id: '1' }]))
    const observer = new QueryObserver(qc, { queryKey: ['albums', 'fetchMany', 'mine'], queryFn })
    const unsubscribe = observer.subscribe(() => {})
    for (let i = 0; i < 5; i++) {
      await flush()
    }
    expect(reset).not.toHaveBeenCalled()
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
    expect(observer.getCurrentResult().data).toEqual([{ id: '1' }])
    unsubscribe()
  })
})

describe('hydration check', () => {
  it('refetches a hydrated binding query with one warning, and leaves others alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { server } = await serverWithData()
    const wire = JSON.parse(
      JSON.stringify(dehydrate(server, { shouldDehydrateQuery: () => true })),
    ) as ReturnType<typeof dehydrate>

    const browser = new QueryClient()
    installNormalization(browser, descriptor)
    const options = listQueryOptions(makeClient(), 'albums')
    hydrate(browser, wire)

    // Without the guard a hydrated entry with staleTime: Infinity would never refetch.
    const observer = new QueryObserver(browser, { ...options, staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => {})
    await flush()
    await flush()

    expect(isMaterialised(browser.getQueryData(options.queryKey))).toBe(true)
    expect(observer.getCurrentResult().data?.$page.kind).toBe('page')
    unsubscribe()

    expect(browser.getQueryData(['other'])).toBe('x')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('albums')
    expect(String(warn.mock.calls[0]?.[0])).toContain('not supported')
  })

  it('never resets a materialised read, including after a patch republishes it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const qc = new QueryClient()
    installNormalization(qc, descriptor)
    const options = listQueryOptions(makeClient(), 'albums')
    await qc.fetchQuery(options)
    const reset = vi.spyOn(qc, 'resetQueries')

    // A second read of the same resource with a new title patches the first and republishes it.
    await qc.fetchQuery(listQueryOptions(makeClient('B'), 'albums', { page: { number: 2 } }))
    await flush()
    const data = qc.getQueryData(options.queryKey)
    expect(data?.[0]?.title).toBe('B')
    expect(isMaterialised(data)).toBe(false)

    // The republished root still reads as materialised when a query is added holding it.
    const state = qc.getQueryCache().find({ queryKey: options.queryKey })?.state
    qc.getQueryCache().build(
      qc,
      { queryKey: ['albums', 'fetchMany', { again: 'x' }] as readonly unknown[] },
      state,
    )
    await flush()

    expect(reset).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('hydration check for infinite reads', () => {
  it('refetches a hydrated infinite query with one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = new QueryClient()
    installNormalization(server, descriptor)
    await server.fetchInfiniteQuery(infiniteListQueryOptions(makeClient(), 'albums'))
    const wire = JSON.parse(
      JSON.stringify(dehydrate(server, { shouldDehydrateQuery: () => true })),
    ) as ReturnType<typeof dehydrate>

    const browser = new QueryClient()
    installNormalization(browser, descriptor)
    const options = infiniteListQueryOptions(makeClient('B'), 'albums')
    hydrate(browser, wire)
    expect(isMaterialisedData(browser.getQueryData(options.queryKey))).toBe(false)

    const observer = new InfiniteQueryObserver(browser, { ...options, staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => {})
    await flush()
    await flush()

    const data = observer.getCurrentResult().data
    expect(isMaterialised(data?.pages[0])).toBe(true)
    expect(data?.pages[0]?.[0]?.title).toBe('B')
    expect(data?.pages[0]?.$page.kind).toBe('page')
    unsubscribe()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('$infinite')
  })

  it('never resets a fetched infinite query, including after a patch republishes a page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const qc = new QueryClient()
    installNormalization(qc, descriptor)
    const options = infiniteListQueryOptions(makeClient(), 'albums')
    await qc.fetchInfiniteQuery(options)
    const reset = vi.spyOn(qc, 'resetQueries')
    const before = qc.getQueryData(options.queryKey)

    await qc.fetchQuery(listQueryOptions(makeClient('B'), 'albums', { page: { number: 2 } }))
    await flush()
    const data = qc.getQueryData(options.queryKey)
    expect(data).not.toBe(before)
    expect(data?.pages[0]?.[0]?.title).toBe('B')
    expect(isMaterialisedData(data)).toBe(true)

    // The republished data still reads as materialised when a query is added holding it.
    const state = qc.getQueryCache().find({ queryKey: options.queryKey })?.state
    qc.getQueryCache().build(
      qc,
      { queryKey: ['albums', 'fetchMany', { again: 'x' }, '$infinite'] as readonly unknown[] },
      state,
    )
    await flush()

    expect(reset).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
})
