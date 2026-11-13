import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { MAXIMUM_CONTRACT } from './contract'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument } from './openapi'
import { toPortable } from './portable'
import { modelOf, retype, source } from './test-fixtures'

/** The witness's named value shapes: its enums, a union, an object and its variants, raw bodies. */
const SHAPES = [
  'Status',
  'Priority',
  'PlaceholderValue',
  'Reviewer',
  'ReviewerCreate',
  'ReviewerUpdate',
  'ArticleSummary',
  'ArticleImportRow',
]

const { document } = source('contract-witness')
const untyped = createJsonApiMcp(modelOf(document))
const typed = createJsonApiMcp(modelOf(retype(document, SHAPES)))

const tool = (mcp: ReturnType<typeof createJsonApiMcp>, name: string) =>
  mcp.tools.find((t) => t.name === name)!

const properties = (schema: JsonSchema | undefined) =>
  (schema?.['properties'] ?? {}) as Record<string, JsonSchema>

const STATUS = ['draft', 'published', 'archived']

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] })

/**
 * Core writes every reference to a named value shape with its component's JSON type beside it,
 * as `{ type, allOf: [{ $ref }] }`, or `{ type: [..., 'null'], anyOf: [{ $ref }, { type: 'null' }] }`
 * when nullable. A tool input merges the `allOf` and follows the one non-null branch, so the type
 * changes nothing; an output keeps it beside the inlined component.
 */
describe('generator contract 38 (typed references to named value shapes)', () => {
  it('reads a document stamped 38', () => {
    expect(MAXIMUM_CONTRACT).toBe(38)
    expect(typed.contract).toBe(38)
    const newer = retype(document, SHAPES)
    newer.info!['x-generator']!.contract = 39
    expect(() => createJsonApiMcp(modelOf(newer))).toThrow('newer than this package reads')
  })

  it('takes the same input on every tool', () => {
    expect(typed.tools.map((t) => t.name)).toEqual(untyped.tools.map((t) => t.name))
    for (const t of typed.tools) {
      expect(t.inputSchema, t.name).toEqual(tool(untyped, t.name).inputSchema)
    }
  })

  it('keeps the enums in the inputs', () => {
    const create = properties(tool(typed, 'articles_create').inputSchema)
    expect(create['status']).toMatchObject({ enum: [...STATUS, null] })
    expect(create['priority']).toEqual({ type: ['integer', 'null'], enum: [1, 2, null] })
    expect(properties(tool(typed, 'people_create').inputSchema)['role']).toMatchObject({
      enum: [...STATUS, null],
    })
    const filter = properties(properties(tool(typed, 'articles_list').inputSchema)['filter'])
    expect(filter['priorities']!['items']).toEqual({ type: 'integer', enum: [1, 2] })
    expect(properties(tool(typed, 'articles_bulk_import').inputSchema)['body']).toMatchObject({
      type: ['array', 'null'],
      items: { type: 'object', required: ['title'] },
    })
  })

  it('writes output schemas that compile and keep the enums', () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false })
    for (const t of typed.tools) {
      if (t.outputSchema !== undefined) {
        expect(() => ajv.compile(t.outputSchema!), t.name).not.toThrow()
      }
    }
    const output = tool(typed, 'articles_get').outputSchema!
    const article = properties((output['$defs'] as Record<string, JsonSchema>)['articles'])
    expect(article['status']).toMatchObject({
      type: ['string', 'null'],
      anyOf: [{ enum: STATUS }, { type: 'null' }],
    })
    expect(article['priority']).toMatchObject({ anyOf: [{ enum: [1, 2] }, { type: 'null' }] })
    const validate = ajv.compile(output)
    const read = (attributes: Record<string, unknown>) =>
      validate({ data: { id: 'art-1', type: 'articles', title: 'Hello', ...attributes } })
    expect(read({ status: 'draft', priority: 2 })).toBe(true)
    expect(read({ status: null, priority: null })).toBe(true)
    expect(read({ status: 'gone' })).toBe(false)
    expect(read({ priority: 3 })).toBe(false)
  })
})

describe('a portable input from a typed reference', () => {
  const shapes = {
    Status: { enum: ['draft', 'published'] },
    Priority: { enum: [1, 2] },
    Reviewer: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    Labels: { type: 'object', additionalProperties: { type: 'string' } },
    Tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    Scalar: { type: ['string', 'number'], maxLength: 10 },
  }
  const uses: Record<string, unknown> = {
    status: ref('Status'),
    maybeStatus: nullable(ref('Status')),
    priority: ref('Priority'),
    maybePriority: nullable(ref('Priority')),
    reviewer: ref('Reviewer'),
    maybeReviewer: nullable(ref('Reviewer')),
    labels: ref('Labels'),
    maybeLabels: nullable(ref('Labels')),
    tags: { allOf: [ref('Tags')], minItems: 1 },
    maybeTags: nullable(ref('Tags')),
    value: ref('Scalar'),
    maybeValue: nullable(ref('Scalar')),
    priorities: { type: 'array', items: ref('Priority') },
    level: { oneOf: [ref('Status'), { type: 'integer' }] },
    maybeLevel: { oneOf: [ref('Status'), { type: 'integer' }, { type: 'null' }] },
  }
  const doc = {
    openapi: '3.1.0',
    info: { title: 'Shapes', version: '1', 'x-generator': { contract: 37 } },
    components: { schemas: { ...shapes, Uses: { type: 'object', properties: uses } } },
  } as unknown as OpenApiDocument
  const typedDoc = retype(doc, Object.keys(shapes))
  const typedUses = (typedDoc.components!.schemas!['Uses'] as JsonSchema)['properties'] as Record<
    string,
    unknown
  >

  it.each(Object.keys(uses))('converts %s as the untyped reference', (name) => {
    expect(typedUses[name]).not.toEqual(uses[name])
    expect(toPortable(typedDoc, typedUses[name])).toEqual(toPortable(doc, uses[name]))
  })

  it('keeps the enums', () => {
    expect(toPortable(typedDoc, typedUses['maybeStatus']).schema).toEqual({
      type: ['string', 'null'],
      enum: ['draft', 'published', null],
    })
    expect(toPortable(typedDoc, typedUses['priorities']).schema).toEqual({
      type: 'array',
      items: { type: 'integer', enum: [1, 2] },
    })
    expect(toPortable(typedDoc, typedUses['maybeLevel']).schema).toEqual({
      anyOf: [
        { type: 'string', enum: ['draft', 'published'] },
        { type: 'integer' },
        { type: 'null' },
      ],
    })
  })
})
