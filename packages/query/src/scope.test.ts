import {
  type ApiDescriptor,
  createClient,
  isMaterialised,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { dehydrate, hydrate, matchQuery, QueryClient, QueryObserver } from '@tanstack/query-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installNormalization, jsonApiShouldDehydrateQuery } from './install'
import {
  infiniteKeyFor,
  keyFor,
  keyHasPrefix,
  operationKey,
  type QueryKey,
  relationReadKeys,
  resourceKey,
  scopeOf,
  SKIPPED_SEGMENT,
  typeKey,
} from './keys'
import { createMutationApi, type MutationOptions, updateMutationOptions } from './mutate'
import { JsonApiMutationCache } from './mutation-cache'
import { createQueryApi, getQueryOptions, listQueryOptions } from './read'
import { withScope } from './scope'
import { mutationKeyFor } from './upkeep'

// Two servers whose `users` differ: the admin server's carry a `role` the default one doesn't.
const main = {
  users: {
    attributes: { name: 'string' },
    relations: {},
    paths: {
      fetchMany: '/users',
      fetchOne: '/users/{id}',
      create: '/users',
      update: '/users/{id}',
    },
    paginator: 'page',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

const admin = {
  users: {
    attributes: { name: 'string', role: 'string' },
    relations: {},
    paths: {
      fetchMany: '/users',
      fetchOne: '/users/{id}',
      create: '/users',
      update: '/users/{id}',
    },
    paginator: 'page',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

const user = (id: string, attributes: Record<string, unknown>) => ({
  type: 'users',
  id,
  attributes,
})

/** A server answering from a route table keyed `METHOD path`; `'error'` replies 422. */
function server<D extends ApiDescriptor>(
  descriptor: D,
  baseUrl: string,
  routes: Record<string, unknown>,
) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    const route = routes[`${req.method} ${new URL(req.url).pathname}`]
    if (route === 'error') {
      return { status: 422, headers: {}, body: JSON.stringify({ errors: [{ status: '422' }] }) }
    }
    if (route === undefined) {
      return { status: 404, headers: {}, body: JSON.stringify({ errors: [{ status: '404' }] }) }
    }
    return { status: 200, headers: {}, body: JSON.stringify(route) }
  }
  return { client: createClient(descriptor, { baseUrl, transport }), requests }
}

/** One QueryClient holding both servers: the main one unscoped, the admin one in scope `admin`. */
function sharedQueryClient() {
  const qc = new QueryClient({
    mutationCache: new JsonApiMutationCache(),
    defaultOptions: { queries: { staleTime: Infinity } },
  })
  installNormalization(qc, main)
  installNormalization(qc, admin, { scope: 'admin' })
  return qc
}

function runMutation<TData, TVars>(
  qc: QueryClient,
  options: MutationOptions<TData, TVars>,
  variables: TVars,
): Promise<TData> {
  return qc
    .getMutationCache()
    .build<TData, unknown, TVars, unknown>(qc, options as never)
    .execute(variables)
}

const ADMIN = { $scope: 'admin' }

/** The first member of a cached list. */
const first = (data: unknown) => (data as Array<Record<string, unknown>>)[0]!

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('scoped keys', () => {
  it('leads every key a scoped API builds with { $scope }, and leaves unscoped keys as they were', () => {
    const { client } = server(admin, 'https://admin.example', {})
    const reads = createQueryApi(client, { scope: 'admin' })
    expect(reads.users.list().queryKey).toEqual([ADMIN, 'users', 'fetchMany'])
    expect(reads.users.get('1').queryKey).toEqual([ADMIN, 'users', 'fetchOne', '1'])
    expect(reads.users.infinite().queryKey).toEqual([ADMIN, 'users', 'fetchMany', '$infinite'])
    expect(createQueryApi(client).users.list().queryKey).toEqual(['users', 'fetchMany'])

    const qc = new QueryClient()
    const writes = createMutationApi(qc, client, admin, { scope: 'admin' })
    const update = writes.users.id('1').update({ optimistic: true })
    expect(update.mutationKey).toEqual([ADMIN, 'users', 'update', '1'])
    expect(update.meta).toEqual({
      jsonApi: { verb: 'update', type: 'users', id: '1', optimistic: true, scope: 'admin' },
    })
    // The plan stays plain data.
    expect(JSON.parse(JSON.stringify(update.meta))).toEqual(update.meta)
    expect(createMutationApi(qc, client, admin).users.create().mutationKey).toEqual([
      'users',
      'create',
    ])
  })

  it('returns the same scoped accessor on every read, so it can sit in dependency arrays', () => {
    const { client } = server(admin, 'https://admin.example', {})
    const reads = createQueryApi(client, { scope: 'admin' })
    expect(reads.users).toBe(reads.users)
    expect(reads.users.list).toBe(reads.users.list)
    const writes = createMutationApi(new QueryClient(), client, admin, { scope: 'admin' })
    expect(writes.users.id).toBe(writes.users.id)
  })

  it('scopes a standalone factory through withScope', () => {
    const { client } = server(admin, 'https://admin.example', {})
    const qc = new QueryClient()
    expect(withScope('admin', listQueryOptions(client, 'users')).queryKey).toEqual([
      ADMIN,
      'users',
      'fetchMany',
    ])
    const update = withScope('admin', updateMutationOptions(qc, client, admin, 'users', '1'))
    expect(update.mutationKey).toEqual([ADMIN, 'users', 'update', '1'])
    expect(update.meta.jsonApi).toMatchObject({ scope: 'admin' })
    // Scoping again replaces the scope; undefined removes it.
    expect(withScope('other', update).mutationKey).toEqual([
      { $scope: 'other' },
      'users',
      'update',
      '1',
    ])
    const unscoped = withScope(undefined, update)
    expect(unscoped.mutationKey).toEqual(['users', 'update', '1'])
    expect(unscoped.meta.jsonApi).not.toHaveProperty('scope')
  })

  it('takes the scope in every key helper', () => {
    expect(keyFor({ type: 'users', operation: 'fetchOne', id: '1', scope: 'admin' })).toEqual([
      ADMIN,
      'users',
      'fetchOne',
      '1',
    ])
    expect(infiniteKeyFor({ type: 'users', operation: 'fetchMany', scope: 'admin' })).toEqual([
      ADMIN,
      'users',
      'fetchMany',
      '$infinite',
    ])
    expect(typeKey('users', 'admin')).toEqual([ADMIN, 'users'])
    expect(operationKey('users', 'fetchMany', 'admin')).toEqual([ADMIN, 'users', 'fetchMany'])
    expect(resourceKey('users', '1', 'admin')).toEqual([ADMIN, 'users', 'fetchOne', '1'])
    expect(relationReadKeys('users', '1', 'teams', 'admin')).toEqual([
      [ADMIN, 'users', 'fetchRelated', '1', 'teams'],
      [ADMIN, 'users', 'fetchRelationship', '1', 'teams'],
    ])
    expect(mutationKeyFor({ type: 'users', verb: 'update', id: '1', scope: 'admin' })).toEqual([
      ADMIN,
      'users',
      'update',
      '1',
    ])
    // Unscoped helpers are unchanged.
    expect(typeKey('users')).toEqual(['users'])
    expect(resourceKey('users', '1', undefined)).toEqual(['users', 'fetchOne', '1'])

    expect(scopeOf([ADMIN, 'users'])).toBe('admin')
    expect(scopeOf(['users'])).toBeUndefined()
    expect(
      keyHasPrefix([{ $scope: 'admin' }, 'users', 'fetchMany'], typeKey('users', 'admin')),
    ).toBe(true)
    expect(keyHasPrefix([ADMIN, 'users', 'fetchMany'], typeKey('users'))).toBe(false)
    expect(keyHasPrefix([ADMIN, 'users'], typeKey('users', 'other'))).toBe(false)
    // A scoped skipped read, hashed and rebuilt, still matches by value in both segments.
    const skipped = JSON.parse(
      JSON.stringify([ADMIN, 'users', 'fetchOne', SKIPPED_SEGMENT]),
    ) as QueryKey
    expect(keyHasPrefix(skipped, [ADMIN, 'users', 'fetchOne', SKIPPED_SEGMENT])).toBe(true)
    expect(keyHasPrefix(skipped, ['users', 'fetchOne', SKIPPED_SEGMENT])).toBe(false)

    // TanStack's own prefix matching agrees: a scope's prefix matches only that scope's queries.
    const qc = new QueryClient()
    const scoped = qc.getQueryCache().build(qc, { queryKey: [ADMIN, 'users', 'fetchMany'] })
    const plain = qc.getQueryCache().build(qc, { queryKey: ['users', 'fetchMany'] })
    expect(matchQuery({ queryKey: typeKey('users', 'admin') }, scoped)).toBe(true)
    expect(matchQuery({ queryKey: typeKey('users', 'admin') }, plain)).toBe(false)
    expect(matchQuery({ queryKey: typeKey('users') }, scoped)).toBe(false)
  })
})

describe('two servers on one QueryClient', () => {
  function servers(adminRoutes: Record<string, unknown> = {}) {
    const mainServer = server(main, 'https://main.example', {
      'GET /users': { data: [user('1', { name: 'Ann' })] },
      'GET /users/1': { data: user('1', { name: 'Ann' }) },
      'POST /users': { data: user('2', { name: 'Bo' }) },
    })
    const adminServer = server(admin, 'https://admin.example', {
      'GET /users': { data: [user('1', { name: 'Ann (admin)', role: 'owner' })] },
      'GET /users/1': { data: user('1', { name: 'Ann (admin)', role: 'owner' }) },
      ...adminRoutes,
    })
    const qc = sharedQueryClient()
    return {
      qc,
      mainReads: createQueryApi(mainServer.client),
      mainWrites: createMutationApi(qc, mainServer.client, main),
      adminReads: createQueryApi(adminServer.client, { scope: 'admin' }),
      adminWrites: createMutationApi(qc, adminServer.client, admin, { scope: 'admin' }),
    }
  }

  it('normalises each server’s reads only into its own scope', async () => {
    const { qc, mainReads, adminReads } = servers()
    const mainList = mainReads.users.list()
    const adminList = adminReads.users.list()
    await qc.fetchQuery(mainList)
    await qc.fetchQuery(adminList)
    // Each read of users:1 lands in its own scope, neither overwriting the other.
    await qc.fetchQuery(mainReads.users.get('1'))
    await qc.fetchQuery(adminReads.users.get('1'))

    expect(first(qc.getQueryData(mainList.queryKey))).toMatchObject({ name: 'Ann' })
    expect(first(qc.getQueryData(mainList.queryKey))).not.toHaveProperty('role')
    expect(first(qc.getQueryData(adminList.queryKey))).toMatchObject({
      name: 'Ann (admin)',
      role: 'owner',
    })
  })

  it('patches a scoped write’s result into its own scope only', async () => {
    const { qc, mainReads, adminReads, adminWrites } = servers({
      'PATCH /users/1': { data: user('1', { name: 'Ann (renamed)', role: 'viewer' }) },
    })
    const mainList = mainReads.users.list()
    const adminList = adminReads.users.list()
    await qc.fetchQuery(mainList)
    await qc.fetchQuery(adminList)

    await runMutation(qc, adminWrites.users.id('1').update(), { name: 'Ann (renamed)' })

    expect(first(qc.getQueryData(adminList.queryKey))).toMatchObject({
      name: 'Ann (renamed)',
      role: 'viewer',
    })
    expect(first(qc.getQueryData(mainList.queryKey))).toMatchObject({ name: 'Ann' })
    expect(first(qc.getQueryData(mainList.queryKey))).not.toHaveProperty('role')
  })

  it('applies and rolls back a scoped optimistic update in its own scope only', async () => {
    const { qc, mainReads, adminReads, adminWrites } = servers({ 'PATCH /users/1': 'error' })
    const mainList = mainReads.users.list()
    const adminList = adminReads.users.list()
    await qc.fetchQuery(mainList)
    await qc.fetchQuery(adminList)

    const pending = runMutation(qc, adminWrites.users.id('1').update({ optimistic: true }), {
      name: 'Optimistic',
    })
    expect(first(qc.getQueryData(adminList.queryKey))['name']).toBe('Optimistic')
    expect(first(qc.getQueryData(mainList.queryKey))['name']).toBe('Ann')

    await expect(pending).rejects.toBeDefined()
    expect(first(qc.getQueryData(adminList.queryKey))['name']).toBe('Ann (admin)')
    expect(first(qc.getQueryData(mainList.queryKey))['name']).toBe('Ann')
  })

  it('invalidates a write’s own scope only', async () => {
    const { qc, mainReads, adminReads, mainWrites } = servers()
    const mainList = mainReads.users.list()
    const adminList = adminReads.users.list()
    await qc.fetchQuery(mainList)
    await qc.fetchQuery(adminList)

    await runMutation(qc, mainWrites.users.create(), { name: 'Bo' })

    expect(qc.getQueryState(mainList.queryKey)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(adminList.queryKey)?.isInvalidated).toBe(false)
  })

  it('filters mutations by scope', async () => {
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = createClient(admin, {
      baseUrl: 'https://admin.example',
      transport: async () => {
        await held
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ data: user('1', { name: 'X' }) }),
        }
      },
    })
    const qc = sharedQueryClient()
    const writes = createMutationApi(qc, client, admin, { scope: 'admin' })
    const pending = runMutation(qc, writes.users.id('1').update(), { name: 'X' })

    expect(qc.isMutating({ mutationKey: [ADMIN] })).toBe(1)
    expect(qc.isMutating({ mutationKey: [ADMIN, 'users', 'update'] })).toBe(1)
    expect(
      qc.isMutating({
        mutationKey: mutationKeyFor({ type: 'users', verb: 'update', id: '1', scope: 'admin' }),
      }),
    ).toBe(1)
    // An unscoped filter doesn't reach into a scope, nor another scope's.
    expect(qc.isMutating({ mutationKey: ['users'] })).toBe(0)
    expect(qc.isMutating({ mutationKey: [{ $scope: 'other' }] })).toBe(0)

    release?.()
    await pending
  })

  it('refuses a scoped mutation whose scope has no descriptor installed', async () => {
    const { client, requests } = server(admin, 'https://admin.example', {})
    const qc = new QueryClient({ mutationCache: new JsonApiMutationCache() })
    installNormalization(qc, main)
    const writes = createMutationApi(qc, client, admin, { scope: 'admin' })
    await expect(runMutation(qc, writes.users.create(), { name: 'X' })).rejects.toThrow(
      `installNormalization(queryClient, descriptor, { scope: 'admin' })`,
    )
    expect(requests).toHaveLength(0)
  })
})

describe('installNormalization per scope', () => {
  it('allows one descriptor per scope, and a different one in another scope', () => {
    const qc = new QueryClient()
    installNormalization(qc, main)
    expect(() => installNormalization(qc, admin, { scope: 'admin' })).not.toThrow()
    expect(() => installNormalization(qc, admin)).toThrow(/only one descriptor/i)
    expect(() => installNormalization(qc, main, { scope: 'admin' })).toThrow(/scope "admin"/)
    // The same descriptor again in its scope is allowed.
    expect(() => installNormalization(qc, admin, { scope: 'admin' })).not.toThrow()
  })

  it('releases a scope once its last install is torn down', () => {
    const qc = new QueryClient()
    const teardownOne = installNormalization(qc, admin, { scope: 'admin' })
    const teardownTwo = installNormalization(qc, admin, { scope: 'admin' })
    teardownOne()
    expect(() => installNormalization(qc, main, { scope: 'admin' })).toThrow()
    teardownTwo()
    expect(() => installNormalization(qc, main, { scope: 'admin' })).not.toThrow()
  })

  it('installs the client-wide defaults once and removes them with the last teardown', () => {
    const qc = new QueryClient()
    const teardownA = installNormalization(qc, main)
    const predicate = qc.getDefaultOptions().dehydrate?.shouldDehydrateQuery
    const retry = qc.getDefaultOptions().queries?.retry
    expect(predicate).toBeDefined()
    expect(retry).toBeDefined()

    const teardownB = installNormalization(qc, admin, { scope: 'admin' })
    // The second install shares the first's defaults rather than wrapping them again.
    expect(qc.getDefaultOptions().dehydrate?.shouldDehydrateQuery).toBe(predicate)
    expect(qc.getDefaultOptions().queries?.retry).toBe(retry)

    teardownA()
    expect(qc.getDefaultOptions().dehydrate?.shouldDehydrateQuery).toBe(predicate)
    expect(qc.getDefaultOptions().queries?.retry).toBe(retry)

    teardownB()
    expect(qc.getDefaultOptions().dehydrate?.shouldDehydrateQuery).toBeUndefined()
    expect(qc.getDefaultOptions().queries?.retry).toBeUndefined()
  })
})

describe('SSR guard for scoped reads', () => {
  async function scopedServer() {
    const { client } = server(admin, 'https://admin.example', {
      'GET /users': { data: [user('1', { name: 'Ann', role: 'owner' })] },
    })
    const qc = new QueryClient()
    installNormalization(qc, admin, { scope: 'admin' })
    const options = createQueryApi(client, { scope: 'admin' }).users.list()
    await qc.fetchQuery(options)
    await qc.fetchQuery({ queryKey: [ADMIN, 'other'], queryFn: () => 'x' })
    return { client, qc, options }
  }

  it('leaves scoped binding queries out of dehydration, by default and through the predicate', async () => {
    const { qc, options } = await scopedServer()
    expect(dehydrate(qc).queries.map((q) => q.queryKey)).toEqual([[ADMIN, 'other']])
    const binding = qc.getQueryCache().find({ queryKey: options.queryKey })
    expect(binding && jsonApiShouldDehydrateQuery(() => true)(binding)).toBe(false)
  })

  it('refetches a hydrated scoped binding query', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, qc } = await scopedServer()
    const wire = JSON.parse(
      JSON.stringify(dehydrate(qc, { shouldDehydrateQuery: () => true })),
    ) as ReturnType<typeof dehydrate>

    const browser = new QueryClient()
    installNormalization(browser, main)
    installNormalization(browser, admin, { scope: 'admin' })
    const options = createQueryApi(client, { scope: 'admin' }).users.list()
    hydrate(browser, wire)
    const observer = new QueryObserver(browser, { ...options, staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => {})
    await flush()
    await flush()

    expect(isMaterialised(browser.getQueryData(options.queryKey))).toBe(true)
    unsubscribe()
    // Warned once, by the scope's own install only.
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('refetches a streamed pending scoped read once, through its scope’s install', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const latch: { release?: () => void } = {}
    const gate = new Promise<void>((resolve) => {
      latch.release = resolve
    })
    const slow = createClient(admin, {
      baseUrl: 'https://admin.example',
      transport: async () => {
        await gate
        const body = { data: [user('1', { name: 'Ann', role: 'owner' })] }
        return { status: 200, headers: {}, body: JSON.stringify(body) }
      },
    })
    const ssr = new QueryClient()
    installNormalization(ssr, admin, { scope: 'admin' })
    void ssr.prefetchQuery(createQueryApi(slow, { scope: 'admin' }).users.list())
    const dehydrated = dehydrate(ssr, {
      shouldDehydrateQuery: (q) => q.state.status === 'pending' || jsonApiShouldDehydrateQuery()(q),
    })
    expect(dehydrated.queries.map((q) => q.state.status)).toEqual(['pending'])
    const wire = {
      ...(JSON.parse(JSON.stringify(dehydrated)) as typeof dehydrated),
      queries: dehydrated.queries.map((q) => ({
        ...(JSON.parse(JSON.stringify(q)) as typeof q),
        ...(q.promise === undefined
          ? {}
          : { promise: q.promise.then((data) => JSON.parse(JSON.stringify(data)) as unknown) }),
      })),
    }

    const { client } = server(admin, 'https://admin.example', {
      'GET /users': { data: [user('1', { name: 'Bea', role: 'owner' })] },
    })
    const browser = new QueryClient()
    installNormalization(browser, main)
    installNormalization(browser, admin, { scope: 'admin' })
    const reset = vi.spyOn(browser, 'resetQueries')
    const options = createQueryApi(client, { scope: 'admin' }).users.list()
    hydrate(browser, wire)
    const observer = new QueryObserver(browser, { ...options, staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => {})
    latch.release?.()
    for (let i = 0; i < 5; i++) {
      await flush()
    }

    expect(reset).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    const data = browser.getQueryData(options.queryKey)
    expect(isMaterialised(data)).toBe(true)
    expect(first(data)['name']).toBe('Bea')
    unsubscribe()
  })
})

describe('getQueryOptions scoped', () => {
  it('reads the same path whatever its scope', async () => {
    const { client, requests } = server(admin, 'https://admin.example', {
      'GET /users/1': { data: user('1', { name: 'Ann', role: 'owner' }) },
    })
    const qc = new QueryClient()
    await qc.fetchQuery(withScope('admin', getQueryOptions(client, 'users', '1')))
    expect(requests[0]!.url).toBe('https://admin.example/users/1')
  })
})
