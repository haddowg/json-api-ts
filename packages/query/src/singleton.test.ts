import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { QueryClient, type QueryClientConfig } from '@tanstack/query-core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { installNormalization } from './install'
import { JsonApiMutationCache } from './mutation-cache'
import { singletonRelationReadKeys } from './keys'
import {
  createMutationApi,
  type MutationOptions,
  setRelationshipMutationOptions,
  updateMutationOptions,
} from './mutate'
import { createQueryApi, getQueryOptions, relatedQueryOptions } from './read'

const BASE = 'https://api.example'

// The caller's inbox, served at /inbox with no id, beside an ordinary people collection.
const descriptor = {
  inboxes: {
    attributes: { seenUpTo: 'date-time', unread: 'integer' },
    relations: {
      owner: { cardinality: 'one', types: ['people'], mutations: { set: true } },
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
  },
  people: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchMany: '/people', fetchOne: '/people/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

interface Attributes {
  inboxes: { seenUpTo: string | null; unread: number }
  people: { name: string }
}

interface WriteAttributes {
  inboxes: { update: { seenUpTo?: string } }
  people: { create: { name: string }; update: { name?: string } }
}

const inbox = {
  type: 'inboxes',
  id: '42',
  attributes: { seenUpTo: null, unread: 5 },
  relationships: { owner: { data: { type: 'people', id: 'per-1' } } },
}

function makeClient(respond: (req: TransportRequest) => unknown = () => ({ data: inbox })) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    return { status: 200, headers: {}, body: JSON.stringify(respond(req)) }
  }
  const client = createClient<typeof descriptor, Attributes, WriteAttributes>(descriptor, {
    baseUrl: BASE,
    transport,
  })
  return { client, requests }
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

/**
 * A QueryClient as an app builds one for mutations: with the JsonApiMutationCache and the
 * descriptor installed.
 */
function jsonApiQueryClient(
  config: QueryClientConfig = { defaultOptions: { queries: { staleTime: Infinity } } },
): QueryClient {
  const qc = new QueryClient({ ...config, mutationCache: new JsonApiMutationCache() })
  installNormalization(qc, descriptor)
  return qc
}

describe('singleton query options', () => {
  it('keys its reads without an id and reads its own path', async () => {
    const { client, requests } = makeClient()
    const get = getQueryOptions(client, 'inboxes', undefined, { fields: { inboxes: ['unread'] } })
    expect(get.queryKey).toEqual(['inboxes', 'fetchOne', { fields: { inboxes: ['unread'] } }])
    const related = relatedQueryOptions(client, 'inboxes', undefined, 'owner')
    expect(related.queryKey).toEqual(['inboxes', 'fetchRelated', 'owner'])
    await get.queryFn()
    await related.queryFn()
    expect(requests.map((req) => decodeURI(req.url))).toEqual([
      `${BASE}/inbox?fields[inboxes]=unread`,
      `${BASE}/inbox/owner`,
    ])
  })

  it('binds the singleton reads with no id, as the client does', async () => {
    const { client, requests } = makeClient()
    const api = createQueryApi(client)
    expect(api.inboxes.get().queryKey).toEqual(['inboxes', 'fetchOne'])
    expect(api.inboxes.relationship('owner').queryKey).toEqual([
      'inboxes',
      'fetchRelationship',
      'owner',
    ])
    expect(api.people.get('per-1').queryKey).toEqual(['people', 'fetchOne', 'per-1'])
    await api.inboxes.relationship('owner').queryFn()
    expect(requests[0]!.url).toBe(`${BASE}/inbox/relationships/owner`)
    // @ts-expect-error -- a singleton takes no id
    expect(() => getQueryOptions(client, 'inboxes', '42')).toBeDefined()
    // @ts-expect-error -- and an ordinary type needs one
    expect(() => getQueryOptions(client, 'people', undefined)).toBeDefined()
  })

  it('updates with the id in the variables and patches the cached read', async () => {
    const { client, requests } = makeClient((req) =>
      req.method === 'PATCH'
        ? { data: { ...inbox, attributes: { seenUpTo: '2026-11-16T09:30:00+00:00', unread: 0 } } }
        : { data: inbox },
    )
    const qc = jsonApiQueryClient()
    const get = getQueryOptions(client, 'inboxes', undefined)
    await qc.fetchQuery(get)
    const update = createMutationApi(qc, client, descriptor).inboxes.update()
    expectTypeOf(update.mutationFn).parameter(0).toHaveProperty('id').toEqualTypeOf<string>()
    await runMutation(qc, update, { id: '42', seenUpTo: '2026-11-16T09:30:00+00:00' })
    expect(requests[1]).toMatchObject({ method: 'PATCH', url: `${BASE}/inbox` })
    expect(JSON.parse(requests[1]!.body!)).toMatchObject({ data: { type: 'inboxes', id: '42' } })
    expect(qc.getQueryData(get.queryKey)).toMatchObject({ id: '42', unread: 0 })
  })

  it('applies an optimistic update to the resource the input names', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const requests: TransportRequest[] = []
    const transport = async (req: TransportRequest): Promise<TransportResponse> => {
      requests.push(req)
      if (req.method === 'PATCH') {
        await gate
      }
      return { status: 200, headers: {}, body: JSON.stringify({ data: inbox }) }
    }
    const client = createClient<typeof descriptor, Attributes, WriteAttributes>(descriptor, {
      baseUrl: BASE,
      transport,
    })
    const qc = jsonApiQueryClient()
    const get = getQueryOptions(client, 'inboxes', undefined)
    await qc.fetchQuery(get)
    const options = updateMutationOptions(qc, client, descriptor, 'inboxes', undefined, {
      optimistic: true,
    })
    const pending = runMutation(qc, options, { id: '42', seenUpTo: '2026-11-16T09:30:00+00:00' })
    await Promise.resolve()
    expect(qc.getQueryData(get.queryKey)).toMatchObject({
      seenUpTo: '2026-11-16T09:30:00+00:00',
    })
    release?.()
    await pending
  })

  it("invalidates the singleton's reads after a relationship set", async () => {
    const { client, requests } = makeClient((req) =>
      req.url.endsWith('/relationships/owner')
        ? { data: { type: 'people', id: 'per-2' } }
        : { data: inbox },
    )
    const qc = jsonApiQueryClient()
    const get = getQueryOptions(client, 'inboxes', undefined)
    const related = relatedQueryOptions(client, 'inboxes', undefined, 'owner')
    await qc.fetchQuery(get)
    await qc.fetchQuery(related)
    const set = setRelationshipMutationOptions(
      qc,
      client,
      descriptor,
      'inboxes',
      undefined,
      'owner',
    )
    await runMutation(qc, set, { type: 'people', id: 'per-2' })
    expect(
      requests.some(
        (req) => req.method === 'PATCH' && req.url === `${BASE}/inbox/relationships/owner`,
      ),
    ).toBe(true)
    expect(qc.getQueryState(get.queryKey)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(related.queryKey)?.isInvalidated).toBe(true)
    expect(singletonRelationReadKeys('inboxes', 'owner')).toEqual([
      ['inboxes', 'fetchRelated', 'owner'],
      ['inboxes', 'fetchRelationship', 'owner'],
    ])
  })
})
