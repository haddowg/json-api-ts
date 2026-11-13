import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument } from './openapi'
import { decode, toPortable } from './portable'
import { fakeTransport, fixture } from './test-fixtures'

const tool = (mcp: ReturnType<typeof createJsonApiMcp>, name: string) =>
  mcp.tools.find((t) => t.name === name)!

const argument = (mcp: ReturnType<typeof createJsonApiMcp>, name: string, member: string) =>
  ((tool(mcp, name).inputSchema as JsonSchema)['properties'] as Record<string, JsonSchema>)[member]!

const placeholder = (minimum: boolean) => [
  {
    type: 'string',
    description: minimum ? 'Between 1 and 200 characters.' : 'At most 200 characters.',
  },
  { type: 'number' },
  { type: 'boolean' },
]

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

const doc = {
  openapi: '3.1.0',
  components: {
    schemas: {
      Scalar: { type: ['string', 'number'], maxLength: 10 },
      Change: {
        type: 'object',
        properties: { field: { type: 'string' }, to: ref('Scalar') },
        required: ['field'],
        additionalProperties: false,
      },
      Tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    },
  },
} as unknown as OpenApiDocument

const portableScalar = {
  anyOf: [{ type: 'string', description: 'At most 10 characters.' }, { type: 'number' }],
}

const portableChange = {
  type: 'object',
  properties: {
    field: { type: 'string' },
    to: { anyOf: [...portableScalar.anyOf, { type: 'null' }] },
  },
  required: ['field', 'to'],
  additionalProperties: false,
}

/**
 * Core's witness shares two named shapes across its articles: `PlaceholderValue`, a union every
 * context writes the same, and `Reviewer`, an object whose read-only member gives it a
 * `ReviewerCreate` and a `ReviewerUpdate` variant.
 */
describe('generator contract 32 (named components)', () => {
  const mcp = createJsonApiMcp(fixture('contract-witness'))

  it('reads the witness', () => {
    expect(mcp.contract).toBe(38)
  })

  it('leaves no reference to a document component in any tool schema', () => {
    for (const { inputSchema, outputSchema } of mcp.tools) {
      expect(JSON.stringify(inputSchema)).not.toContain('$ref')
      expect(JSON.stringify(outputSchema ?? {})).not.toContain('#/components/')
    }
  })

  it('keeps a use’s description and minimum length beside the shape', () => {
    for (const name of ['articles_create', 'articles_update']) {
      expect(argument(mcp, name, 'defaultValue')).toEqual({
        anyOf: [...placeholder(true), ...(name === 'articles_update' ? [{ type: 'null' }] : [])],
        description: 'The value a placeholder takes when nothing is bound.',
      })
      expect(argument(mcp, name, 'fallbackValue')).toEqual({
        anyOf: [...placeholder(false), { type: 'null' }],
      })
    }
  })

  it('takes the create variant on a create and the update variant on an update', () => {
    expect(argument(mcp, 'articles_create', 'reviewedBy')).toEqual({
      type: ['object', 'null'],
      properties: { name: { type: 'string', description: 'At least 1 characters.' } },
      required: ['name'],
      additionalProperties: false,
      description: 'Who reviewed the article.',
    })
    expect(argument(mcp, 'articles_update', 'reviewedBy')).toEqual({
      type: ['object', 'null'],
      properties: { name: { type: ['string', 'null'], description: 'At least 1 characters.' } },
      required: ['name'],
      additionalProperties: false,
      description: 'Who reviewed the article.',
    })
    expect(argument(mcp, 'articles_create', 'approvedBy')['description']).toBe('Deprecated.')
  })

  it('reads the response shape in the output schema', () => {
    const output = tool(mcp, 'articles_get').outputSchema as JsonSchema
    const articles = (output['$defs'] as Record<string, JsonSchema>)['articles']!
    const props = articles['properties'] as Record<string, JsonSchema>
    expect(props['defaultValue']).toEqual({
      type: ['string', 'number', 'boolean'],
      description: 'The value a placeholder takes when nothing is bound.',
      minLength: 1,
      allOf: [{ type: ['string', 'number', 'boolean'], maxLength: 200 }],
    })
    expect(props['reviewedBy']).toEqual({
      type: ['object', 'null'],
      description: 'Who reviewed the article.',
      anyOf: [
        {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            reviewedAt: { type: ['string', 'null'], format: 'date-time' },
          },
          required: ['name', 'reviewedAt'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    })
  })

  it('sends a shape as given and drops the nulls it added', async () => {
    const { transport, requests } = fakeTransport(() => ({
      status: 200,
      json: { data: { type: 'articles', id: 'art-1', attributes: { title: 'Hello' } } },
    }))
    const session = await createJsonApiMcp({
      ...fixture('contract-witness'),
      transport,
    }).forRequest({ context: {} })
    await session.callTool('articles_create', {
      title: 'Hello',
      defaultValue: 2.5,
      reviewedBy: { name: 'Ada' },
    })
    await session.callTool('articles_update', {
      id: 'art-1',
      defaultValue: null,
      reviewedBy: { name: null },
    })
    const attributes = requests.map(
      (req) => (JSON.parse(req.body!) as { data: { attributes: unknown } }).data.attributes,
    )
    expect(attributes).toEqual([
      { title: 'Hello', defaultValue: 2.5, reviewedBy: { name: 'Ada' } },
      { reviewedBy: {} },
    ])
  })
})

describe('a named shape in a portable input', () => {
  it('inlines a shape inside an object, a list and a union', () => {
    const converted = toPortable(doc, {
      type: 'object',
      properties: {
        value: ref('Scalar'),
        maybe: { anyOf: [ref('Scalar'), { type: 'null' }] },
        changes: { type: 'array', items: ref('Change') },
        either: { oneOf: [ref('Change'), { type: 'boolean' }] },
      },
      required: ['value', 'maybe', 'changes', 'either'],
    })
    expect(converted.schema).toEqual({
      type: 'object',
      properties: {
        value: portableScalar,
        maybe: { anyOf: [...portableScalar.anyOf, { type: 'null' }] },
        changes: { type: 'array', items: portableChange },
        either: { anyOf: [portableChange, { type: 'boolean' }] },
      },
      required: ['value', 'maybe', 'changes', 'either'],
      additionalProperties: false,
    })
    expect(
      decode(
        { value: 'a', maybe: null, changes: [{ field: 'x', to: null }], either: true },
        converted.decoder,
      ),
    ).toEqual({ value: 'a', maybe: null, changes: [{ field: 'x' }], either: true })
  })

  it('keeps the keywords beside a $ref, wrapped in allOf for an example or not', () => {
    expect(
      toPortable(doc, { ...ref('Scalar'), description: 'A value.', minLength: 1 }).schema,
    ).toEqual({
      anyOf: [{ type: 'string', description: 'Between 1 and 10 characters.' }, { type: 'number' }],
      description: 'A value.',
    })
    expect(
      toPortable(doc, { allOf: [ref('Tags')], description: 'Labels.', example: ['a'], minItems: 1 })
        .schema,
    ).toEqual({
      type: 'array',
      items: { type: 'string' },
      description: 'Labels. Between 1 and 5 items.',
    })
  })
})
