import {
  type ApiDescriptor,
  createClient,
  type DefaultActionTypes,
  type DefaultWriteAttributes,
  JsonApiError,
  StructuralGuardError,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import {
  type DataTag,
  hashKey,
  QueryClient,
  QueryObserver,
  type QueryObserverOptions,
  type SkipToken,
  skipToken,
} from '@tanstack/query-core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { installNormalization } from './install'
import type { QueryKey } from './keys'
import {
  createQueryApi,
  type FetchOneResult,
  getQueryOptions,
  jsonApiRetry,
  listQueryOptions,
  type QueryOptions,
  type ReadError,
  relatedQueryOptions,
  relationshipQueryOptions,
  type SkippableQueryOptions,
} from './read'

const BASE = 'https://music.example'

const descriptor = {
  albums: {
    attributes: { title: 'string' },
    relations: { artist: { cardinality: 'one', types: ['artists'], pivot: false } },
    paths: {
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
      fetchRelationship: '/albums/{id}/relationships/{rel}',
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
  inboxes: {
    attributes: { unread: 'number' },
    relations: { owner: { cardinality: 'one', types: ['artists'], pivot: false } },
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
  inboxes: { unread: number }
}
type ErrorCode = 'ALBUM_GONE' | 'RATE_LIMITED'

/** A transport answering every request with `status` (an album document on a 2xx), counting calls. */
function transportReplying(status: number) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    if (status >= 400) {
      return { status, headers: {}, body: JSON.stringify({ errors: [{ status: String(status) }] }) }
    }
    return {
      status,
      headers: {},
      body: JSON.stringify({ data: { type: 'albums', id: '1', attributes: { title: 'A' } } }),
    }
  }
  return { transport, requests }
}

function makeClient(status = 200) {
  const { transport, requests } = transportReplying(status)
  const client = createClient<
    D,
    Attributes,
    DefaultWriteAttributes<D>,
    DefaultActionTypes,
    ErrorCode
  >(descriptor, { baseUrl: BASE, transport })
  return { client, requests }
}

/** What a framework's `useQuery`/`injectQuery` infers from options, via query-core's own types. */
function inferred<TQueryFnData, TError, TQueryKey extends readonly unknown[]>(
  options: QueryObserverOptions<TQueryFnData, TError, TQueryFnData, TQueryFnData, TQueryKey>,
): { data: TQueryFnData; error: TError } {
  return options as never
}

describe('typed read keys', () => {
  it('types getQueryData and setQueryData with the materialised result', async () => {
    const { client } = makeClient()
    const qc = new QueryClient()
    const options = getQueryOptions(client, 'albums', '1')
    await qc.fetchQuery(options)

    const cached = qc.getQueryData(options.queryKey)
    expectTypeOf(cached).toEqualTypeOf<FetchOneResult<D, Attributes, 'albums'> | undefined>()
    expect(cached?.title).toBe('A')

    qc.setQueryData(options.queryKey, (old) => {
      expectTypeOf(old?.title).toEqualTypeOf<string | undefined>()
      return old
    })
    // @ts-expect-error a cached album is not a string
    qc.setQueryData(options.queryKey, 'not an album')
  })

  it('keeps the runtime key a plain tuple, usable as a QueryKey', () => {
    const { client } = makeClient()
    const key = listQueryOptions(client, 'albums').queryKey
    expect(key).toEqual(['albums', 'fetchMany'])
    expectTypeOf(key).toExtend<QueryKey>()
    expectTypeOf(key).toExtend<DataTag<QueryKey, unknown, unknown>>()
  })
})

describe('typed read errors', () => {
  it('carries the client error-code union into what useQuery infers', () => {
    const { client } = makeClient()
    const api = createQueryApi(client)
    const list = inferred(api.albums.list({ include: ['artist'] }))
    expectTypeOf(list.error).toEqualTypeOf<ReadError<ErrorCode>>()
    expectTypeOf<(typeof list.data)[number]['title']>().toEqualTypeOf<string>()

    const one = inferred(getQueryOptions(client, 'albums', '1'))
    expectTypeOf(one.error).toEqualTypeOf<JsonApiError<ErrorCode> | StructuralGuardError | Error>()
    expectTypeOf(inferred(api.inboxes.get()).error).toEqualTypeOf<ReadError<ErrorCode>>()
    expectTypeOf(
      inferred(relatedQueryOptions(client, 'albums', '1', 'artist')).error,
    ).toEqualTypeOf<ReadError<ErrorCode>>()
  })

  it("types a QueryObserver's error", () => {
    const { client } = makeClient()
    const observer = new QueryObserver(new QueryClient(), getQueryOptions(client, 'albums', '1'))
    expectTypeOf(observer.getCurrentResult().error).toEqualTypeOf<ReadError<ErrorCode> | null>()
  })

  it('falls back to string codes for a client that carries none', () => {
    const plain = createClient(descriptor, { baseUrl: BASE })
    expectTypeOf(inferred(listQueryOptions(plain, 'albums')).error).toEqualTypeOf<
      ReadError<string>
    >()
  })
})

describe('jsonApiRetry', () => {
  it('never retries a 4xx JsonApiError or a StructuralGuardError', () => {
    expect(jsonApiRetry(0, new JsonApiError(404, []))).toBe(false)
    expect(jsonApiRetry(0, new JsonApiError(429, []))).toBe(false)
    expect(jsonApiRetry(0, new StructuralGuardError('not a document'))).toBe(false)
  })

  it('retries a 5xx or any other error while failureCount < 3', () => {
    expect(jsonApiRetry(0, new JsonApiError(503, []))).toBe(true)
    expect(jsonApiRetry(2, new TypeError('network'))).toBe(true)
    expect(jsonApiRetry(3, new JsonApiError(500, []))).toBe(false)
  })

  it('fits a QueryClient default', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: jsonApiRetry } } })
    expect(qc.getDefaultOptions().queries?.retry).toBe(jsonApiRetry)
  })
})

describe('read options', () => {
  it('declare retry for typing but carry no retry property, so the defaults apply', () => {
    const { client } = makeClient()
    const api = createQueryApi(client)
    const all = [
      listQueryOptions(client, 'albums'),
      getQueryOptions(client, 'albums', '1'),
      relationshipQueryOptions(client, 'albums', '1', 'artist'),
      relatedQueryOptions(client, 'albums', '1', 'artist'),
      api.albums.get('1'),
      api.albums.get(skipToken),
      api.albums.list(skipToken),
      api.inboxes.get(),
      api.inboxes.related('owner', skipToken),
    ]
    for (const options of all) {
      expect(Object.hasOwn(options, 'retry')).toBe(false)
    }
  })
})

describe('installNormalization retry default', () => {
  it('installs jsonApiRetry when the app configured no retry, keeping the other defaults', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 5 } } })
    const teardown = installNormalization(qc, descriptor)
    expect(qc.getDefaultOptions().queries?.retry).toBe(jsonApiRetry)
    expect(qc.getDefaultOptions().queries?.staleTime).toBe(5)
    teardown()
    expect(qc.getDefaultOptions().queries).toEqual({ staleTime: 5 })
  })

  it.each([false, 1, () => true])('keeps the retry the app configured (%s)', (retry) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry } } })
    const teardown = installNormalization(qc, descriptor)
    expect(qc.getDefaultOptions().queries?.retry).toBe(retry)
    teardown()
    expect(qc.getDefaultOptions().queries?.retry).toBe(retry)
  })

  it('leaves a retry set after install in place on teardown', () => {
    const qc = new QueryClient()
    const teardown = installNormalization(qc, descriptor)
    qc.setDefaultOptions({ queries: { retry: 2 } })
    teardown()
    expect(qc.getDefaultOptions().queries?.retry).toBe(2)
  })
})

describe('a read that fails', () => {
  async function observe(qc: QueryClient, status: number) {
    const { client, requests } = makeClient(status)
    const observer = new QueryObserver(qc, createQueryApi(client).albums.get('1'))
    const settled = new Promise<void>((resolve) => {
      observer.subscribe((result) => {
        if (result.status === 'error') {
          resolve()
        }
      })
    })
    await settled
    return { requests, error: observer.getCurrentResult().error }
  }

  function installed() {
    const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
    installNormalization(qc, descriptor)
    return qc
  }

  it('is not retried on a 4xx under the installed default', async () => {
    const { requests, error } = await observe(installed(), 404)
    expect(requests).toHaveLength(1)
    expect(error).toBeInstanceOf(JsonApiError)
  })

  it('is retried three times on a 5xx under the installed default', async () => {
    const { requests } = await observe(installed(), 503)
    expect(requests).toHaveLength(4)
  })

  it("follows the app's retry: false", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    installNormalization(qc, descriptor)
    const { requests } = await observe(qc, 503)
    expect(requests).toHaveLength(1)
  })

  it('is retried by fetchQuery under the installed default', async () => {
    const { client, requests } = makeClient(503)
    await expect(
      installed().fetchQuery(createQueryApi(client).albums.get('1')),
    ).rejects.toBeInstanceOf(JsonApiError)
    expect(requests).toHaveLength(4)
  })
})

describe('skipToken', () => {
  it('skips a get read in place of the id', () => {
    const { client } = makeClient()
    const id = undefined as string | undefined
    const options = createQueryApi(client).albums.get(id ?? skipToken)
    expect(options.queryFn).toBe(skipToken)
    expect(options.queryKey).toEqual(['albums', 'fetchOne', { $skip: true }])
    expectTypeOf(options).toEqualTypeOf<
      SkippableQueryOptions<FetchOneResult<D, Attributes, 'albums'>, ReadError<ErrorCode>>
    >()
    expectTypeOf(options.queryFn).toEqualTypeOf<
      | ((context?: { signal: AbortSignal }) => Promise<FetchOneResult<D, Attributes, 'albums'>>)
      | SkipToken
    >()
    expectTypeOf(inferred(options).data).toEqualTypeOf<FetchOneResult<D, Attributes, 'albums'>>()
  })

  it('leaves a read with a real id unskippable in its type', () => {
    const { client } = makeClient()
    const options = createQueryApi(client).albums.get('1')
    expectTypeOf(options).toEqualTypeOf<
      QueryOptions<FetchOneResult<D, Attributes, 'albums'>, ReadError<ErrorCode>>
    >()
    expect(typeof options.queryFn).toBe('function')
  })

  it("never shares a skipped read's key with a real id", () => {
    const { client } = makeClient()
    const api = createQueryApi(client)
    const skipped = api.albums.get(skipToken).queryKey
    expect(api.albums.get('$skip').queryKey).not.toEqual(skipped)
    expect(hashKey(api.albums.get('$skip').queryKey)).not.toBe(hashKey(skipped))
  })

  it('skips a list in place of the query', () => {
    const { client } = makeClient()
    const search = undefined as string | undefined
    const options = listQueryOptions(
      client,
      'albums',
      search === undefined ? skipToken : { include: ['artist'] },
    )
    expect(options.queryFn).toBe(skipToken)
    expect(options.queryKey).toEqual(['albums', 'fetchMany', { $skip: true }])
    expect(createQueryApi(client).albums.list(skipToken).queryKey).toEqual([
      'albums',
      'fetchMany',
      { $skip: true },
    ])
  })

  it('skips relation reads in place of the id, keeping the relation in the key', () => {
    const { client } = makeClient()
    const api = createQueryApi(client)
    expect(api.albums.related(skipToken, 'artist').queryKey).toEqual([
      'albums',
      'fetchRelated',
      { $skip: true },
      'artist',
    ])
    const linkage = relationshipQueryOptions(client, 'albums', skipToken, 'artist')
    expect(linkage.queryFn).toBe(skipToken)
    expect(linkage.queryKey).toEqual(['albums', 'fetchRelationship', { $skip: true }, 'artist'])
  })

  it("skips a singleton's reads in place of the query", () => {
    const { client } = makeClient()
    const api = createQueryApi(client)
    const get = api.inboxes.get(skipToken)
    expect(get.queryFn).toBe(skipToken)
    expect(get.queryKey).toEqual(['inboxes', 'fetchOne', { $skip: true }])
    expect(api.inboxes.related('owner', skipToken).queryKey).toEqual([
      'inboxes',
      'fetchRelated',
      { $skip: true },
      'owner',
    ])
    expect(getQueryOptions(client, 'inboxes', skipToken).queryFn).toBe(skipToken)
  })

  it('never sends a request for a skipped read', async () => {
    const { client, requests } = makeClient()
    const qc = new QueryClient()
    const observer = new QueryObserver(qc, createQueryApi(client).albums.get(skipToken))
    const unsubscribe = observer.subscribe(() => undefined)
    await Promise.resolve()
    expect(observer.getCurrentResult().fetchStatus).toBe('idle')
    expect(requests).toHaveLength(0)
    unsubscribe()
  })
})
