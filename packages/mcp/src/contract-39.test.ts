import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import type { JsonSchema, OpenApiDocument } from './openapi'
import { toPortable } from './portable'
import { source } from './test-fixtures'

const { document } = source('contract-witness')

const relatedQuery = (doc: OpenApiDocument, name: string): JsonSchema =>
  doc.components!.parameters![name]!.schema as JsonSchema

/**
 * Core types the enum references inside each `<Type>RelatedQuery` parameter component the way it
 * types a top-level filter parameter's, as `{ type, allOf: [{ $ref }] }`. No tool takes
 * `relatedQuery`, and the portable conversion merges the `allOf`, so the component converts to a
 * valid schema with the enum kept.
 */
describe('generator contract 39 (typed enum references in relatedQuery)', () => {
  it('converts the component to a valid schema that keeps the enum', () => {
    const portable = toPortable(document, relatedQuery(document, 'TagsRelatedQuery'))
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
  const shapes = (status: unknown, priority: unknown, contract: number) =>
    ({
      openapi: '3.1.0',
      info: { title: 'Shapes', version: '1', 'x-generator': { contract } },
      components: {
        schemas: {
          Status: { enum: ['draft', 'published'] },
          Priority: { enum: [1, 2], 'x-enum-varnames': ['Low', 'High'] },
        },
        parameters: {
          TagsRelatedQuery: component({
            status: { ...(status as object), description: 'Filter by status.' },
            priorities: { type: 'array', items: priority },
          }),
        },
      },
    }) as unknown as OpenApiDocument
  const doc = shapes(
    { enum: ['draft', 'published'] },
    { enum: [1, 2], 'x-enum-varnames': ['Low', 'High'] },
    38,
  )
  const typedDoc = shapes(
    { type: 'string', allOf: [{ $ref: '#/components/schemas/Status' }] },
    { type: 'integer', allOf: [{ $ref: '#/components/schemas/Priority' }] },
    39,
  )
  const members = (schema: JsonSchema | undefined) =>
    (schema?.['properties'] ?? {}) as Record<string, JsonSchema>
  const filter = (d: OpenApiDocument) =>
    members(members(members(relatedQuery(d, 'TagsRelatedQuery'))['articles'])['filter'])

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
