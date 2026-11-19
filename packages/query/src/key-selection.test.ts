import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { QueryClient } from '@tanstack/query-core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { installNormalization } from './install'
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
    selectableKeys: { values: '[^.,]+', place: '(?:postcode|geo)', lines: '\\*' },
    selectableKeyPaths: {
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
    expect(list[0]!.$keySelection).toEqual({ values: ['cap'] })
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
})
