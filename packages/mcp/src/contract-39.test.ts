import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { MAXIMUM_CONTRACT } from './contract'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument } from './openapi'
import { toPortable } from './portable'
import { modelOf, source, typeRelatedQueries } from './test-fixtures'

const { document } = source('contract-witness')
const typed = typeRelatedQueries(document)

const relatedQuery = (doc: OpenApiDocument, name: string): JsonSchema =>
  doc.components!.parameters![name]!.schema as JsonSchema

/**
 * Core types the enum references inside each `<Type>RelatedQuery` parameter component the way it
 * types a top-level filter parameter's, as `{ type, allOf: [{ $ref }] }`, where it wrote an inline
 * enum with no type before. No tool takes `relatedQuery`, and the portable conversion merges the
 * `allOf`, so the component converts to a valid schema with the enum kept.
 */
describe('generator contract 39 (typed enum references in relatedQuery)', () => {
  it('reads a document stamped 39, and refuses one past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(39)
    expect(createJsonApiMcp(modelOf(typed)).contract).toBe(39)
    const newer = structuredClone(typed)
    newer.info!['x-generator']!.contract = 40
    expect(() => createJsonApiMcp(modelOf(newer))).toThrow('newer than this package reads')
  })

  it('gives every tool the input and output it had', () => {
    const shape = (doc: OpenApiDocument) =>
      createJsonApiMcp(modelOf(doc)).tools.map((t) => [t.name, t.inputSchema, t.outputSchema])
    expect(shape(typed)).toEqual(shape(document))
  })

  it('converts the component to a valid schema that keeps the enum', () => {
    const portable = toPortable(typed, relatedQuery(typed, 'TagsRelatedQuery'))
    expect(portable).toEqual(toPortable(document, relatedQuery(document, 'TagsRelatedQuery')))
    const articles = (portable.schema['properties'] as Record<string, JsonSchema>)['articles']!
    const filter = (articles['properties'] as Record<string, JsonSchema>)['filter']!
    const priorities = (filter['properties'] as Record<string, JsonSchema>)['priorities']!
    expect(priorities['items']).toEqual({ type: 'integer', enum: [1, 2] })
    const ajv = new Ajv2020({ strict: false, validateFormats: false })
    expect(() => ajv.compile(portable.schema)).not.toThrow()
    const item = ajv.compile(priorities['items'] as JsonSchema)
    expect([1, 2].map((value) => item(value))).toEqual([true, true])
    expect(item(3)).toBe(false)
  })
})

describe('a portable relatedQuery from typed enum references', () => {
  const component = (filter: Record<string, unknown>) => ({
    name: 'relatedQuery',
    in: 'query',
    schema: {
      type: 'object',
      properties: {
        articles: {
          type: 'object',
          properties: { filter: { type: 'object', properties: filter } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  })
  const doc = {
    openapi: '3.1.0',
    info: { title: 'Shapes', version: '1', 'x-generator': { contract: 38 } },
    components: {
      schemas: {
        Status: { enum: ['draft', 'published'] },
        Priority: { enum: [1, 2], 'x-enum-varnames': ['Low', 'High'] },
      },
      parameters: {
        TagsRelatedQuery: component({
          status: { enum: ['draft', 'published'], description: 'Filter by status.' },
          priorities: {
            type: 'array',
            items: { enum: [1, 2], 'x-enum-varnames': ['Low', 'High'] },
          },
        }),
      },
    },
  } as unknown as OpenApiDocument
  const typedDoc = typeRelatedQueries(doc)
  const members = (schema: JsonSchema | undefined) =>
    (schema?.['properties'] ?? {}) as Record<string, JsonSchema>
  const filter = (d: OpenApiDocument) =>
    members(members(members(relatedQuery(d, 'TagsRelatedQuery'))['articles'])['filter'])

  it('writes each enum as a typed reference', () => {
    expect(filter(typedDoc)['status']).toEqual({
      type: 'string',
      allOf: [{ $ref: '#/components/schemas/Status' }],
      description: 'Filter by status.',
    })
    expect(filter(typedDoc)['priorities']!['items']).toEqual({
      type: 'integer',
      allOf: [{ $ref: '#/components/schemas/Priority' }],
    })
  })

  it('converts the component as the inline enums', () => {
    const portable = toPortable(typedDoc, relatedQuery(typedDoc, 'TagsRelatedQuery'))
    expect(portable).toEqual(toPortable(doc, relatedQuery(doc, 'TagsRelatedQuery')))
    const converted = filter({
      components: { parameters: { TagsRelatedQuery: { schema: portable.schema } } },
    } as unknown as OpenApiDocument)
    expect(converted['status']).toEqual({
      type: ['string', 'null'],
      enum: ['draft', 'published', null],
      description: 'Filter by status.',
    })
    expect(converted['priorities']!['items']).toEqual({ type: 'integer', enum: [1, 2] })
  })
})
