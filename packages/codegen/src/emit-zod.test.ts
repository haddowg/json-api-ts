import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildDescriptor } from './build-descriptor'
import { emitZod, ZodMapper } from './emit-zod'
import type { OpenApiDocument, SchemaObject } from './openapi'
import { documentPath } from '../test/documents'

const COMPONENTS: Record<string, SchemaObject> = {
  Status: { enum: ['draft', 'published'] },
  Priority: { enum: [1, 2] },
  Reviewer: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1 } },
    required: ['name'],
    additionalProperties: false,
  },
  Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } },
}

/** The mapped expression, the Zod schema it evaluates to, and the warnings it raised. */
function map(schema: SchemaObject): { source: string; schema: z.ZodType; warnings: string[] } {
  const warnings: string[] = []
  const source = new ZodMapper(COMPONENTS, (message) => warnings.push(message)).map(schema, 'field')
  // oxlint-disable-next-line no-new-func -- evaluating generated source against the real zod
  const built = new Function('z', 'nonEmpty', `return ${source}`)(z, (item: z.ZodType) =>
    z.tuple([item], item),
  ) as z.ZodType
  return { source, schema: built, warnings }
}

const accepts = (schema: SchemaObject, value: unknown): boolean =>
  map(schema).schema.safeParse(value).success

describe('ZodMapper', () => {
  it('maps string length, pattern and format', () => {
    const name = { type: 'string', minLength: 2, maxLength: 4, pattern: '^[a-z]+$' }
    expect(map(name).source).toBe('z.string().min(2).max(4).regex(new RegExp("^[a-z]+$", \'u\'))')
    expect(accepts(name, 'abc')).toBe(true)
    expect(accepts(name, 'a')).toBe(false)
    expect(accepts(name, 'abcde')).toBe(false)
    expect(accepts(name, 'AB')).toBe(false)

    expect(accepts({ type: 'string', format: 'email' }, 'ada@example.com')).toBe(true)
    expect(accepts({ type: 'string', format: 'email' }, 'ada')).toBe(false)
    expect(accepts({ type: 'string', format: 'uri' }, 'https://example.com')).toBe(true)
    expect(accepts({ type: 'string', format: 'uri' }, 'not a uri')).toBe(false)
    expect(accepts({ type: 'string', format: 'date' }, '2024-01-01')).toBe(true)
    expect(accepts({ type: 'string', format: 'date' }, '2024-13-01')).toBe(false)
    const dateTime = { type: 'string', format: 'date-time' }
    expect(accepts(dateTime, '1969-09-26T00:00:00+00:00')).toBe(true)
    expect(accepts(dateTime, '1969-09-26T00:00:00Z')).toBe(true)
    expect(accepts(dateTime, '1969-09-26')).toBe(false)
    expect(
      accepts({ type: 'string', format: 'uuid' }, '5f1d7c2e-8a4b-4e6f-9c3d-2b1a0e9f8d7c'),
    ).toBe(true)
  })

  it('skips a format with no Zod mapping, with a warning', () => {
    const { source, warnings } = map({ type: 'string', format: 'iban' })
    expect(source).toBe('z.string()')
    expect(warnings).toEqual([expect.stringContaining('field has format "iban"')])
  })

  it('skips a pattern JavaScript cannot compile, with a warning, instead of throwing', () => {
    const { source, warnings } = map({ type: 'string', minLength: 1, pattern: '(?<' })
    expect(source).toBe('z.string().min(1)')
    expect(warnings).toEqual([expect.stringContaining("pattern JavaScript can't compile")])
  })

  it('compiles a pattern without the u flag when only that works', () => {
    expect(map({ type: 'string', pattern: '\\-' }).source).toBe(
      'z.string().regex(new RegExp("\\\\-"))',
    )
  })

  it('skips a keyword with no Zod mapping, with a warning', () => {
    const { source, warnings } = map({ type: 'string', not: { const: 'x' } })
    expect(source).toBe('z.string()')
    expect(warnings).toEqual([expect.stringContaining('field uses "not"')])
  })

  it('ignores annotations and x- extensions', () => {
    const { warnings } = map({
      type: 'string',
      description: 'd',
      examples: ['a'],
      default: 'a',
      deprecated: true,
      'x-anything': 1,
    })
    expect(warnings).toEqual([])
  })

  it('maps number bounds, multipleOf and integer', () => {
    const rating = { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 10 }
    expect(map(rating).source).toBe('z.number().gt(0).lt(10)')
    expect(accepts(rating, 0)).toBe(false)
    expect(accepts(rating, 9.5)).toBe(true)
    const count = { type: 'integer', minimum: 0, maximum: 100, multipleOf: 10 }
    expect(map(count).source).toBe('z.int().gte(0).lte(100).multipleOf(10)')
    expect(accepts(count, 20)).toBe(true)
    expect(accepts(count, 25)).toBe(false)
    expect(accepts(count, 1.5)).toBe(false)
    expect(accepts(count, 110)).toBe(false)
  })

  it('reads a draft-4 boolean exclusiveMinimum against minimum', () => {
    expect(map({ type: 'number', minimum: 1, exclusiveMinimum: true }).source).toBe(
      'z.number().gt(1)',
    )
  })

  it('maps nullable types and type lists', () => {
    expect(map({ type: ['string', 'null'] }).source).toBe('z.string().nullable()')
    expect(map({ type: ['string', 'integer', 'boolean'] }).source).toBe(
      'z.union([z.string(), z.int(), z.boolean()])',
    )
    expect(map({ type: 'null' }).source).toBe('z.null()')
  })

  it('maps enum and const', () => {
    expect(map({ type: 'string', enum: ['a', 'b'] }).source).toBe('z.enum(["a", "b"])')
    expect(map({ enum: [1, 'two', null] }).source).toBe('z.literal([1, "two"]).nullable()')
    expect(map({ type: 'string', const: 'vinyl' }).source).toBe('z.literal("vinyl")')
    expect(accepts({ const: true }, true)).toBe(true)
    expect(accepts({ const: true }, false)).toBe(false)
  })

  it('expands a $ref, with the keywords beside it applied on top', () => {
    expect(map({ $ref: '#/components/schemas/Status' }).source).toBe(
      'z.enum(["draft", "published"])',
    )
    expect(map({ $ref: '#/components/schemas/Priority', type: 'integer' }).source).toBe(
      'z.literal([1, 2])',
    )
    expect(map({ $ref: '#/components/schemas/Reviewer' }).source).toBe(
      'z.strictObject({ name: z.string().min(1) })',
    )
  })

  it('stops at a self-referential $ref with a warning', () => {
    const { source, warnings } = map({ $ref: '#/components/schemas/Node' })
    expect(source).toBe('z.looseObject({ child: z.exactOptional(z.unknown()) })')
    expect(warnings).toEqual([expect.stringContaining('refers to Node inside itself')])
  })

  it('maps arrays: items, bounds and uniqueness', () => {
    const tags = { type: 'array', items: { type: 'string' }, maxItems: 2, uniqueItems: true }
    expect(accepts(tags, ['a', 'b'])).toBe(true)
    expect(accepts(tags, ['a', 'b', 'c'])).toBe(false)
    expect(accepts(tags, ['a', 'a'])).toBe(false)
    expect(accepts(tags, [1])).toBe(false)

    const nonEmpty = { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 }
    expect(map(nonEmpty).source).toBe(
      'nonEmpty(z.string()).check(z.minLength(2)).check(z.maxLength(3))',
    )
    expect(accepts(nonEmpty, [])).toBe(false)
    expect(accepts(nonEmpty, ['a'])).toBe(false)
    expect(accepts(nonEmpty, ['a', 'b'])).toBe(true)
    expect(accepts(nonEmpty, ['a', 'b', 'c', 'd'])).toBe(false)
  })

  it('maps objects by their required members and additionalProperties', () => {
    const closed = {
      type: 'object',
      properties: { street: { type: 'string' }, city: { type: 'string' } },
      required: ['street'],
      additionalProperties: false,
    }
    expect(map(closed).source).toBe(
      'z.strictObject({ street: z.string(), city: z.exactOptional(z.string()) })',
    )
    expect(accepts(closed, { street: 'Main' })).toBe(true)
    expect(accepts(closed, { city: 'Leeds' })).toBe(false)
    expect(accepts(closed, { street: 'Main', zip: '1' })).toBe(false)

    const open = { type: 'object', properties: { a: { type: 'string' } } }
    expect(map(open).source).toBe('z.looseObject({ a: z.exactOptional(z.string()) })')
    expect(map({ type: 'object', additionalProperties: { type: 'string' } }).source).toBe(
      'z.record(z.string(), z.string())',
    )
    expect(map({ type: 'object' }).source).toBe('z.record(z.string(), z.unknown())')
    const row = {
      type: 'object',
      properties: { Key: { type: 'string' } },
      required: ['Key'],
      additionalProperties: { type: ['string', 'null'] },
      maxProperties: 2,
    }
    expect(accepts(row, { Key: 'k', other: null })).toBe(true)
    expect(accepts(row, { Key: 'k', other: 1 })).toBe(false)
    expect(accepts(row, { Key: 'k', a: 'a', b: 'b' })).toBe(false)
  })

  it('maps a oneOf with a discriminator to a discriminated union, nullable by its null branch', () => {
    const format = {
      oneOf: [
        {
          type: 'object',
          properties: { medium: { type: 'string', const: 'cd' }, discs: { type: 'integer' } },
          required: ['medium', 'discs'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { medium: { type: 'string', const: 'digital' } },
          required: ['medium'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
      discriminator: { propertyName: 'medium' },
    }
    const { source, schema } = map(format)
    expect(source).toMatch(/^z\.discriminatedUnion\("medium", \[.*\]\)\.nullable\(\)$/)
    expect(schema.safeParse({ medium: 'cd', discs: 2 }).success).toBe(true)
    expect(schema.safeParse(null).success).toBe(true)
    expect(schema.safeParse({ medium: 'cd' }).error?.issues.map((i) => i.path)).toEqual([['discs']])
  })

  it('maps any other oneOf or anyOf to a union, giving untyped branches the parent type', () => {
    expect(map({ oneOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }] }).source).toBe(
      'z.union([z.string(), z.int().gte(0)])',
    )
    expect(map({ type: 'string', anyOf: [{ minLength: 3 }, { format: 'email' }] }).source).toBe(
      'z.union([z.string().min(3), z.email()])',
    )
  })

  it("intersects allOf members, and the node's own keywords beside a combinator", () => {
    const dimensions = {
      allOf: [
        { type: 'object', properties: { w: { type: 'number' } }, required: ['w'] },
        { type: 'object', properties: { d: { type: 'number' } } },
      ],
    }
    expect(accepts(dimensions, { w: 1, d: 2 })).toBe(true)
    expect(accepts(dimensions, { d: 2 })).toBe(false)
    expect(map({ type: 'string', maxLength: 3, anyOf: [{ minLength: 1 }] }).source).toBe(
      'z.intersection(z.string().max(3), z.string().min(1))',
    )
  })
})

const load = (name: 'music-catalog.openapi.json' | 'contract-witness.json'): OpenApiDocument =>
  JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument

describe('emitZod', () => {
  it('emits a header, the zod import, a schema per write and the inputSchemas map', () => {
    const doc = load('music-catalog.openapi.json')
    const warnings: string[] = []
    const source = emitZod(doc, buildDescriptor(doc), (message) => warnings.push(message))
    expect(source).toContain('AUTO-GENERATED by @haddowg/json-api-codegen')
    expect(source).toContain("import { z } from 'zod'")
    expect(source).toContain('export const albumsCreateSchema = z.object({')
    expect(source).toContain(
      '  albums: { create: albumsCreateSchema, update: albumsUpdateSchema },',
    )
    // A singleton has no create, and its update carries the resource id.
    expect(source).toContain('  accounts: { update: accountsUpdateSchema },')
    expect(source).toMatch(
      /export const accountsUpdateSchema = z\.object\(\{[^]*?\n {2}id: z\.string\(\),/,
    )
    expect(warnings).toEqual([])
  })

  it('types id on create by the client-id policy', () => {
    const doc = load('music-catalog.openapi.json')
    const source = emitZod(doc, buildDescriptor(doc), () => {})
    const block = (name: string): string =>
      new RegExp(`export const ${name} = z\\.object\\(\\{[^]*?\\n\\}\\)`).exec(source)![0]
    expect(block('albumsCreateSchema')).toContain('id: z.exactOptional(z.never())')
  })

  it('requires, and refuses null and empty for, a relation as each write does', () => {
    const doc = load('contract-witness.json')
    const source = emitZod(doc, buildDescriptor(doc), () => {})
    const block = (name: string): string =>
      new RegExp(`export const ${name} = z\\.object\\(\\{[^]*?\\n\\}\\)`).exec(source)![0]
    // people.company is required on create and refuses null on both, but relates to no declared type.
    expect(block('peopleCreateSchema')).toContain('  company: z.never(),')
    expect(block('peopleUpdateSchema')).toContain('  company: z.exactOptional(z.never()),')
    expect(block('tagsCreateSchema')).toContain('  articles: nonEmpty(tagsRefs["articles"]),')
    expect(block('tagsUpdateSchema')).toContain(
      '  articles: z.exactOptional(z.array(tagsRefs["articles"])),',
    )
    expect(source).toContain('const nonEmpty = <T extends z.ZodType>(item: T) =>')
  })

  it('maps the contract witness without warnings', () => {
    const doc = load('contract-witness.json')
    const warnings: string[] = []
    emitZod(doc, buildDescriptor(doc), (message) => warnings.push(message))
    expect(warnings).toEqual([])
  })
})
