/**
 * Convert document schemas into tool input schemas every major model API accepts: OpenAI's strict
 * function calling and Anthropic's strict tool use. That means no `oneOf`, `allOf`, `if`, `then`
 * or `$ref`, every object closed with `additionalProperties: false` and listing all its
 * properties as required, an optional property made nullable instead, and no numeric, length or
 * pattern keywords. Constraints that can't stay as keywords move into the description, and a
 * value with no portable shape, such as a free-form object, is taken as JSON text.
 *
 * Each schema comes with a {@link Decoder} that turns the arguments a model sends back into the
 * value the API expects: a `null` the conversion added is dropped, and JSON text is parsed.
 */
import { isObject, type JsonSchema, type OpenApiDocument, resolvePointer } from './openapi'

/** The string formats both APIs accept. */
export const PORTABLE_FORMATS: ReadonlySet<string> = new Set([
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

/** Objects may nest this deep before a value is taken as JSON text instead. */
const MAX_DEPTH = 6

export type Decoder =
  | { kind: 'value' }
  | { kind: 'json' }
  | { kind: 'object'; props: Readonly<Record<string, PropertyDecoder>> }
  | { kind: 'array'; items: Decoder }

export interface PropertyDecoder {
  decoder: Decoder
  /** The conversion made this property nullable, so `null` means "not given". */
  nullMeansOmit: boolean
}

export interface Portable {
  schema: JsonSchema
  decoder: Decoder
}

const VALUE: Decoder = { kind: 'value' }

/** Thrown when a model's argument can't be decoded, such as JSON text that doesn't parse. */
export class ArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgumentError'
  }
}

/** Turn a model's argument back into the value the API expects. */
export function decode(value: unknown, decoder: Decoder, path = 'value'): unknown {
  if (value === null || value === undefined) {
    return value
  }
  switch (decoder.kind) {
    case 'json':
      if (typeof value !== 'string') {
        return value
      }
      try {
        return JSON.parse(value) as unknown
      } catch {
        throw new ArgumentError(`${path} must be JSON text`)
      }
    case 'array':
      return Array.isArray(value)
        ? value.map((item, index) => decode(item, decoder.items, `${path}[${index}]`))
        : value
    case 'object': {
      if (!isObject(value)) {
        return value
      }
      const out: Record<string, unknown> = {}
      for (const [key, member] of Object.entries(value)) {
        const prop = decoder.props[key]
        if (prop === undefined) {
          out[key] = member
        } else if (!(member === null && prop.nullMeansOmit)) {
          out[key] = decode(member, prop.decoder, `${path}.${key}`)
        }
      }
      return out
    }
    default:
      return value
  }
}

/** Add `null` to a portable schema's allowed values. */
export function nullable(schema: JsonSchema): JsonSchema {
  const out = { ...schema }
  if (Array.isArray(out['anyOf'])) {
    const branches = out['anyOf'] as JsonSchema[]
    if (!branches.some((b) => b['type'] === 'null')) {
      out['anyOf'] = [...branches, { type: 'null' }]
    }
    return out
  }
  const type = out['type']
  if (typeof type === 'string' && type !== 'null') {
    out['type'] = [type, 'null']
  } else if (Array.isArray(type) && !type.includes('null')) {
    out['type'] = [...(type as string[]), 'null']
  }
  if (Array.isArray(out['enum']) && !(out['enum'] as unknown[]).includes(null)) {
    out['enum'] = [...(out['enum'] as unknown[]), null]
  }
  return out
}

/** Whether a portable schema already allows `null`. */
export function allowsNull(schema: JsonSchema): boolean {
  const type = schema['type']
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) {
    return true
  }
  return Array.isArray(schema['anyOf']) && (schema['anyOf'] as JsonSchema[]).some(allowsNull)
}

/** A closed object schema listing every property as required, as strict mode wants. */
export function closedObject(
  properties: Record<string, JsonSchema>,
  description?: string,
): JsonSchema {
  const schema: JsonSchema = {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }
  if (description !== undefined && description !== '') {
    schema['description'] = description
  }
  return schema
}

const jsonText = (description: string | undefined): Portable => ({
  schema: {
    type: 'string',
    description: joinText(description, 'Send the value as JSON text.'),
  },
  decoder: { kind: 'json' },
})

function joinText(...parts: (string | undefined)[]): string {
  return parts
    .filter((part): part is string => part !== undefined && part.trim() !== '')
    .map((part) => part.trim())
    .join(' ')
}

/** The non-null `type` keys a schema names. */
function typeKeys(schema: JsonSchema): { types: string[]; nullable: boolean } {
  const raw = schema['type']
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? (raw as string[]) : []
  return { types: list.filter((t) => t !== 'null'), nullable: list.includes('null') }
}

function inferType(values: readonly unknown[]): string | undefined {
  const types = new Set(
    values
      .filter((v) => v !== null)
      .map((v) =>
        typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v,
      ),
  )
  if (types.size === 1) {
    return [...types][0]
  }
  if (types.size === 2 && types.has('integer') && types.has('number')) {
    return 'number'
  }
  return undefined
}

/** A range as a sentence, such as `Between 1 and 200 characters.` */
function bounds(
  min: number | undefined,
  max: number | undefined,
  unit: string,
): string | undefined {
  const suffix = unit === '' ? '' : ` ${unit}`
  if (min !== undefined && max !== undefined) return `Between ${min} and ${max}${suffix}.`
  if (min !== undefined) return `At least ${min}${suffix}.`
  if (max !== undefined) return `At most ${max}${suffix}.`
  return undefined
}

/** The constraints a schema states that can't stay as keywords, as sentences. */
function constraintNote(schema: JsonSchema): string | undefined {
  const num = (key: string): number | undefined =>
    typeof schema[key] === 'number' ? schema[key] : undefined
  const notes = [
    bounds(num('minLength'), num('maxLength'), 'characters'),
    bounds(num('minimum'), num('maximum'), ''),
    num('exclusiveMinimum') === undefined ? undefined : `Greater than ${num('exclusiveMinimum')}.`,
    num('exclusiveMaximum') === undefined ? undefined : `Less than ${num('exclusiveMaximum')}.`,
    num('multipleOf') === undefined ? undefined : `A multiple of ${num('multipleOf')}.`,
    bounds(num('minItems'), num('maxItems'), 'items'),
    typeof schema['pattern'] === 'string'
      ? `Matches the pattern \`${schema['pattern']}\`.`
      : undefined,
    typeof schema['format'] === 'string' && !PORTABLE_FORMATS.has(schema['format'])
      ? `Format: ${schema['format']}.`
      : undefined,
    schema['default'] === undefined
      ? undefined
      : `Defaults to ${JSON.stringify(schema['default'])}.`,
  ].filter((note): note is string => note !== undefined)
  return notes.length === 0 ? undefined : notes.join(' ')
}

/** Merge an `allOf` into one schema: the members' keywords, then the outer node's own. */
function mergeAllOf(
  doc: OpenApiDocument,
  node: JsonSchema,
  stack: readonly string[],
): JsonSchema | undefined {
  const members = node['allOf'] as unknown[]
  const merged: JsonSchema = {}
  const properties: Record<string, unknown> = {}
  const required = new Set<string>()
  for (const member of members) {
    const resolved = follow(doc, member, stack)
    if (resolved === undefined) {
      return undefined
    }
    const inner = Array.isArray(resolved.node['allOf'])
      ? mergeAllOf(doc, resolved.node, resolved.stack)
      : resolved.node
    if (inner === undefined) {
      return undefined
    }
    Object.assign(properties, isObject(inner['properties']) ? inner['properties'] : {})
    for (const key of Array.isArray(inner['required']) ? (inner['required'] as string[]) : []) {
      required.add(key)
    }
    Object.assign(merged, inner)
  }
  const { allOf: _allOf, ...own } = node
  Object.assign(merged, own)
  if (Object.keys(properties).length > 0) {
    merged['properties'] = {
      ...properties,
      ...(isObject(own['properties']) ? own['properties'] : {}),
    }
  }
  if (required.size > 0 || Array.isArray(own['required'])) {
    merged['required'] = [
      ...required,
      ...(Array.isArray(own['required']) ? (own['required'] as string[]) : []),
    ]
  }
  return merged
}

/**
 * Follow a node's `$ref`s, keeping the outermost description. `undefined` on a cycle, which the
 * caller then takes as JSON text.
 */
function follow(
  doc: OpenApiDocument,
  value: unknown,
  stack: readonly string[],
): { node: JsonSchema; stack: readonly string[] } | undefined {
  let node: unknown = value
  let description: string | undefined
  let path = stack
  while (isObject(node) && typeof node['$ref'] === 'string') {
    const ref = node['$ref']
    if (description === undefined && typeof node['description'] === 'string') {
      description = node['description']
    }
    if (path.includes(ref)) {
      return undefined
    }
    path = [...path, ref]
    node = resolvePointer(doc, ref)
  }
  if (node === true) {
    return { node: {}, stack: path }
  }
  if (!isObject(node)) {
    return undefined
  }
  return {
    node: description === undefined ? node : { ...node, description },
    stack: path,
  }
}

const isNull = (b: unknown): boolean => isObject(b) && b['type'] === 'null'

/** Convert one document schema into a portable input schema and its decoder. */
export function toPortable(
  doc: OpenApiDocument,
  raw: unknown,
  stack: readonly string[] = [],
  depth = 0,
): Portable {
  const outerDescription =
    isObject(raw) && typeof raw['description'] === 'string' ? raw['description'] : undefined
  const followed = follow(doc, raw, stack)
  if (followed === undefined) {
    return jsonText(outerDescription)
  }
  let node = followed.node
  const path = followed.stack
  if (Array.isArray(node['allOf'])) {
    const merged = mergeAllOf(doc, node, path)
    if (merged === undefined) {
      return jsonText(outerDescription)
    }
    node = merged
  }
  const description = typeof node['description'] === 'string' ? node['description'] : undefined

  const branches = (node['oneOf'] ?? node['anyOf']) as unknown[] | undefined
  if (Array.isArray(branches)) {
    const { oneOf: _oneOf, anyOf: _anyOf, ...rest } = node
    const others = branches.filter((b) => !isNull(b))
    const withNull = others.length < branches.length
    if (others.length === 1) {
      const resolved = follow(doc, others[0], path)
      if (resolved === undefined) {
        return jsonText(description)
      }
      const single = toPortable(doc, { ...resolved.node, ...rest }, resolved.stack, depth)
      return withNull ? { ...single, schema: nullable(single.schema) } : single
    }
    if (depth >= MAX_DEPTH) {
      return jsonText(description)
    }
    const converted = others.map((b) => toPortable(doc, b, path, depth + 1).schema)
    const schema: JsonSchema = { anyOf: withNull ? [...converted, { type: 'null' }] : converted }
    const text = joinText(description, constraintNote(node))
    if (text !== '') {
      schema['description'] = text
    }
    return { schema, decoder: VALUE }
  }

  let { types, nullable: isNullable } = typeKeys(node)
  const enumValues = Array.isArray(node['enum'])
    ? (node['enum'] as unknown[])
    : node['const'] !== undefined
      ? [node['const']]
      : undefined
  if (enumValues !== undefined && enumValues.includes(null)) {
    isNullable = true
  }
  if (types.length === 0) {
    const inferred =
      enumValues !== undefined
        ? inferType(enumValues)
        : isObject(node['properties'])
          ? 'object'
          : node['items'] !== undefined
            ? 'array'
            : undefined
    if (inferred === undefined) {
      return jsonText(description)
    }
    types = [inferred]
  }
  if (types.length > 1) {
    const schema: JsonSchema = {
      anyOf: [...types.map((type) => ({ type })), ...(isNullable ? [{ type: 'null' }] : [])],
    }
    if (description !== undefined) {
      schema['description'] = description
    }
    return { schema, decoder: VALUE }
  }

  const type = types[0]!
  const text = joinText(description, constraintNote(node))
  let result: Portable

  if (type === 'object') {
    const props = isObject(node['properties']) ? node['properties'] : {}
    const writable = Object.entries(props).filter(
      ([, prop]) => !(isObject(prop) && prop['readOnly'] === true),
    )
    if (writable.length === 0 || depth >= MAX_DEPTH) {
      return jsonText(text)
    }
    const required = new Set(Array.isArray(node['required']) ? (node['required'] as string[]) : [])
    const properties: Record<string, JsonSchema> = {}
    const decoders: Record<string, PropertyDecoder> = {}
    for (const [key, prop] of writable) {
      const converted = toPortable(doc, prop, path, depth + 1)
      const optional = !required.has(key)
      const addNull = optional && !allowsNull(converted.schema)
      properties[key] = addNull ? nullable(converted.schema) : converted.schema
      decoders[key] = { decoder: converted.decoder, nullMeansOmit: addNull }
    }
    result = {
      schema: closedObject(properties, text),
      decoder: { kind: 'object', props: decoders },
    }
  } else if (type === 'array') {
    if (node['items'] === undefined || node['items'] === true || depth >= MAX_DEPTH) {
      return jsonText(text)
    }
    const items = toPortable(doc, node['items'], path, depth + 1)
    result = {
      schema: { type: 'array', items: items.schema },
      decoder: { kind: 'array', items: items.decoder },
    }
    if (text !== '') {
      result.schema['description'] = text
    }
  } else {
    const schema: JsonSchema = { type }
    if (text !== '') {
      schema['description'] = text
    }
    if (enumValues !== undefined) {
      schema['enum'] = enumValues.filter((v) => v !== null)
    }
    if (
      type === 'string' &&
      typeof node['format'] === 'string' &&
      PORTABLE_FORMATS.has(node['format'])
    ) {
      schema['format'] = node['format']
    }
    result = { schema, decoder: VALUE }
  }

  return isNullable ? { ...result, schema: nullable(result.schema) } : result
}
