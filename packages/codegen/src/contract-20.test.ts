import { readFileSync } from 'node:fs'
import type { SortToken, TransportRequest } from '@haddowg/json-api-client'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient, type resourceMap } from '../test/generated/contract-witness.client.gen'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument, SchemaObject } from './openapi'
import { type DocumentName, documentPath } from '../test/documents'

function load(name: DocumentName): OpenApiDocument {
  const path = documentPath(name)
  return JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument
}

const witness = load('contract-witness.json')
const descriptor = buildDescriptor(witness)

/**
 * The witness with each `sort` parameter's items rewritten by `items`. Its `x-sort-families`
 * stays only while the rewritten items keep their `anyOf`.
 */
function withSortItems(items: (schema: SchemaObject) => SchemaObject): OpenApiDocument {
  return JSON.parse(JSON.stringify(witness), (key, value: unknown) => {
    if (key !== 'parameters' || !Array.isArray(value)) {
      return value
    }
    return value.map((param: { name?: string; schema?: SchemaObject }) => {
      if (param.name !== 'sort' || param.schema?.items === undefined) {
        return param
      }
      const { 'x-sort-families': families, ...schema } = param.schema
      const rewritten = items(param.schema.items)
      return {
        ...param,
        schema:
          rewritten.anyOf === undefined
            ? { ...schema, items: rewritten }
            : { ...schema, items: rewritten, 'x-sort-families': families },
      }
    })
  }) as OpenApiDocument
}

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

describe('generator contract 20 (sort families)', () => {
  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(29)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('keeps the fixed keys and lists each family beside them', () => {
    const articles = descriptor['articles']!
    expect(articles.sortable).toEqual([
      'title',
      '-title',
      'wordCount',
      '-wordCount',
      'length',
      '-length',
    ])
    expect(articles.sortFamilies).toEqual([
      { prefix: 'legacy', suffixPattern: '[^,]+' },
      { prefix: 'meta', suffixPattern: '[a-z][a-z_]*' },
      { prefix: 'custom.fields', suffixPattern: '[^,]+' },
    ])
  })

  it('reads a sort parameter that has families and no fixed keys', () => {
    const familiesOnly = withSortItems((items) => ({
      anyOf: (items.anyOf ?? []).filter((branch) => branch.enum === undefined),
    }))
    const articles = buildDescriptor(familiesOnly)['articles']!
    expect(articles.sortable).toBeUndefined()
    expect(articles.sortFamilies?.map((family) => family.prefix)).toEqual([
      'legacy',
      'meta',
      'custom.fields',
    ])
  })

  it('emits the same client as before for a plain sort enum', () => {
    const plain = withSortItems((items) => items.anyOf?.find((b) => b.enum !== undefined) ?? items)
    const articles = buildDescriptor(plain)['articles']!
    expect(articles.sortable).toEqual([
      'title',
      '-title',
      'wordCount',
      '-wordCount',
      'length',
      '-length',
    ])
    expect(articles.sortFamilies).toBeUndefined()
    expect(emit(plain, buildDescriptor(plain))).not.toContain('sortFamilies')
  })

  it('emits the families on the type descriptor', () => {
    expect(emit(witness, descriptor)).toContain(
      '      {\n        prefix: "meta",\n        suffixPattern: "[a-z][a-z_]*"',
    )
  })

  it('types a family key at the call site and sends it as written', async () => {
    expectTypeOf<SortToken<typeof resourceMap, 'articles'>>().toEqualTypeOf<
      | 'title'
      | '-title'
      | 'wordCount'
      | '-wordCount'
      | 'length'
      | '-length'
      | `legacy.${string}`
      | `-legacy.${string}`
      | `meta.${string}`
      | `-meta.${string}`
      | `custom.fields.${string}`
      | `-custom.fields.${string}`
    >()

    const { client, requests } = witnessClient()
    await client.articles.list({ sort: ['-meta.anything', 'custom.fields.colour', 'title'] })
    expect(decodeURIComponent(requests[0]!.url)).toContain(
      'sort=-meta.anything,custom.fields.colour,title',
    )
    // @ts-expect-error — `met` is not a family prefix.
    await client.articles.list({ sort: 'met.anything' })
    // @ts-expect-error — a family key needs its dot.
    await client.articles.list({ sort: 'meta' })
  })
})
