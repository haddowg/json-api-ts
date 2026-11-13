import { readFileSync } from 'node:fs'
import type { TransportRequest } from '@haddowg/json-api-client'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  type ArticlesAttributes,
  type ArticlesCreateAttributes,
  type ArticlesUpdateAttributes,
  createClient,
  type PlaceholderValue,
  type Reviewer,
  type ReviewerCreate,
  type ReviewerUpdate,
} from '../test/generated/contract-witness.client.gen'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'
import { retype } from '../test/typed-references'

const witness = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument

const article = {
  type: 'articles',
  id: 'art-1',
  attributes: {
    title: 'Hello',
    defaultValue: 'gold',
    fallbackValue: null,
    reviewedBy: { name: 'Ada', reviewedAt: '2026-11-10T09:00:00+00:00' },
    approvedBy: null,
  },
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

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

/**
 * A one-type document whose `settings` attributes are the given schemas, beside the given named
 * components.
 */
function settings(
  properties: Record<string, unknown>,
  components: Record<string, unknown>,
  contract = 32,
): OpenApiDocument {
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
                    properties: { data: ref('SettingsResource') },
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
            attributes: ref('SettingsAttributes'),
          },
        },
        SettingsAttributes: {
          type: 'object',
          properties,
          required: Object.keys(properties),
          additionalProperties: false,
        },
        ...components,
      },
    },
  } as unknown as OpenApiDocument
}

const scalar = { type: ['string', 'number'] }
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] })
const change = {
  type: 'object',
  properties: { field: { type: 'string' }, to: ref('Scalar') },
  required: ['field'],
  additionalProperties: false,
}

/**
 * Core's witness shares two named shapes across its articles: `PlaceholderValue`, a union every
 * context writes the same, and `Reviewer`, an object whose read-only member gives it a
 * `ReviewerCreate` and a `ReviewerUpdate` variant.
 */
describe('generator contract 32 (named components)', () => {
  const source = emit(witness, buildDescriptor(witness))

  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(37)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('emits one exported type per named component', () => {
    expect(source).toContain(
      '/** @maxLength 200 */\nexport type PlaceholderValue = string | number | boolean\n',
    )
    expect(source).toContain(
      'export interface Reviewer {\n  /** @minLength 1 */\n  name: string\n  /** @format date-time */\n  reviewedAt: string | null\n}',
    )
    expect(source).toContain(
      'export interface ReviewerCreate {\n  /** @minLength 1 */\n  name: string\n}',
    )
    expect(source).toContain(
      'export interface ReviewerUpdate {\n  /** @minLength 1 */\n  name?: string\n}',
    )
    expect(source.match(/export (type|interface) PlaceholderValue\b/g)).toHaveLength(1)
  })

  it('references a shape by name on reads', () => {
    expectTypeOf<ArticlesAttributes['defaultValue']>().toEqualTypeOf<PlaceholderValue>()
    expectTypeOf<ArticlesAttributes['fallbackValue']>().toEqualTypeOf<PlaceholderValue | null>()
    expectTypeOf<ArticlesAttributes['reviewedBy']>().toEqualTypeOf<Reviewer | null>()
    expectTypeOf<ArticlesAttributes['approvedBy']>().toEqualTypeOf<Reviewer | null>()
    expect(source).toContain('  defaultValue: PlaceholderValue\n')
    expect(source).toContain('  fallbackValue: PlaceholderValue | null\n')
  })

  it('references the create and update variants on writes', () => {
    expectTypeOf<ArticlesCreateAttributes['defaultValue']>().toEqualTypeOf<PlaceholderValue>()
    expectTypeOf<ArticlesCreateAttributes['reviewedBy']>().toEqualTypeOf<
      ReviewerCreate | undefined
    >()
    expectTypeOf<ArticlesCreateAttributes['approvedBy']>().toEqualTypeOf<
      ReviewerCreate | null | undefined
    >()
    expectTypeOf<ArticlesUpdateAttributes['reviewedBy']>().toEqualTypeOf<
      ReviewerUpdate | undefined
    >()
    expectTypeOf<ArticlesUpdateAttributes['approvedBy']>().toEqualTypeOf<
      ReviewerUpdate | null | undefined
    >()
    expectTypeOf<ArticlesUpdateAttributes['fallbackValue']>().toEqualTypeOf<
      PlaceholderValue | null | undefined
    >()
  })

  it('keeps each use’s description and deprecation on the member', () => {
    expect(source).toContain(
      '  /**\n   * The value a placeholder takes when nothing is bound.\n   *\n   * @minLength 1\n   */\n  defaultValue: PlaceholderValue\n',
    )
    expect(source).toContain('  /** Who reviewed the article. */\n  reviewedBy: Reviewer | null\n')
    expect(source).toContain('  /** @deprecated */\n  approvedBy: Reviewer | null\n')
  })

  it('hints a shape by its component', () => {
    const attributes = buildDescriptor(witness)['articles']!.attributes
    expect(attributes['defaultValue']).toBe('unknown')
    expect(attributes['fallbackValue']).toBe('unknown')
    expect(attributes['reviewedBy']).toBe('object')
    expect(attributes['approvedBy']).toBe('object')
  })

  it('reads and writes a shape', async () => {
    const { client, requests } = witnessClient()
    const result = await client.articles.id('art-1').get()
    expect(result.reviewedBy).toEqual({ name: 'Ada', reviewedAt: '2026-11-10T09:00:00+00:00' })
    await client.articles.create({ title: 'Hello', defaultValue: 2.5, reviewedBy: { name: 'Ada' } })
    await client.articles.id('art-1').update({ reviewedBy: {}, approvedBy: null })
    const bodies = requests.slice(1).map((req) => JSON.parse(String(req.body)) as unknown)
    expect(bodies[0]).toMatchObject({
      data: { attributes: { defaultValue: 2.5, reviewedBy: { name: 'Ada' } } },
    })
    expect(bodies[1]).toMatchObject({ data: { attributes: { reviewedBy: {}, approvedBy: null } } })
  })

  it('rejects what a variant leaves out at compile time', () => {
    const { client } = witnessClient()
    void (() =>
      client.articles.create({
        title: 'Hello',
        defaultValue: 'gold',
        // @ts-expect-error — a create can't write the read-only `reviewedAt`.
        reviewedBy: { name: 'Ada', reviewedAt: '2026-11-10T09:00:00+00:00' },
      }))
    void (() =>
      client.articles.create({
        title: 'Hello',
        // @ts-expect-error — `PlaceholderValue` holds no object.
        defaultValue: { gold: true },
      }))
  })
})

describe('generator contract 32 use sites', () => {
  const document = settings(
    {
      nested: {
        type: 'object',
        properties: { value: ref('Scalar'), maybe: { anyOf: [ref('Scalar'), { type: 'null' }] } },
        required: ['value'],
        additionalProperties: false,
      },
      values: { type: 'array', items: ref('Scalar') },
      changes: { type: 'array', items: ref('Change'), minItems: 1 },
      either: { oneOf: [ref('Change'), { type: 'boolean' }] },
      tags: { allOf: [ref('Tags')], description: 'Labels.', example: ['a'], minItems: 1 },
      tree: ref('Node'),
    },
    {
      Scalar: scalar,
      Change: change,
      Tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      Node: {
        type: 'object',
        properties: { label: { type: 'string' }, children: { type: 'array', items: ref('Node') } },
        required: ['label'],
        additionalProperties: false,
      },
    },
  )
  const source = emit(document, buildDescriptor(document))

  it('references a shape inside an object, a list and a union', () => {
    expect(source).toContain('  nested: { value: Scalar; maybe?: Scalar | null }\n')
    expect(source).toContain('  values: Scalar[]\n')
    expect(source).toContain('  changes: [Change, ...Change[]]\n')
    expect(source).toContain('  either: Change | boolean\n')
  })

  it('declares a shape that another shape references', () => {
    expect(source).toContain('export type Scalar = string | number\n')
    expect(source).toContain('export interface Change {\n  field: string\n  to?: Scalar\n}')
  })

  it('reads a use wrapped in allOf for its example as its $ref', () => {
    expect(source).toContain(
      '  /**\n   * Labels.\n   *\n   * @minItems 1\n   * @example ["a"]\n   */\n  tags: Tags\n',
    )
    expect(source).toContain('/** @maxItems 5 */\nexport type Tags = string[]\n')
  })

  it('names a shape that refers to itself', () => {
    expect(source).toContain('export interface Node {\n  label: string\n  children?: Node[]\n}')
    expect(source).toContain('  tree: Node\n')
  })

  it('declares the shapes in name order', () => {
    const order = [...source.matchAll(/^export (?:type|interface) (Change|Node|Scalar|Tags)\b/gm)]
    expect(order.map((match) => match[1])).toEqual(['Change', 'Node', 'Scalar', 'Tags'])
  })

  it('expands the same references in an older document', () => {
    const older = settings(
      { values: { type: 'array', items: ref('Scalar') } },
      { Scalar: scalar },
      31,
    )
    const out = emit(older, buildDescriptor(older))
    expect(out).toContain('  values: (string | number)[]\n')
    expect(out).not.toContain('export type Scalar')
  })
})

describe('generator contract 38 references with their component type beside them', () => {
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
    Scalar: scalar,
  }
  const uses: Record<string, unknown> = {
    status: ref('Status'),
    maybeStatus: nullable(ref('Status')),
    priority: ref('Priority'),
    maybePriority: nullable(ref('Priority')),
    reviewer: { allOf: [ref('Reviewer')], description: 'Who reviewed it.' },
    maybeReviewer: { ...nullable(ref('Reviewer')), description: 'Who reviewed it.' },
    labels: ref('Labels'),
    maybeLabels: nullable(ref('Labels')),
    tags: { allOf: [ref('Tags')], minItems: 1 },
    maybeTags: nullable(ref('Tags')),
    value: ref('Scalar'),
    maybeValue: nullable(ref('Scalar')),
    priorities: { type: 'array', items: ref('Priority') },
    maybePriorities: { type: ['array', 'null'], items: ref('Priority') },
    level: { oneOf: [ref('Status'), { type: 'integer' }] },
    maybeLevel: { oneOf: [ref('Status'), { type: 'integer' }, { type: 'null' }] },
  }
  const untyped = settings(uses, shapes, 37)
  const typed = retype(untyped, Object.keys(shapes))
  const typedSource = emit(typed, buildDescriptor(typed))
  const untypedSource = emit(untyped, buildDescriptor(untyped))
  const members = [
    '  status: Status\n',
    '  maybeStatus: Status | null\n',
    '  priority: Priority\n',
    '  maybePriority: Priority | null\n',
    '  /** Who reviewed it. */\n  reviewer: Reviewer\n',
    '  /** Who reviewed it. */\n  maybeReviewer: Reviewer | null\n',
    '  labels: Labels\n',
    '  maybeLabels: Labels | null\n',
    '  /** @minItems 1 */\n  tags: Tags\n',
    '  maybeTags: Tags | null\n',
    '  value: Scalar\n',
    '  maybeValue: Scalar | null\n',
    '  priorities: Priority[]\n',
    '  maybePriorities: Priority[] | null\n',
    '  level: Status | number\n',
    '  maybeLevel: Status | number | null\n',
  ]

  it('writes each use with its type, the way core does', () => {
    const properties = typed.components!.schemas!['SettingsAttributes']!.properties!
    expect(properties['maybeStatus']).toEqual({
      type: ['string', 'null'],
      anyOf: [ref('Status'), { type: 'null' }],
    })
    expect(properties['priority']).toEqual({ type: 'integer', allOf: [ref('Priority')] })
    expect(properties['labels']).toEqual({ type: 'object', allOf: [ref('Labels')] })
    expect(properties['maybeTags']).toEqual({
      type: ['array', 'null'],
      anyOf: [ref('Tags'), { type: 'null' }],
    })
    expect(properties['maybeValue']).toEqual({
      type: ['string', 'number', 'null'],
      anyOf: [ref('Scalar'), { type: 'null' }],
    })
    expect(properties['maybePriorities']).toEqual({
      type: ['array', 'null'],
      items: { type: 'integer', allOf: [ref('Priority')] },
    })
  })

  it.each(members)('keeps the named type in %j', (member) => {
    expect(typedSource).toContain(member)
  })

  it('declares each named type', () => {
    expect(typedSource).toContain('export type Status = "draft" | "published"\n')
    expect(typedSource).toContain('export type Priority = 1 | 2\n')
    expect(typedSource).toContain('export interface Reviewer {\n  name: string\n}')
    expect(typedSource).toContain('export type Labels = Record<string, string>\n')
    expect(typedSource).toContain('/** @maxItems 5 */\nexport type Tags = string[]\n')
    expect(typedSource).toContain('export type Scalar = string | number\n')
  })

  it('emits exactly what the untyped references emit', () => {
    expect(buildDescriptor(typed)).toEqual(buildDescriptor(untyped))
    expect(typedSource.slice(typedSource.indexOf(' */\n'))).toBe(
      untypedSource.slice(untypedSource.indexOf(' */\n')),
    )
  })

  it.each(members)('still reads the untyped reference in %j', (member) => {
    expect(untypedSource).toContain(member)
  })

  it('keeps a type that disagrees with its component, as before', () => {
    const document = settings(
      {
        named: { type: 'string', allOf: [ref('Reviewer')] },
        maybeNamed: { type: ['string', 'null'], anyOf: [ref('Reviewer'), { type: 'null' }] },
        scalar: { type: 'integer', allOf: [ref('Scalar')] },
      },
      { Reviewer: shapes.Reviewer, Scalar: scalar },
      38,
    )
    const source = emit(document, buildDescriptor(document))
    expect(source).toContain('  named: string\n')
    expect(source).toContain('  maybeNamed: string | null\n')
    expect(source).toContain('  scalar: number\n')
  })
})

describe('generator contract 32 name clashes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('suffixes a name the module derives itself with Shape', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const document = settings(
      {
        links: ref('SettingsLinks'),
        included: ref('Included'),
        attributes: ref('Attributes'),
      },
      { SettingsLinks: scalar, Included: scalar, Attributes: { type: 'boolean' } },
    )
    const source = emit(document, buildDescriptor(document))
    expect(source).toContain('  links: SettingsLinksShape\n')
    expect(source).toContain('export type SettingsLinksShape = string | number\n')
    expect(source).toContain('  included: IncludedShape\n')
    expect(source).toContain('  attributes: AttributesShape\n')
    expect(source).toContain('export type AttributesShape = boolean\n')
    expect(warn).toHaveBeenCalledWith(
      'Schema component "SettingsLinks" clashes with a type name the generated module declares; emitting it as SettingsLinksShape.',
    )
  })

  it('derives a name from one that is no type name, clear of every component', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const document = settings(
      { dotted: ref('Placeholder.Value'), plain: ref('PlaceholderValue'), digit: ref('2fa') },
      { 'Placeholder.Value': scalar, PlaceholderValue: { type: 'boolean' }, '2fa': scalar },
    )
    const source = emit(document, buildDescriptor(document))
    expect(source).toContain('  dotted: PlaceholderValueShape\n')
    expect(source).toContain('  plain: PlaceholderValue\n')
    expect(source).toContain('export type PlaceholderValue = boolean\n')
    expect(source).toContain('  digit: Shape2fa\n')
    expect(warn).toHaveBeenCalledWith(
      'Schema component "Placeholder.Value" can\'t be used as a TypeScript type name; emitting it as PlaceholderValueShape.',
    )
  })
})
