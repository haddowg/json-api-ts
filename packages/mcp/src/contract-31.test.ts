import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument } from './openapi'
import { decode, toPortable } from './portable'
import { fakeTransport, fixture } from './test-fixtures'

const argument = (
  mcp: ReturnType<typeof createJsonApiMcp>,
  tool: string,
  name: string,
): JsonSchema => {
  const schema = mcp.tools.find((t) => t.name === tool)!.inputSchema as JsonSchema
  return (schema['properties'] as Record<string, JsonSchema>)[name]!
}

const compact = {
  type: ['string', 'number', 'boolean', 'array', 'null'],
  maxLength: 200,
  items: { type: ['string', 'number', 'boolean'] },
}

const fallback = {
  oneOf: [
    { type: 'string', enum: ['auto', 'off'] },
    { type: 'integer', minimum: 0 },
  ],
}

const scalars = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] }

const portableValue = {
  anyOf: [
    { type: 'string', description: 'At most 200 characters.' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'array', items: scalars },
    { type: 'null' },
  ],
}

const portableThreshold = {
  anyOf: [
    { type: 'string', enum: ['auto', 'off'] },
    { type: 'integer', description: 'At least 0.' },
  ],
}

const doc = {
  openapi: '3.1.0',
  components: { schemas: { Mode: { enum: ['fast', 'slow'] } } },
} as OpenApiDocument

/**
 * Core's witness declares two unions on its articles: `value`, one schema listing its members'
 * types beside their own keywords, and `threshold`, a `oneOf` of its members because its string
 * member carries an enum.
 */
describe('generator contract 31 (unions)', () => {
  const mcp = createJsonApiMcp(fixture('contract-witness'))

  it('reads the witness', () => {
    expect(mcp.contract).toBe(38)
  })

  it.each(['articles_create', 'articles_update'])('takes %s each member of a union', (tool) => {
    expect(argument(mcp, tool, 'value')).toEqual(portableValue)
    expect(argument(mcp, tool, 'threshold')).toEqual({
      anyOf: [...portableThreshold.anyOf, { type: 'null' }],
    })
  })

  it('sends each member as given, and a top-level null as not given', async () => {
    const { transport, requests } = fakeTransport(() => ({
      status: 201,
      json: { data: { type: 'articles', id: 'art-1', attributes: { title: 'Hello' } } },
    }))
    const session = await createJsonApiMcp({
      ...fixture('contract-witness'),
      transport,
    }).forRequest({ context: {} })
    await session.callTool('articles_create', {
      title: 'Hello',
      value: ['gold', 2.5, false],
      threshold: 'auto',
    })
    await session.callTool('articles_create', { title: 'Hello', value: null, threshold: null })
    await session.callTool('articles_create', { title: 'Hello', value: '{"a":1}', threshold: 0 })
    const attributes = requests.map(
      (req) => (JSON.parse(req.body!) as { data: { attributes: unknown } }).data.attributes,
    )
    expect(attributes).toEqual([
      { title: 'Hello', value: ['gold', 2.5, false], threshold: 'auto' },
      { title: 'Hello' },
      { title: 'Hello', value: '{"a":1}', threshold: 0 },
    ])
  })
})

describe('a union in a portable input', () => {
  it('splits a type list into a branch per type holding its own keywords', () => {
    expect(toPortable(doc, compact).schema).toEqual(portableValue)
    expect(
      toPortable(doc, { type: ['string', 'integer'], format: 'date', minimum: 1 }).schema,
    ).toEqual({
      anyOf: [
        { type: 'string', format: 'date' },
        { type: 'integer', description: 'At least 1.' },
      ],
    })
  })

  it('keeps each branch of a oneOf, an enum by its values', () => {
    expect(toPortable(doc, fallback).schema).toEqual(portableThreshold)
    expect(
      toPortable(doc, { oneOf: [{ $ref: '#/components/schemas/Mode' }, { type: 'integer' }] })
        .schema,
    ).toEqual({ anyOf: [{ type: 'string', enum: ['fast', 'slow'] }, { type: 'integer' }] })
  })

  it('reads a union inside an object and as list items', () => {
    const converted = toPortable(doc, {
      type: 'object',
      properties: {
        value: compact,
        threshold: fallback,
        values: { type: 'array', items: { type: ['string', 'number'] } },
        thresholds: { type: 'array', items: fallback },
      },
      required: ['value'],
    })
    expect(converted.schema).toEqual({
      type: 'object',
      properties: {
        value: portableValue,
        threshold: { anyOf: [...portableThreshold.anyOf, { type: 'null' }] },
        values: {
          type: ['array', 'null'],
          items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        },
        thresholds: { type: ['array', 'null'], items: portableThreshold },
      },
      required: ['value', 'threshold', 'values', 'thresholds'],
      additionalProperties: false,
    })
    expect(
      decode(
        { value: ['a', 1], threshold: null, values: ['x', 2], thresholds: ['off', 3] },
        converted.decoder,
      ),
    ).toEqual({ value: ['a', 1], values: ['x', 2], thresholds: ['off', 3] })
  })

  it('never takes a union as JSON text however deep it sits', () => {
    expect(toPortable(doc, compact, [], 6).schema).toEqual(portableValue)
    expect(toPortable(doc, fallback, [], 6).schema).toEqual(portableThreshold)
    expect(toPortable(doc, { type: 'array', items: compact }, [], 5).schema).toEqual({
      type: 'array',
      items: portableValue,
    })
  })

  it('describes the members an open object takes as JSON text', () => {
    const open = (members: unknown) =>
      toPortable(doc, { type: 'object', additionalProperties: members }).schema['description']
    expect(open(compact)).toBe(
      'Any member is one of: a string, at most 200 characters; a number; a boolean; an array of string, number, boolean values; null. Send the value as JSON text.',
    )
    expect(open({ oneOf: [...fallback.oneOf, { type: 'null' }] })).toBe(
      'Any member is one of: `"auto"` or `"off"`; an integer, at least 0; null. Send the value as JSON text.',
    )
    expect(
      decode(
        '{"a":"auto","b":3,"c":null}',
        toPortable(doc, { type: 'object', additionalProperties: fallback }).decoder,
      ),
    ).toEqual({ a: 'auto', b: 3, c: null })
  })
})
