import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import { fixture } from './test-fixtures'
import type { JsonSchema } from './openapi'

/*
 * The rules every tool input schema is held to, from the two model APIs' documentation:
 *
 * OpenAI strict function calling: the root is an object and not an `anyOf`; every object sets
 * `additionalProperties: false` and lists every property in `required`; only `type`,
 * `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `anyOf`,
 * `description`, `format` and the numeric and array bounds are understood; formats are limited;
 * nesting stays within 10 levels, 5000 properties and 1000 enum values; a nullable enum lists
 * `null`.
 *
 * Anthropic tool input: the root is an object with no `oneOf`, `allOf` or `anyOf` at the top.
 * Strict tool use also wants `additionalProperties: false` on every object, no numeric
 * (`minimum`, `maximum`, `multipleOf`) or length constraints, no complex array constraints, no
 * recursion and a limited set of formats.
 */

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])
const OPENAI_KEYWORDS = new Set([
  'type',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'format',
])
const ANTHROPIC_KEYWORDS = new Set([...OPENAI_KEYWORDS, 'allOf', '$ref', '$defs', 'default'])
const OPENAI_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uuid',
])
const ANTHROPIC_FORMATS = new Set([...OPENAI_FORMATS, 'uri'])
const BANNED = ['oneOf', 'if', 'then', 'else', 'not']

interface Tally {
  properties: number
  enumValues: number
  maxDepth: number
}

function typesOf(schema: JsonSchema): string[] {
  const type = schema['type']
  return typeof type === 'string' ? [type] : Array.isArray(type) ? (type as string[]) : []
}

/** Collect every rule a schema breaks, under both APIs. */
function violations(
  schema: JsonSchema,
  path: string,
  depth: number,
  tally: Tally,
  out: string[],
): void {
  tally.maxDepth = Math.max(tally.maxDepth, depth)
  for (const key of Object.keys(schema)) {
    if (BANNED.includes(key)) out.push(`${path}: uses ${key}`)
    if (!OPENAI_KEYWORDS.has(key)) out.push(`${path}: OpenAI strict mode doesn't understand ${key}`)
    if (!ANTHROPIC_KEYWORDS.has(key))
      out.push(`${path}: Anthropic strict tool use doesn't understand ${key}`)
  }
  const types = typesOf(schema)
  for (const type of types) {
    if (!TYPES.has(type)) out.push(`${path}: unknown type ${type}`)
  }
  if (types.length === 0 && schema['anyOf'] === undefined && schema['enum'] === undefined) {
    out.push(`${path}: names no type`)
  }
  if (typeof schema['format'] === 'string') {
    if (!OPENAI_FORMATS.has(schema['format']))
      out.push(`${path}: OpenAI rejects format ${schema['format']}`)
    if (!ANTHROPIC_FORMATS.has(schema['format']))
      out.push(`${path}: Anthropic rejects format ${schema['format']}`)
  }
  if (Array.isArray(schema['enum'])) {
    const values = schema['enum'] as unknown[]
    tally.enumValues += values.length
    if (types.includes('null') && !values.includes(null))
      out.push(`${path}: nullable enum without null`)
  }
  if (types.includes('object')) {
    const properties = (schema['properties'] ?? {}) as Record<string, JsonSchema>
    if (schema['additionalProperties'] !== false)
      out.push(`${path}: object without additionalProperties: false`)
    const required = new Set((schema['required'] ?? []) as string[])
    for (const name of Object.keys(properties)) {
      if (!required.has(name)) out.push(`${path}.${name}: not listed in required`)
    }
    tally.properties += Object.keys(properties).length
    for (const [name, prop] of Object.entries(properties)) {
      violations(prop, `${path}.${name}`, depth + 1, tally, out)
    }
  }
  if (types.includes('array')) {
    if (schema['items'] === undefined) out.push(`${path}: array without items`)
    else violations(schema['items'] as JsonSchema, `${path}[]`, depth + 1, tally, out)
  }
  if (Array.isArray(schema['anyOf'])) {
    ;(schema['anyOf'] as JsonSchema[]).forEach((branch, i) =>
      violations(branch, `${path}|${i}`, depth, tally, out),
    )
  }
}

export function inputSchemaViolations(schema: JsonSchema): string[] {
  const out: string[] = []
  if (schema['type'] !== 'object') out.push('root: not an object')
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (schema[key] !== undefined) out.push(`root: ${key} at the top level`)
  }
  const tally: Tally = { properties: 0, enumValues: 0, maxDepth: 0 }
  violations(schema, 'root', 1, tally, out)
  if (tally.maxDepth > 10) out.push(`nests ${tally.maxDepth} levels deep`)
  if (tally.properties > 5000) out.push(`has ${tally.properties} properties`)
  if (tally.enumValues > 1000) out.push(`has ${tally.enumValues} enum values`)
  return out
}

describe('every input schema is portable', () => {
  for (const name of ['music-catalog', 'music-catalog-admin', 'contract-witness'] as const) {
    for (const includeDepth of [1, 2, null]) {
      const mcp = createJsonApiMcp(fixture(name, { includeDepth }))
      it.each(mcp.tools.map((tool) => [tool.name, tool] as const))(
        `${name}, include depth ${includeDepth}: %s`,
        (_, tool) => {
          expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
          expect(inputSchemaViolations(tool.inputSchema)).toEqual([])
          expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"(oneOf|if|then)"/)
        },
      )
    }
  }

  it('lists the include paths a tool accepts as an enum on a nullable array', () => {
    const tools = createJsonApiMcp(fixture('music-catalog')).tools
    const include = (
      tools.find((t) => t.name === 'albums_get')!.inputSchema['properties'] as Record<
        string,
        JsonSchema
      >
    )['include']
    expect(include).toMatchObject({
      type: ['array', 'null'],
      items: { type: 'string', enum: ['artist', 'tracks'] },
    })
  })

  it('catches what it should', () => {
    expect(
      inputSchemaViolations({
        type: 'object',
        properties: {
          a: { oneOf: [{ type: 'string' }] },
          b: { type: 'object', properties: { c: { type: 'string', minLength: 1 } } },
        },
        required: ['a'],
      }),
    ).toEqual(
      expect.arrayContaining([
        'root: object without additionalProperties: false',
        'root.b: not listed in required',
        'root.a: uses oneOf',
        'root.b: object without additionalProperties: false',
        "root.b.c: OpenAI strict mode doesn't understand minLength",
      ]),
    )
  })
})
