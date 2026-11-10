import { readFileSync } from 'node:fs'
import type { TransportRequest } from '@haddowg/json-api-client'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type ArticlesAttributes,
  type ArticlesCreateAttributes,
  type ArticlesUpdateAttributes,
  createClient,
} from '../test/generated/contract-witness.client.gen'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'

const witness = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument

type Scalar = string | number | boolean
type Value = Scalar | Scalar[] | null

const article = {
  type: 'articles',
  id: 'art-1',
  attributes: { title: 'Hello', value: ['gold', 2.5, false], threshold: 'auto' },
}

function witnessClient() {
  const requests: TransportRequest[] = []
  const client = createClient({
    baseUrl: 'https://api.example.com',
    transport: async (req) => {
      requests.push(req)
      return { status: 200, headers: {}, body: JSON.stringify({ data: article }) }
    },
  })
  return { client, requests }
}

/** A one-type document whose `settings` attributes are the given schemas. */
function settings(properties: Record<string, unknown>, contract = 31): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'Settings', version: '1.0.0', 'x-generator': { contract } },
    paths: {
      '/settings/{id}': {
        get: {
          operationId: 'settings.fetchOne',
          responses: {
            '200': {
              description: 'A setting.',
              content: {
                'application/vnd.api+json': {
                  schema: {
                    type: 'object',
                    properties: { data: { $ref: '#/components/schemas/SettingsResource' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        SettingsResource: {
          type: 'object',
          required: ['type', 'id'],
          properties: {
            type: { const: 'settings' },
            id: { type: 'string' },
            attributes: { $ref: '#/components/schemas/SettingsAttributes' },
          },
        },
        SettingsAttributes: {
          type: 'object',
          properties,
          required: Object.keys(properties),
          additionalProperties: false,
        },
      },
    },
  } as unknown as OpenApiDocument
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

/**
 * Core's witness declares two unions on its articles: `value`, whose members' keywords merge into
 * one schema listing their types, and `threshold`, a `oneOf` of its members because its string
 * member carries an enum.
 */
describe('generator contract 31 (unions)', () => {
  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(31)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('types a union listing its types as a union of each type', () => {
    expectTypeOf<ArticlesAttributes['value']>().toEqualTypeOf<Value>()
    expectTypeOf<ArticlesCreateAttributes['value']>().toEqualTypeOf<Value | undefined>()
    expectTypeOf<ArticlesUpdateAttributes['value']>().toEqualTypeOf<Value | undefined>()
  })

  it('types a oneOf of members as a union of each member', () => {
    expectTypeOf<ArticlesAttributes['threshold']>().toEqualTypeOf<'auto' | 'off' | number | null>()
    expectTypeOf<ArticlesCreateAttributes['threshold']>().toEqualTypeOf<
      'auto' | 'off' | number | undefined
    >()
    expectTypeOf<ArticlesUpdateAttributes['threshold']>().toEqualTypeOf<
      'auto' | 'off' | number | undefined
    >()
  })

  it('emits both forms inline', () => {
    const source = emit(witness, buildDescriptor(witness))
    expect(source).toContain(
      '  value: string | number | boolean | (string | number | boolean)[] | null\n',
    )
    expect(source).toContain('  threshold: "auto" | "off" | number | null\n')
  })

  it('gives a union no single format hint', () => {
    const attributes = buildDescriptor(witness)['articles']!.attributes
    expect(attributes['value']).toBe('unknown')
    expect(attributes['threshold']).toBe('unknown')
  })

  it('reads and writes each member', async () => {
    const { client, requests } = witnessClient()
    const result = await client.articles.id('art-1').get()
    expect(result.value).toEqual(['gold', 2.5, false])
    expect(result.threshold).toBe('auto')
    await client.articles.create({ title: 'Hello', value: 'gold', threshold: 0 })
    await client.articles.id('art-1').update({ value: [1, 'two', true], threshold: 'off' })
    const bodies = requests.slice(1).map((req) => JSON.parse(String(req.body)) as unknown)
    expect(bodies[0]).toMatchObject({ data: { attributes: { value: 'gold', threshold: 0 } } })
    expect(bodies[1]).toMatchObject({
      data: { attributes: { value: [1, 'two', true], threshold: 'off' } },
    })
  })

  it('rejects a value no member takes at compile time', () => {
    const { client } = witnessClient()
    void (() =>
      client.articles.create({
        title: 'Hello',
        // @ts-expect-error — no member takes an object.
        value: { gold: true },
      }))
    void (() =>
      client.articles.id('art-1').update({
        // @ts-expect-error — `on` is not one of the string member's values.
        threshold: 'on',
      }))
    void (() =>
      client.articles.id('art-1').update({
        // @ts-expect-error — the list member's elements are scalars.
        value: [['nested']],
      }))
  })
})

describe('generator contract 31 inside objects and lists', () => {
  const document = settings({
    nested: {
      type: 'object',
      properties: { value: compact, threshold: fallback },
      required: ['value'],
      additionalProperties: false,
    },
    values: { type: 'array', items: { type: ['string', 'number'] } },
    thresholds: { type: 'array', items: fallback },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        properties: { limit: { oneOf: [...fallback.oneOf, { type: 'null' }] } },
        required: ['limit'],
        additionalProperties: false,
      },
    },
  })
  const source = emit(document, buildDescriptor(document))

  it('types a union inside an object attribute', () => {
    expect(source).toContain(
      '  nested: { value: string | number | boolean | (string | number | boolean)[] | null; threshold?: "auto" | "off" | number }\n',
    )
  })

  it('types a union as list items', () => {
    expect(source).toContain('  values: (string | number)[]\n')
    expect(source).toContain('  thresholds: ("auto" | "off" | number)[]\n')
    expect(source).toContain('  rules: { limit: "auto" | "off" | number | null }[]\n')
  })

  it('types a member enum by its values', () => {
    const typed = settings({
      level: {
        oneOf: [
          { type: 'integer', enum: [1, 2, 3] },
          { type: 'boolean', const: false },
          { $ref: '#/components/schemas/Mode' },
        ],
      },
    })
    typed.components!.schemas!['Mode'] = { type: 'string', enum: ['fast', 'slow'] }
    const out = emit(typed, buildDescriptor(typed))
    expect(out).toContain('  level: 1 | 2 | 3 | false | Mode\n')
    expect(out).toContain('export type Mode = "fast" | "slow"')
  })

  it('gives a union with a scoped format no single format hint', () => {
    const dated = settings({ due: { type: ['string', 'integer'], format: 'date' } })
    expect(buildDescriptor(dated)['settings']!.attributes['due']).toBe('unknown')
    expect(emit(dated, buildDescriptor(dated))).toContain('  due: string | number\n')
  })

  it('reads the same schemas from an older document', () => {
    const older = settings({ value: compact, threshold: fallback }, 30)
    expect(checkContract(older)).toBeUndefined()
    const out = emit(older, buildDescriptor(older))
    expect(out).toContain(
      '  value: string | number | boolean | (string | number | boolean)[] | null\n',
    )
    expect(out).toContain('  threshold: "auto" | "off" | number\n')
  })
})
