import { readFileSync } from 'node:fs'
import type { FilterQuery, TransportRequest } from '@haddowg/json-api-client'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient, type resourceMap } from '../test/generated/contract-witness.client.gen'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'

const witness = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument
const descriptor = buildDescriptor(witness)

function witnessClient() {
  const requests: TransportRequest[] = []
  const client = createClient({
    baseUrl: 'https://api.example.com',
    transport: async (req) => {
      requests.push(req)
      return { status: 200, headers: {}, body: JSON.stringify({ data: [] }) }
    },
  })
  return { client, requests }
}

/** The witness with every list filter's `filter[<key>][]` parameter and the `filter` parameter removed. */
function withoutListsOrFamilies(): OpenApiDocument {
  return JSON.parse(JSON.stringify(witness), (key, value: unknown) =>
    key === 'parameters' && Array.isArray(value)
      ? value.filter(
          (param: { name?: string }) => param.name !== 'filter' && !param.name?.endsWith('][]'),
        )
      : value,
  ) as OpenApiDocument
}

/**
 * Core's witness declares three list filters on articles, `categories` (comma form too),
 * `columns` (array form only) and `excludedRegions` (pipe form too), and four filter families:
 * `value` and `exact` take lists, `meta` and the deprecated `legacy` take one value.
 */
describe('generator contract 27 (list filters and filter families)', () => {
  const articles = descriptor['articles']!

  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(38)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('reads each list filter as one filterable key and lists it', () => {
    expect(articles.filterable).toContain('categories')
    expect(articles.filterable).toContain('columns')
    expect(articles.filterable).toContain('excludedRegions')
    expect(articles.filterable!.filter((key) => key.includes('['))).toEqual([])
    expect(articles.listFilters).toEqual(['categories', 'columns', 'excludedRegions'])
  })

  it('reads the families with their suffix patterns and whether they take a list', () => {
    expect(articles.filterFamilies).toEqual([
      { prefix: 'value', suffixPattern: '.+', list: true },
      { prefix: 'exact', suffixPattern: '[a-z][a-z_]*', list: true },
      { prefix: 'meta', suffixPattern: '.+' },
      { prefix: 'legacy', suffixPattern: '.+' },
    ])
  })

  it('carries both onto a collection action taking every filter', () => {
    const count = articles.actions!['count']!
    expect(count.listFilters).toEqual(articles.listFilters)
    expect(count.filterFamilies).toEqual(articles.filterFamilies)
    expect(articles.actions!['bulk-archive']!.listFilters).toBeUndefined()
    expect(articles.actions!['bulk-archive']!.filterFamilies).toBeUndefined()
  })

  it('documents a deprecated family on the emitted descriptor', () => {
    expect(emit(witness, descriptor)).toContain(
      '/** The server marks the `legacy` filter family deprecated. */\n    filterFamilies: [',
    )
  })

  it('emits neither field for a document without them', () => {
    const plain = withoutListsOrFamilies()
    const plainArticles = buildDescriptor(plain)['articles']!
    expect(plainArticles.listFilters).toBeUndefined()
    expect(plainArticles.filterFamilies).toBeUndefined()
    const emitted = emit(plain, buildDescriptor(plain))
    expect(emitted).not.toContain('listFilters')
    expect(emitted).not.toContain('filterFamilies')
  })

  it('types a list filter as a list and a family key by its prefix', () => {
    type Filter = FilterQuery<typeof resourceMap, 'articles'>
    expectTypeOf<NonNullable<Filter['columns']>>().toEqualTypeOf<readonly string[]>()
    expectTypeOf<Filter['status']>().toEqualTypeOf<unknown>()
    expectTypeOf<NonNullable<Filter[`value.${string}`]>>().toEqualTypeOf<readonly string[]>()
    expectTypeOf<NonNullable<Filter[`meta.${string}`]>>().toEqualTypeOf<string>()
  })

  it('sends a list filter and a list family once per member, commas kept', async () => {
    const { client, requests } = witnessClient()
    await client.articles.list({
      filter: {
        columns: ['last,first', 'email'],
        categories: ['news'],
        labels: ['a', 'b'],
        'value.cap': ['x,y', 'z'],
        'meta.colour': 'red',
      },
    })
    const query = decodeURIComponent(requests[0]!.url.split('?')[1]!)
    expect(query.split('&')).toEqual([
      'filter[columns][]=last,first',
      'filter[columns][]=email',
      'filter[categories][]=news',
      'filter[labels]=a,b',
      'filter[value.cap][]=x,y',
      'filter[value.cap][]=z',
      'filter[meta.colour]=red',
    ])
  })

  it('sends a collection action its list filters and families the same way', async () => {
    const { client, requests } = witnessClient()
    await client.articles.actions.count({
      filter: { columns: ['a,b'], 'exact.region': ['eu'] },
    })
    expect(decodeURIComponent(requests[0]!.url)).toContain(
      'filter[columns][]=a,b&filter[exact.region][]=eu',
    )
  })

  it('rejects a key outside the filters and families at compile time', async () => {
    const { client } = witnessClient()
    // @ts-expect-error — `values` is not a family prefix.
    await client.articles.list({ filter: { 'values.cap': ['x'] } })
    // @ts-expect-error — a list filter takes a list.
    await client.articles.list({ filter: { columns: 1 } })
    // @ts-expect-error — `meta` takes one value.
    await client.articles.list({ filter: { 'meta.colour': ['red'] } })
  })
})

/**
 * Contract 27 also marks related-only types, which serve no endpoint of their own, so a server can
 * stamp it with no list filter or filter family anywhere. The witness's `credits` is one.
 */
describe('generator contract 27 from related-only types alone', () => {
  const doc = withoutListsOrFamilies()
  doc.info!['x-generator'] = { contract: 27 }
  const relatedOnly = buildDescriptor(doc)

  it('reads the document without a warning', () => {
    expect(checkContract(doc)).toBeUndefined()
  })

  it('reads no list filters or families', () => {
    for (const type of Object.values(relatedOnly)) {
      expect(type.listFilters).toBeUndefined()
      expect(type.filterFamilies).toBeUndefined()
    }
  })

  it('gives a related-only type no paths but keeps its members', () => {
    expect(relatedOnly['credits']).toMatchObject({
      attributes: { role: 'string' },
      relations: { person: { cardinality: 'one', types: ['people'] } },
      paths: {},
    })
  })

  it('keeps a related-only type as an action input and output', () => {
    expect(relatedOnly['videos']!.actions!['credit']).toMatchObject({
      inputType: 'credits',
      outputType: 'credits',
    })
  })
})
