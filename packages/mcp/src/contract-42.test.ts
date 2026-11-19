import type { ApiDescriptor } from '@haddowg/json-api-client'
import { buildDescriptor } from '@haddowg/json-api-codegen'
import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument } from './openapi'
import { fakeTransport, modelOf, source, withFieldSelection } from './test-fixtures'

const { document } = source('contract-witness')
const selecting = withFieldSelection(document)

const toolsOf = (doc: OpenApiDocument) => createJsonApiMcp(modelOf(doc)).tools
const tool = (doc: OpenApiDocument, name: string) =>
  toolsOf(doc).find((entry) => entry.name === name)!

/** The schema of one type's entry in a tool's `fields` argument. */
function fieldsEntry(doc: OpenApiDocument, name: string, type: string): JsonSchema {
  const fields = (tool(doc, name).inputSchema['properties'] as Record<string, JsonSchema>)[
    'fields'
  ]!
  return (fields['properties'] as Record<string, JsonSchema>)[type]!
}

/** An attribute's schema in the flattened `articles` resource a tool's output defines. */
function outputAttribute(doc: OpenApiDocument, name: string, attribute: string): JsonSchema {
  const defs = tool(doc, name).outputSchema!['$defs'] as Record<string, JsonSchema>
  return (defs['articles']!['properties'] as Record<string, JsonSchema>)[attribute]!
}

const DESCRIPTION =
  'Besides whole fields, list `<attribute>.<key>` to return that attribute with only the named keys, for `scores`, whose keys match `(?:[a-z][a-z0-9_]*)`; `totals`; and `location`, whose keys match `(?:[a-z]+)`. A resource without a named key leaves it out. List the attribute itself to return all of it. A list returns every item, in order, with only the named keys when you list `<attribute>.*.<key>`, for `lines.*.<key>`, whose keys match `(?:sku|quantity|price)`. An item without a named key leaves it out. List the attribute itself to return all of it. A key holding an object takes its own keys the same way, one more `.<key>` per level, for `location.geo.<key>`, whose keys match `(?:lat|lng)`; and `lines.*.price.<key>`, whose keys match `(?:amount|currency)`; listing the key itself returns all of it.'

/**
 * A `fields[<type>]` parameter accepting single keys of an attribute has items that are an `anyOf`
 * of the member enum and one pattern per such attribute. The list and get tools describe the key
 * members on that type's `fields` entry, and their output lets a narrowed attribute miss keys.
 */
describe('generator contract 42 (field selection)', () => {
  it('reads a document stamped 42', () => {
    expect(createJsonApiMcp(modelOf(selecting)).contract).toBe(42)
  })

  it('describes the key members on each list and get tool that takes the type in fields', () => {
    for (const name of ['articles_list', 'articles_get', 'tags_articles_list']) {
      expect(fieldsEntry(selecting, name, 'articles')).toEqual({
        type: ['array', 'null'],
        items: { type: 'string' },
        description: DESCRIPTION,
      })
    }
    expect(fieldsEntry(selecting, 'articles_list', 'people')['description']).toBeUndefined()
    expect(fieldsEntry(document, 'articles_get', 'articles')['description']).toBeUndefined()
  })

  it('lets a narrowed attribute in the output miss any of its keys', () => {
    const totals = outputAttribute(selecting, 'articles_get', 'totals')
    expect(totals['required']).toBeUndefined()
    expect(totals['properties']).toMatchObject({ views: {}, shares: {} })
    expect(totals['additionalProperties']).toBe(false)
    expect(outputAttribute(selecting, 'articles_get', 'address')).toEqual(
      outputAttribute(document, 'articles_get', 'address'),
    )
  })

  it('lets a nested object a path narrows miss any of its keys', () => {
    const location = outputAttribute(selecting, 'articles_get', 'location')
    expect(location['required']).toBeUndefined()
    const geo = (location['properties'] as Record<string, JsonSchema>)['geo']!
    expect(geo['required']).toBeUndefined()
    expect(geo['properties']).toMatchObject({ lat: {}, lng: {} })
    expect(geo['additionalProperties']).toBe(false)
  })

  it('lets every item of a list a path narrows, and each object inside it, miss any of its keys', () => {
    const lines = outputAttribute(selecting, 'articles_get', 'lines')
    const item = lines['items'] as JsonSchema
    expect(item['required']).toBeUndefined()
    expect(item['properties']).toMatchObject({ sku: {}, quantity: {}, price: {} })
    expect(item['additionalProperties']).toBe(false)
    const price = (item['properties'] as Record<string, JsonSchema>)['price']!
    expect(price['required']).toBeUndefined()
    expect(price['properties']).toMatchObject({ amount: {}, currency: {} })
  })

  it('describes a list inside an object and a list alone', () => {
    const descriptor = buildDescriptor(selecting as Parameters<typeof buildDescriptor>[0])
    const listed: ApiDescriptor = {
      ...descriptor,
      articles: {
        ...descriptor['articles']!,
        selectableKeys: { lines: '\\*', location: '(?:[a-z]+)' },
        selectableKeyPaths: {
          lines: [['\\*', '(?:sku|quantity|price)']],
          location: [
            ['visits', '\\*'],
            ['visits', '\\*', '(?:at|by)'],
          ],
        },
      },
    }
    const tools = createJsonApiMcp(modelOf(selecting, listed)).tools
    const fields = (
      tools.find((entry) => entry.name === 'articles_get')!.inputSchema['properties'] as Record<
        string,
        JsonSchema
      >
    )['fields']!
    const text = (fields['properties'] as Record<string, JsonSchema>)['articles']!['description']
    expect(text).toContain('a key holding a list takes `.*` before the keys of its items')
    expect(text).toContain('for `location.visits.*.<key>`, whose keys match `(?:at|by)`;')
    expect(text).not.toContain('`location.visits.<key>`')

    const alone: ApiDescriptor = {
      ...descriptor,
      articles: {
        ...descriptor['articles']!,
        selectableKeys: { lines: '\\*' },
        selectableKeyPaths: { lines: [['\\*', '[^.,*]+']] },
      },
    }
    const only = (
      (
        createJsonApiMcp(modelOf(selecting, alone)).tools.find(
          (entry) => entry.name === 'articles_get',
        )!.inputSchema['properties'] as Record<string, JsonSchema>
      )['fields']!['properties'] as Record<string, JsonSchema>
    )['articles']!['description']
    expect(only).toBe(
      'Besides whole fields, a list returns every item, in order, with only the named keys when you list `<attribute>.*.<key>`, for `lines.*.<key>`. An item without a named key leaves it out. List the attribute itself to return all of it.',
    )
  })

  it('names a key a path passes through by a pattern as any key', () => {
    const descriptor = buildDescriptor(selecting as Parameters<typeof buildDescriptor>[0])
    const scored: ApiDescriptor = {
      ...descriptor,
      articles: {
        ...descriptor['articles']!,
        selectableKeyPaths: { scores: [['(?:[a-z][a-z0-9_]*)', '[^.,]+']] },
      },
    }
    const tools = createJsonApiMcp(modelOf(selecting, scored)).tools
    const fields = (
      tools.find((entry) => entry.name === 'articles_get')!.inputSchema['properties'] as Record<
        string,
        JsonSchema
      >
    )['fields']!
    const articles = (fields['properties'] as Record<string, JsonSchema>)['articles']!
    expect(articles['description']).toContain('for `scores.<key>.<key>`; listing the key itself')
  })

  it('sends the key members and returns the narrowed attribute', async () => {
    const { transport, requests } = fakeTransport(() => ({
      json: {
        data: { type: 'articles', id: 'a-1', attributes: { title: 'Hi', totals: { views: 3 } } },
      },
    }))
    const mcp = createJsonApiMcp({ ...modelOf(selecting), transport })
    const tools = await mcp.forRequest({ context: undefined })
    const result = await tools.callTool('articles_get', {
      id: 'a-1',
      fields: { articles: ['title', 'totals.views'] },
    })
    expect(decodeURIComponent(requests[0]!.url)).toContain('fields[articles]=title,totals.views')
    expect(result.structuredContent).toMatchObject({
      data: { id: 'a-1', type: 'articles', title: 'Hi', totals: { views: 3 } },
    })
  })

  it('leaves the input of every tool that reads no articles as it was', () => {
    const before = toolsOf(document).map((entry) => [entry.name, entry.inputSchema])
    const after = toolsOf(selecting)
      .filter(
        (entry) => !entry.name.startsWith('articles') && !entry.name.endsWith('articles_list'),
      )
      .map((entry) => [entry.name, entry.inputSchema])
    for (const [name, input] of after) {
      expect(before.find(([other]) => other === name)?.[1]).toEqual(input)
    }
  })
})
