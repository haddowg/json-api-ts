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
    attributes: { name: 'string', values: 'object' },
    relations: {},
    paths: { fetchMany: '/products', fetchOne: '/products/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    selectableKeys: { values: '[^,]+' },
  },
} as const satisfies ApiDescriptor

interface Attributes {
  products: { name: string; values: Record<string, number> | null }
}

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
})
