import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { QueryClient } from '@tanstack/query-core'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { installNormalization } from './install'
import { updateMutationOptions } from './mutate'
import { JsonApiMutationCache } from './mutation-cache'
import { serverValueOf } from './normalize'
import { getQueryOptions, listQueryOptions } from './read'

const BASE = 'https://shop.example'

// Products whose `values` object takes single keys through `fields`.
const descriptor = {
  products: {
    attributes: { name: 'string', values: 'object', place: 'object', lines: 'array' },
    relations: {},
    paths: { fetchMany: '/products', fetchOne: '/products/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    nestedFieldsets: { values: '[^.,]+', place: '(?:postcode|geo)', lines: '\\*' },
    nestedFieldsetPaths: {
      place: [['geo', '(?:lat|lng)']],
      lines: [['\\*', '(?:sku|qty)']],
    },
  },
} as const satisfies ApiDescriptor

interface Attributes {
  products: {
    name: string
    values: Record<string, number> | null
    place: { postcode: string; geo: { lat: number; lng: number } | null } | null
    lines: { sku: string; qty: number }[] | null
  }
}

type Place = Attributes['products']['place']

const placed = (place: unknown) => ({ type: 'products', id: 'p-1', attributes: { place } })

const lined = (lines: unknown) => ({ type: 'products', id: 'p-1', attributes: { lines } })

const product = (values: Record<string, number> | null, name = 'Widget') => ({
  type: 'products',
  id: 'p-1',
  attributes: { name, values },
})

/** A client answering each request with the next queued body. */
function setup(...bodies: unknown[]) {
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    void req
    return { status: 200, headers: {}, body: JSON.stringify(bodies.shift()) }
  }
  const client = createClient<typeof descriptor, Attributes>(descriptor, {
    baseUrl: BASE,
    transport,
  })
  const queryClient = new QueryClient()
  installNormalization(queryClient, descriptor)
  return { client, queryClient }
}

describe('a read narrowed to single keys', () => {
  it('types its result as the client does', async () => {
    const { client, queryClient } = setup({ data: [product({ cap: 3 })] })
    const list = await queryClient.fetchQuery(
      listQueryOptions(client, 'products', { fields: { products: ['values.cap'] } }),
    )
    expectTypeOf(list[0]!.values).toEqualTypeOf<{ cap?: number } | null>()
    expect(list[0]!.values).toEqual({ cap: 3 })
    expect(list[0]!.$nestedFieldset).toEqual({ values: ['cap'] })
  })

  it('merges its keys into a cached whole value instead of replacing it', async () => {
    const { client, queryClient } = setup(
      { data: product({ cap: 1, floor: 0 }) },
      { data: [product({ cap: 5 }, 'Renamed')] },
    )
    const whole = await queryClient.fetchQuery(getQueryOptions(client, 'products', 'p-1'))
    await queryClient.fetchQuery(
      listQueryOptions(client, 'products', { fields: { products: ['name', 'values.cap'] } }),
    )
    const cached = queryClient.getQueryData(getQueryOptions(client, 'products', 'p-1').queryKey)
    expect(cached).toMatchObject({ name: 'Renamed', values: { cap: 5, floor: 0 } })
    expect(whole.values).toEqual({ cap: 5, floor: 0 })
  })

  it('takes a whole value over a narrowed one, and a narrowed null as the whole value', async () => {
    const { client, queryClient } = setup(
      { data: [product({ cap: 5 })] },
      { data: product({ floor: 2 }) },
      { data: [product(null)] },
    )
    const narrowed = await queryClient.fetchQuery(
      listQueryOptions(client, 'products', { fields: { products: ['values.cap'] } }),
    )
    const whole = await queryClient.fetchQuery(getQueryOptions(client, 'products', 'p-1'))
    // A whole read replaces the narrowed value, which now holds every key.
    expect(narrowed[0]!.values).toEqual({ floor: 2 })
    await queryClient.fetchQuery(
      listQueryOptions(client, 'products', { fields: { products: ['values.floor'] } }),
    )
    expect(whole.values).toBeNull()
  })

  it('merges a path into a nested object without dropping its other cached keys', async () => {
    const { client, queryClient } = setup(
      { data: placed({ postcode: 'N1', geo: { lat: 1, lng: 2 } }) },
      { data: [placed({ geo: { lat: 9 } })] },
    )
    const whole = await queryClient.fetchQuery(getQueryOptions(client, 'products', 'p-1'))
    const list = await queryClient.fetchQuery(
      listQueryOptions(client, 'products', { fields: { products: ['place.geo.lat'] } }),
    )
    expectTypeOf(list[0]!.place).toEqualTypeOf<{ geo?: { lat?: number } | null } | null>()
    expect(whole.place).toEqual({ postcode: 'N1', geo: { lat: 9, lng: 2 } })
  })

  it('replaces a nested object a read lists whole, and keeps one it can only see part of', async () => {
    const { client, queryClient } = setup(
      { data: placed({ postcode: 'N1', geo: { lat: 1, lng: 2 } }) },
      { data: [placed({ geo: { lat: 3, lng: 4 } })] },
      { data: [placed({ geo: null })] },
    )
    const whole = await queryClient.fetchQuery(getQueryOptions(client, 'products', 'p-1'))
    await queryClient.fetchQuery(
      listQueryOptions(client, 'products', {
        fields: { products: ['place.geo.lat', 'place.geo'] },
      }),
    )
    expect(whole.place).toEqual({ postcode: 'N1', geo: { lat: 3, lng: 4 } })
    // A null nested object is its whole value.
    await queryClient.fetchQuery(
      listQueryOptions(client, 'products', { fields: { products: ['place.geo.lng'] } }),
    )
    expect(whole.place).toEqual<Place>({ postcode: 'N1', geo: null })
  })

  it('leaves a cached nested value that is not an object alone', async () => {
    const { client, queryClient } = setup(
      { data: placed({ postcode: 'N1', geo: null }) },
      { data: [placed({ postcode: 'E2', geo: { lat: 5 } })] },
    )
    const whole = await queryClient.fetchQuery(getQueryOptions(client, 'products', 'p-1'))
    await queryClient.fetchQuery(
      listQueryOptions(client, 'products', {
        fields: { products: ['place.postcode', 'place.geo.lat'] },
      }),
    )
    expect(whole.place).toEqual({ postcode: 'E2', geo: null })
  })

  it('merges a path through a list into each cached item at the same index', async () => {
    const { client, queryClient } = setup(
      {
        data: lined([
          { sku: 'A', qty: 1 },
          { sku: 'B', qty: 2 },
        ]),
      },
      { data: [lined([{ qty: 5 }, { qty: 6 }])] },
    )
    const whole = await queryClient.fetchQuery(getQueryOptions(client, 'products', 'p-1'))
    const list = await queryClient.fetchQuery(
      listQueryOptions(client, 'products', { fields: { products: ['lines.*.qty'] } }),
    )
    expectTypeOf(list[0]!.lines).toEqualTypeOf<{ qty?: number }[] | null>()
    expect(whole.lines).toEqual([
      { sku: 'A', qty: 5 },
      { sku: 'B', qty: 6 },
    ])
  })

  it('leaves a cached list of another length alone, and replaces one a read takes whole', async () => {
    const { client, queryClient } = setup(
      { data: lined([{ sku: 'A', qty: 1 }]) },
      { data: [lined([{ qty: 5 }, { qty: 6 }])] },
      { data: [lined([{ sku: 'C', qty: 3 }])] },
    )
    const whole = await queryClient.fetchQuery(getQueryOptions(client, 'products', 'p-1'))
    await queryClient.fetchQuery(
      listQueryOptions(client, 'products', { fields: { products: ['lines.*.qty'] } }),
    )
    // No index pairs a cached item with its fresh part once the list has grown.
    expect(whole.lines).toEqual([{ sku: 'A', qty: 1 }])
    await queryClient.fetchQuery(
      listQueryOptions(client, 'products', { fields: { products: ['lines.*', 'lines.*.qty'] } }),
    )
    expect(whole.lines).toEqual([{ sku: 'C', qty: 3 }])
  })

  it('merges a narrowed union value only into a cached value of the same variant', async () => {
    const { client, queryClient } = setup(
      {
        data: lined([
          { kind: 'part', sku: 'A', qty: 1 },
          { kind: 'part', sku: 'B', qty: 2 },
        ]),
      },
      { data: [lined([{ kind: 'part', qty: 5 }, { kind: 'note' }])] },
    )
    const whole = await queryClient.fetchQuery(getQueryOptions(client, 'products', 'p-1'))
    await queryClient.fetchQuery(
      listQueryOptions(client, 'products', { fields: { products: ['lines.*.qty'] } }),
    )
    // The second item is now a note: part of a note can't stand for the cached part.
    expect(whole.lines).toEqual([
      { kind: 'part', sku: 'A', qty: 5 },
      { kind: 'part', sku: 'B', qty: 2 },
    ])
  })

  it('replaces a cached list a read names through a wildcard alone', async () => {
    const { client, queryClient } = setup(
      { data: lined([{ sku: 'A', qty: 1 }]) },
      { data: [lined([{ qty: 5 }, { sku: 'B' }])] },
    )
    const whole = await queryClient.fetchQuery(getQueryOptions(client, 'products', 'p-1'))
    await queryClient.fetchQuery(
      listQueryOptions(client, 'products', { fields: { products: ['lines.*'] } }),
    )
    expect(whole.lines).toEqual([{ qty: 5 }, { sku: 'B' }])
  })
})

/** The `values` a query's cached product shows. */
const shown = (queryClient: QueryClient, key: readonly unknown[]) =>
  (queryClient.getQueryData(key) as unknown as { values: unknown }).values

describe('a read narrowed to single keys landing on a predicted value (A7 R2)', () => {
  const writable = {
    products: {
      ...descriptor.products,
      paths: { ...descriptor.products.paths, update: '/products/{id}' },
    },
  } as const satisfies ApiDescriptor

  /** A request the test answers when it chooses. */
  interface Held {
    req: TransportRequest
    reply(body: unknown, status?: number): void
  }

  /** A client holding every request until the test answers it, and a QueryClient as an app builds one. */
  function held() {
    const pending: Held[] = []
    const transport = (req: TransportRequest) =>
      new Promise<TransportResponse>((resolve) => {
        pending.push({
          req,
          reply: (body, status = 200) =>
            resolve({ status, headers: {}, body: JSON.stringify(body) }),
        })
      })
    const client = createClient<typeof writable, Attributes>(writable, { baseUrl: BASE, transport })
    const queryClient = new QueryClient({
      mutationCache: new JsonApiMutationCache(),
      defaultOptions: { queries: { staleTime: Infinity } },
    })
    installNormalization(queryClient, writable)
    const request = async (n: number): Promise<Held> => {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(n))
      return pending[n] as Held
    }
    return { client, queryClient, request }
  }

  /**
   * A whole read of the product cached, an optimistic write of its whole `values` pending, and a
   * read narrowed to `values.cap` landed during it.
   */
  async function landed() {
    const h = held()
    const whole = getQueryOptions(h.client, 'products', 'p-1')
    const seeded = h.queryClient.fetchQuery(whole)
    ;(await h.request(0)).reply({ data: product({ cap: 1, floor: 0 }) })
    await seeded

    const update = updateMutationOptions(h.queryClient, h.client, writable, 'products', 'p-1', {
      optimistic: true,
    })
    const written = h.queryClient
      .getMutationCache()
      .build(h.queryClient, update as never)
      .execute({ values: { cap: 10, floor: 20, extra: 30 } } as never)
    const write = await h.request(1)

    // A read narrowed to the `cap` key, started after the write, lands while it is pending.
    const narrowed = listQueryOptions(h.client, 'products', {
      fields: { products: ['values.cap'] },
    })
    const reading = h.queryClient.fetchQuery(narrowed)
    ;(await h.request(2)).reply({ data: [product({ cap: 5 })] })
    await reading
    const node = h.queryClient.getQueryData(whole.queryKey) as unknown as object
    return { queryClient: h.queryClient, whole, written, node, write }
  }

  it('keeps showing the prediction, and records the keys merged into the previous server value', async () => {
    const { queryClient, whole, node, write, written } = await landed()

    expect(shown(queryClient, whole.queryKey)).toEqual({ cap: 10, floor: 20, extra: 30 })
    // The narrowed key merged into the server value the node held, not into the prediction: none
    // of the prediction's keys leak into what a rollback restores.
    expect(serverValueOf(node, 'values')).toEqual({ value: { cap: 5, floor: 0 } })

    write.reply({ data: product({ cap: 10, floor: 20, extra: 30 }) })
    await written
  })

  it('rolls back to that merged server value when the write fails', async () => {
    const { queryClient, whole, write, written } = await landed()

    write.reply({ errors: [{ status: '422', code: 'NO' }] }, 422)
    await expect(written).rejects.toBeDefined()

    expect(shown(queryClient, whole.queryKey)).toEqual({ cap: 5, floor: 0 })
  })

  it('takes the write’s response when the write succeeds', async () => {
    const { queryClient, whole, write, written } = await landed()

    write.reply({ data: product({ cap: 11, floor: 21 }) })
    await written

    expect(shown(queryClient, whole.queryKey)).toEqual({ cap: 11, floor: 21 })
  })
})
