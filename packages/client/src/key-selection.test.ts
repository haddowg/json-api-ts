import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import { fieldsOfUrl, keySelection } from './key-selection'
import type { FieldsMap, KeyMember, MemberName } from './result-types'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'
const FIELD_SELECTION = 'https://haddowg.github.io/json-api/profiles/field-selection/'

// Products whose `values` (an open object) and `totals` (a closed one) take single keys, and whose
// `lines` take keys of every item through `*`.
const descriptor = {
  products: {
    attributes: {
      name: 'string',
      values: 'object',
      totals: 'object',
      notes: 'object',
      lines: 'array',
      media: 'unknown',
      panel: 'object',
    },
    relations: {
      maker: { cardinality: 'one', types: ['makers'], pivot: false, mutations: { set: true } },
    },
    paths: { fetchMany: '/products', fetchOne: '/products/{id}', update: '/products/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
    selectableKeys: {
      values: '[a-z]+',
      totals: '[^,]+',
      lines: '\\*',
      media: '(?:text|src|size)',
      panel: '[a-z]+',
    },
    selectableKeyPaths: {
      panel: [['media', '(?:text|src)']],
      lines: [
        ['\\*', '(?:sku|qty|price)'],
        ['\\*', 'price', '(?:amount|currency)'],
      ],
    },
  },
  makers: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchOne: '/makers/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

interface Attributes {
  products: {
    name: string
    values: Record<string, number | null> | null
    totals: { views: number; shares: number; geo: { lat: number; lng: number } | null }
    notes: { text: string }
    lines: { sku: string; qty: number; price: { amount: number; currency: string } | null }[] | null
    media: Media | null
    panel: { title: string; media: Media }
  }
  makers: { name: string }
}

type Media =
  | { kind: 'note'; text: string }
  | { kind: 'photo'; src: string; size: { width: number; height: number } }

interface WriteAttributes {
  products: { update: { name?: string } }
}

const narrowed = {
  type: 'products',
  id: 'p-1',
  attributes: { name: 'Widget', values: { cap: 3 } },
}

function recorder(
  body: unknown = { data: narrowed },
  headers: Record<string, string> = {
    'content-type': `application/vnd.api+json; profile="${FIELD_SELECTION}"`,
  },
) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    return { status: 200, headers, body: JSON.stringify(body) }
  }
  const client = createClient<typeof descriptor, Attributes, WriteAttributes>(descriptor, {
    baseUrl: BASE,
    transport,
  })
  return { requests, client }
}

describe('keySelection', () => {
  it('collects the keys of each attribute only key members name', () => {
    expect(keySelection(['name', 'values.cap', 'values.countries', 'values.cap'])).toEqual({
      values: ['cap', 'countries'],
    })
    // The path is everything after the first full stop.
    expect(keySelection(['values.a.b'])).toEqual({ values: ['a.b'] })
  })

  it('keeps a key listed whole over a path into it, at every level', () => {
    expect(
      keySelection(['totals.geo.lat', 'totals.views', 'totals.geo', 'totals.geo.lng']),
    ).toEqual({ totals: ['views', 'geo'] })
    expect(keySelection(['totals.a.b.c', 'totals.a.b', 'totals.a.d'])).toEqual({
      totals: ['a.b', 'a.d'],
    })
    // A key that only shares a prefix with another is a different key.
    expect(keySelection(['totals.geo', 'totals.geodata.lat'])).toEqual({
      totals: ['geo', 'geodata.lat'],
    })
    expect(keySelection(['totals.geo.', 'totals..lat'])).toEqual({})
  })

  it('reads a path through every item of a list, with the items listed whole winning', () => {
    expect(keySelection(['lines.*.sku', 'lines.*.price.amount'])).toEqual({
      lines: ['*.sku', '*.price.amount'],
    })
    expect(keySelection(['lines.*.sku', 'lines.*'])).toEqual({})
    expect(keySelection(['lines.*'])).toEqual({})
    expect(keySelection(['name', 'lines.*'])).toEqual({})
    expect(keySelection(['lines.*.tags.*', 'lines.*.sku'])).toEqual({ lines: ['*.tags', '*.sku'] })
    expect(keySelection(['totals.parcels.*', 'totals.parcels.*.weight'])).toEqual({
      totals: ['parcels'],
    })
    expect(keySelection(['lines', 'lines.*.sku'])).toEqual({})
    expect(keySelection(['lines.*.price', 'lines.*.price.amount'])).toEqual({
      lines: ['*.price'],
    })
  })

  it('leaves out an attribute listed whole, and members with no key or no attribute', () => {
    expect(keySelection(['values.cap', 'values', 'totals.'])).toEqual({})
    expect(keySelection(['.cap'])).toEqual({})
    expect(keySelection(undefined)).toEqual({})
  })

  it('reads the fieldsets of a followed link', () => {
    expect(
      fieldsOfUrl(`${BASE}/products?fields%5Bproducts%5D=name%2Cvalues.cap&page%5Bnumber%5D=2`),
    ).toEqual({ products: ['name', 'values.cap'] })
    expect(fieldsOfUrl('/products?fields[makers]=')).toEqual({ makers: [] })
    expect(fieldsOfUrl(`${BASE}/products?page[number]=2`)).toBeUndefined()
  })
})

describe('selecting single keys through fields', () => {
  it('sends key members as given and reads the response whatever profile it names', async () => {
    const { requests, client } = recorder()
    const product = await client.products.get('p-1', {
      fields: { products: ['name', 'values.cap'] },
    })
    expect(decodeURIComponent(requests[0]!.url)).toBe(
      `${BASE}/products/p-1?fields[products]=name,values.cap`,
    )
    // The client never asks for the profile.
    expect(requests[0]!.headers['Accept']).toBe('application/vnd.api+json')
    expect(product.values).toEqual({ cap: 3 })
    expect(product.$keySelection).toEqual({ values: ['cap'] })
    expect(Object.keys(product)).toEqual(['type', 'id', 'name', 'values'])
  })

  it('marks nothing narrowed when the attribute is listed whole or no fields were sent', async () => {
    const whole = await recorder().client.products.get('p-1', {
      fields: { products: ['values', 'values.cap'] },
    })
    expect(whole.$keySelection).toEqual({})
    const plain = await recorder({ data: narrowed }, {}).client.products.get('p-1')
    expect(plain.$keySelection).toEqual({})
  })

  it('narrows the resources a write answers with, and a page a link fetches', async () => {
    const { client } = recorder()
    const updated = await client.products
      .id('p-1')
      .update({ name: 'Widget' }, { fields: { products: ['name', 'totals.views'] } })
    expect(updated.$keySelection).toEqual({ totals: ['views'] })

    const page = {
      data: [narrowed],
      links: { next: `${BASE}/products?fields%5Bproducts%5D=values.cap&page%5Bnumber%5D=2` },
    }
    const listed = await recorder(page).client.products.list({
      fields: { products: ['values.cap'] },
    })
    expect(listed[0]!.$keySelection).toEqual({ values: ['cap'] })
    const next = await listed.$next()
    expect(next?.[0]?.$keySelection).toEqual({ values: ['cap'] })
  })

  it('types key members for the attributes that declare them', () => {
    expectTypeOf<KeyMember<typeof descriptor, 'products'>>().toEqualTypeOf<
      | `values.${string}`
      | `totals.${string}`
      | `lines.${string}`
      | `media.${string}`
      | `panel.${string}`
    >()
    expectTypeOf<KeyMember<typeof descriptor, 'makers'>>().toBeNever()
    expectTypeOf<'values.cap'>().toExtend<MemberName<typeof descriptor, 'products'>>()
    expectTypeOf<'notes.text'>().not.toExtend<MemberName<typeof descriptor, 'products'>>()
    expectTypeOf<'maker.name'>().not.toExtend<MemberName<typeof descriptor, 'products'>>()
    expectTypeOf<{ products: readonly ['name', 'totals.views'] }>().toExtend<
      FieldsMap<typeof descriptor>
    >()
  })

  it('types an attribute narrowed by key members as only those keys, each optional', async () => {
    const { client } = recorder()
    const product = await client.products.get('p-1', {
      fields: { products: ['name', 'values.cap', 'totals.views', 'totals.shares'] },
    })
    expectTypeOf(product.name).toEqualTypeOf<string>()
    expectTypeOf(product.values).toEqualTypeOf<{ cap?: number | null } | null>()
    expectTypeOf(product.totals).toEqualTypeOf<{ views?: number; shares?: number }>()
    expectTypeOf(product).not.toHaveProperty('notes')
    expectTypeOf(product).not.toHaveProperty('maker')

    // An attribute listed whole stays whole.
    const whole = await client.products.get('p-1', {
      fields: { products: ['totals', 'totals.views'] },
    })
    expectTypeOf(whole.totals).toEqualTypeOf<Attributes['products']['totals']>()

    // A selection the client can't list keeps every key, each optional.
    const fields: readonly MemberName<typeof descriptor, 'products'>[] = ['values.cap']
    const loose = await client.products.get('p-1', { fields: { products: fields } })
    expectTypeOf(loose.totals).toEqualTypeOf<Attributes['products']['totals']>()

    await client.products.get('p-1', {
      // @ts-expect-error -- notes declares no selectable keys.
      fields: { products: ['notes.text'] },
    })
  })

  it('types a path into a nested object as that object narrowed in turn', async () => {
    const { client } = recorder()
    const product = await client.products.get('p-1', {
      fields: { products: ['totals.views', 'totals.geo.lat'] },
    })
    expectTypeOf(product.totals).toEqualTypeOf<{ views?: number; geo?: { lat?: number } | null }>()

    // A key listed whole beside a path into it stays whole.
    const geo = await client.products.get('p-1', {
      fields: { products: ['totals.geo.lat', 'totals.geo'] },
    })
    expectTypeOf(geo.totals).toEqualTypeOf<{ geo?: { lat: number; lng: number } | null }>()
  })

  it('types a path through a list as every item narrowed in turn', async () => {
    const { client } = recorder()
    const product = await client.products.get('p-1', {
      fields: { products: ['lines.*.sku', 'lines.*.price.amount'] },
    })
    expectTypeOf(product.lines).toEqualTypeOf<
      { sku?: string; price?: { amount?: number } | null }[] | null
    >()

    // The items listed whole, or the list itself, stay whole.
    const items = await client.products.get('p-1', {
      fields: { products: ['lines.*', 'lines.*.sku'] },
    })
    expectTypeOf(items.lines).toEqualTypeOf<Attributes['products']['lines']>()
    const list = await client.products.get('p-1', {
      fields: { products: ['lines', 'lines.*.sku'] },
    })
    expectTypeOf(list.lines).toEqualTypeOf<Attributes['products']['lines']>()
  })

  it('reads the paths of a selection through a list', async () => {
    const { client } = recorder({
      data: { type: 'products', id: 'p-1', attributes: { lines: [{ sku: 'A1' }, {}] } },
    })
    const product = await client.products.get('p-1', { fields: { products: ['lines.*.sku'] } })
    expect(product.$keySelection).toEqual({ lines: ['*.sku'] })
    expect(product.lines).toEqual([{ sku: 'A1' }, {}])
  })

  it('types a union attribute or a union inside an object by variant, keeping its discriminator', async () => {
    const { client } = recorder()
    const product = await client.products.get('p-1', {
      fields: { products: ['media.text', 'media.size.width', 'panel.media.src'] },
    })
    expectTypeOf(product.media).toEqualTypeOf<
      { kind: 'note'; text?: string } | { kind: 'photo'; size?: { width?: number } } | null
    >()
    expectTypeOf(product.panel).toEqualTypeOf<{
      media?: { kind: 'note' } | { kind: 'photo'; src?: string }
    }>()
  })

  it('reads a list named through a wildcard alone as the whole list', async () => {
    const { client } = recorder({
      data: { type: 'products', id: 'p-1', attributes: { lines: [{ sku: 'A1', qty: 2 }] } },
    })
    const product = await client.products.get('p-1', { fields: { products: ['lines.*'] } })
    expect(product.$keySelection).toEqual({})
    expectTypeOf(product.lines).toEqualTypeOf<Attributes['products']['lines']>()
  })

  it('reads the paths of a nested selection', async () => {
    const { client } = recorder({
      data: { type: 'products', id: 'p-1', attributes: { totals: { geo: { lat: 1 } } } },
    })
    const product = await client.products.get('p-1', {
      fields: { products: ['totals.geo.lat'] },
    })
    expect(product.$keySelection).toEqual({ totals: ['geo.lat'] })
    expect(product.totals).toEqual({ geo: { lat: 1 } })
  })
})
