import type { ApiDescriptor, PivotDescriptor, RelationDescriptor } from '@haddowg/json-api-client'
import { indexBases, isSchema, refName, schemaTypes, typeStem, writeComponents } from './emit'
import type { OpenApiDocument, SchemaObject, SchemaOrBool } from './openapi'
import { deriveProvenance, provenanceLines } from './provenance'
import { propertyKey, stringLiteral } from './source'
import { unwrapRefs } from './unwrap-refs'

/** Keywords that only annotate a schema, which a Zod schema has no need of. */
const ANNOTATIONS = new Set([
  'title',
  'description',
  'example',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  '$comment',
  '$id',
  '$schema',
  'contentEncoding',
  'contentMediaType',
])

/** Keywords {@link ZodMapper} turns into Zod. */
const MAPPED = new Set([
  '$ref',
  'type',
  'const',
  'enum',
  'anyOf',
  'oneOf',
  'allOf',
  'discriminator',
  'properties',
  'required',
  'additionalProperties',
  'minProperties',
  'maxProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
])

/** The Zod v4 schema each mapped string `format` starts from. */
const FORMATS: Readonly<Record<string, string>> = {
  email: 'z.email()',
  uri: 'z.url()',
  url: 'z.url()',
  uuid: 'z.uuid()',
  // RFC 3339 requires an offset or `Z`, and allows any offset.
  'date-time': 'z.iso.datetime({ offset: true })',
  date: 'z.iso.date()',
  time: 'z.iso.time()',
  duration: 'z.iso.duration()',
  ipv4: 'z.ipv4()',
  ipv6: 'z.ipv6()',
}

const UNIQUE_ITEMS =
  ".refine((items) => new Set(items.map((item) => JSON.stringify(item))).size === items.length, 'Items must be unique')"

/** Called with a message for each keyword the mapping skips. */
export type ZodWarn = (message: string) => void

const defaultWarn: ZodWarn = (message) => {
  console.warn(`[json-api-codegen] ${message}`)
}

function isNullSchema(schema: SchemaObject): boolean {
  const types = schemaTypes(schema)
  return types.length === 1 && types[0] === 'null' && schema.$ref === undefined
}

/** One value as `z.literal`; several as `z.enum` when every one is a string, else a multi-value `z.literal`. */
function literals(values: readonly unknown[]): string {
  const unique = [...new Set(values)]
  if (unique.length > 1 && unique.every((value) => typeof value === 'string')) {
    return `z.enum([${unique.map((value) => stringLiteral(value)).join(', ')}])`
  }
  const rendered = unique.map((value) =>
    typeof value === 'string' ? stringLiteral(value) : String(value),
  )
  return rendered.length === 1 ? `z.literal(${rendered[0]})` : `z.literal([${rendered.join(', ')}])`
}

function isLiteralValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

function union(members: readonly string[]): string {
  const unique = [...new Set(members)]
  return unique.length === 1 ? unique[0]! : `z.union([${unique.join(', ')}])`
}

function nullable(expression: string, isNullable: boolean): string {
  return isNullable ? `${expression}.nullable()` : expression
}

/** An object member, wrapped in `z.exactOptional` unless required. */
function member(name: string, value: string, required: boolean): string {
  return `${propertyKey(name)}: ${required ? value : `z.exactOptional(${value})`}`
}

/**
 * Declared once in a generated module that needs it, so a `[T, ...T[]]` list builds its item
 * schema once.
 */
const NON_EMPTY = 'const nonEmpty = <T extends z.ZodType>(item: T) => z.tuple([item], item)'

/**
 * Turns JSON Schema nodes from a document's `components.schemas` into Zod v4 source, keyword by
 * keyword, following the same `$ref`s and unions the TypeScript emitter reads. A keyword with no
 * Zod counterpart, or a `pattern` JavaScript can't compile, is left out with a warning.
 */
export class ZodMapper {
  /** Component names mid-expansion, so a self-referential `$ref` stops instead of recursing. */
  private readonly expanding = new Set<string>()
  /** Whether a mapped schema calls the module's `nonEmpty` helper. */
  usesNonEmpty = false

  constructor(
    private readonly schemas: Readonly<Record<string, SchemaObject>>,
    private readonly warn: ZodWarn = defaultWarn,
  ) {}

  /** The Zod expression validating `schema`; `path` names the node in warnings. */
  map(schema: SchemaOrBool | undefined, path: string): string {
    if (schema === false) {
      return 'z.never()'
    }
    if (!isSchema(schema)) {
      return 'z.unknown()'
    }
    this.warnUnmapped(schema, path)

    if (typeof schema.$ref === 'string') {
      return this.reference(schema, path)
    }
    if ('const' in schema) {
      const value = schema['const']
      if (!isLiteralValue(value)) {
        this.warn(`zod: ${path} has a non-scalar "const"; the schema accepts any value there.`)
        return 'z.unknown()'
      }
      return value === null ? 'z.null()' : literals([value])
    }
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      const scalar = schema.enum.filter(isLiteralValue)
      if (scalar.length !== schema.enum.length) {
        this.warn(`zod: ${path} has non-scalar "enum" values; the schema skips them.`)
      }
      const nonNull = scalar.filter((value) => value !== null)
      const isNullable = scalar.includes(null) || schemaTypes(schema).includes('null')
      if (nonNull.length === 0) {
        return isNullable ? 'z.null()' : 'z.never()'
      }
      return nullable(literals(nonNull), isNullable)
    }

    const branches = schema.anyOf ?? schema.oneOf
    const combined: string[] = []
    if (branches !== undefined && branches.length > 0) {
      combined.push(this.union(schema, branches, path))
    }
    for (const [i, entry] of (schema.allOf ?? []).entries()) {
      combined.push(this.map(this.inherit(schema, entry), `${path}.allOf[${i}]`))
    }
    if (combined.length === 0) {
      return this.typed(schema, path)
    }
    // The node's own keywords still apply beside its combinators; its `type` already reached
    // each branch through inherit().
    const own = Object.keys(schema).filter(
      (key) =>
        MAPPED.has(key) &&
        !['type', 'anyOf', 'oneOf', 'allOf', 'discriminator'].includes(key) &&
        !(key === 'additionalProperties' && this.isOpen(schema['additionalProperties'])),
    )
    if (own.length > 0) {
      combined.unshift(this.typed(schema, path))
    }
    return combined.reduce((left, right) => `z.intersection(${left}, ${right})`)
  }

  private warnUnmapped(schema: SchemaObject, path: string): void {
    for (const key of Object.keys(schema)) {
      if (!MAPPED.has(key) && !ANNOTATIONS.has(key) && !key.startsWith('x-')) {
        this.warn(`zod: ${path} uses "${key}", which has no Zod mapping; the schema skips it.`)
      }
    }
  }

  /** A `$ref` expanded in place, with the keywords beside it applied on top of the component's. */
  private reference(schema: SchemaObject, path: string): string {
    const target = refName(schema.$ref!)
    const resolved = target === undefined ? undefined : this.schemas[target]
    if (target === undefined || resolved === undefined) {
      this.warn(`zod: ${path} refers to ${schema.$ref}, which the document doesn't define.`)
      return 'z.unknown()'
    }
    if (this.expanding.has(target)) {
      this.warn(
        `zod: ${path} refers to ${target} inside itself; the schema accepts any value there.`,
      )
      return 'z.unknown()'
    }
    const { $ref: _ref, ...siblings } = schema
    this.expanding.add(target)
    const expression = this.map({ ...resolved, ...siblings }, path)
    this.expanding.delete(target)
    return expression
  }

  /** A branch with no type of its own takes its parent's, as JSON Schema applies both. */
  private inherit(parent: SchemaObject, branch: SchemaObject): SchemaObject {
    if (
      parent.type === undefined ||
      branch.type !== undefined ||
      branch.$ref !== undefined ||
      'const' in branch ||
      branch.enum !== undefined ||
      branch.anyOf !== undefined ||
      branch.oneOf !== undefined ||
      branch.allOf !== undefined
    ) {
      return branch
    }
    return { ...branch, type: parent.type }
  }

  private isOpen(extra: unknown): boolean {
    return (
      extra === undefined ||
      extra === true ||
      (isSchema(extra as SchemaOrBool) &&
        Object.keys(extra as object).every((key) => ANNOTATIONS.has(key) || key.startsWith('x-')))
    )
  }

  /** An `anyOf`/`oneOf`: a discriminated union when every branch carries the discriminator. */
  private union(parent: SchemaObject, branches: readonly SchemaObject[], path: string): string {
    const keyword = parent.anyOf !== undefined ? 'anyOf' : 'oneOf'
    const isNullable = branches.some(isNullSchema)
    const rest = branches.filter((branch) => !isNullSchema(branch))
    if (rest.length === 0) {
      return 'z.null()'
    }
    const members = [
      ...new Set(
        rest.map((branch, i) => this.map(this.inherit(parent, branch), `${path}.${keyword}[${i}]`)),
      ),
    ]
    const discriminator = parent['discriminator'] as { propertyName?: unknown } | undefined
    const property = discriminator?.propertyName
    if (
      typeof property === 'string' &&
      rest.length > 1 &&
      rest.every((branch) => this.discriminates(branch, property))
    ) {
      return nullable(
        `z.discriminatedUnion(${stringLiteral(property)}, [${members.join(', ')}])`,
        isNullable,
      )
    }
    return nullable(union(members), isNullable)
  }

  /** Whether a branch maps to a plain object whose `property` is a required literal. */
  private discriminates(branch: SchemaObject, property: string): boolean {
    const resolved =
      typeof branch.$ref === 'string' ? this.schemas[refName(branch.$ref) ?? ''] : branch
    if (
      resolved === undefined ||
      resolved.anyOf !== undefined ||
      resolved.oneOf !== undefined ||
      resolved.allOf !== undefined ||
      !(resolved.required ?? []).includes(property)
    ) {
      return false
    }
    const types = schemaTypes(resolved)
    if (types.length !== 1 || types[0] !== 'object') {
      return false
    }
    const prop = resolved.properties?.[property]
    if (!isSchema(prop)) {
      return false
    }
    return (
      (prop['const'] !== null && isLiteralValue(prop['const'])) ||
      (Array.isArray(prop.enum) && prop.enum.length > 0 && prop.enum.every(isLiteralValue))
    )
  }

  /** A node by its `type`(s): each JSON type's schema, as a union when there are several. */
  private typed(schema: SchemaObject, path: string): string {
    const types = schemaTypes(schema)
    const isNullable = types.includes('null')
    const rest = types.filter((type) => type !== 'null')
    if (rest.length === 0) {
      return isNullable ? 'z.null()' : 'z.unknown()'
    }
    const members = rest.map((type) => this.scalarOrComposite(schema, type, path))
    return nullable(union(members), isNullable)
  }

  private scalarOrComposite(schema: SchemaObject, type: string, path: string): string {
    switch (type) {
      case 'string': {
        return this.string(schema, path)
      }
      case 'number':
      case 'integer': {
        return this.number(schema, type === 'integer')
      }
      case 'boolean': {
        return 'z.boolean()'
      }
      case 'object': {
        return this.object(schema, path)
      }
      case 'array': {
        return this.array(schema, path)
      }
      default: {
        this.warn(`zod: ${path} has an unknown type "${type}"; the schema accepts any value there.`)
        return 'z.unknown()'
      }
    }
  }

  private string(schema: SchemaObject, path: string): string {
    let out = 'z.string()'
    const format = schema.format
    if (typeof format === 'string') {
      const mapped = FORMATS[format]
      if (mapped === undefined) {
        this.warn(
          `zod: ${path} has format "${format}", which has no Zod mapping; the schema skips it.`,
        )
      } else {
        out = mapped
      }
    }
    if (typeof schema['minLength'] === 'number') {
      out += `.min(${schema['minLength']})`
    }
    if (typeof schema['maxLength'] === 'number') {
      out += `.max(${schema['maxLength']})`
    }
    const pattern = schema['pattern']
    if (typeof pattern === 'string') {
      const flags = this.regexFlags(pattern)
      if (flags === undefined) {
        this.warn(
          `zod: ${path} has a pattern JavaScript can't compile (${stringLiteral(pattern)}); the schema skips it.`,
        )
      } else {
        out += `.regex(new RegExp(${stringLiteral(pattern)}${flags === '' ? '' : `, '${flags}'`}))`
      }
    }
    return out
  }

  /** `u` when the pattern compiles as a Unicode regex (as JSON Schema reads it), `''` when only without it. */
  private regexFlags(pattern: string): string | undefined {
    for (const flags of ['u', '']) {
      try {
        return new RegExp(pattern, flags).flags
      } catch {
        // try the next flag set
      }
    }
    return undefined
  }

  private number(schema: SchemaObject, integer: boolean): string {
    let out = integer ? 'z.int()' : 'z.number()'
    const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = schema as Record<
      string,
      unknown
    >
    if (typeof minimum === 'number') {
      out += exclusiveMinimum === true ? `.gt(${minimum})` : `.gte(${minimum})`
    }
    if (typeof exclusiveMinimum === 'number') {
      out += `.gt(${exclusiveMinimum})`
    }
    if (typeof maximum === 'number') {
      out += exclusiveMaximum === true ? `.lt(${maximum})` : `.lte(${maximum})`
    }
    if (typeof exclusiveMaximum === 'number') {
      out += `.lt(${exclusiveMaximum})`
    }
    if (typeof multipleOf === 'number') {
      out += `.multipleOf(${multipleOf})`
    }
    return out
  }

  private object(schema: SchemaObject, path: string): string {
    const extra = schema['additionalProperties'] as SchemaOrBool | undefined
    const open = this.isOpen(extra)
    const catchall =
      !open && extra !== false ? this.map(extra, `${path}.additionalProperties`) : undefined
    const props = schema.properties
    let out: string
    if (props === undefined || Object.keys(props).length === 0) {
      out =
        extra === false
          ? 'z.strictObject({})'
          : `z.record(z.string(), ${catchall ?? 'z.unknown()'})`
    } else {
      const required = new Set(schema.required ?? [])
      const members = Object.entries(props).map(([name, prop]) => {
        return member(name, this.map(prop, `${path}.${name}`), required.has(name))
      })
      const shape = `{ ${members.join(', ')} }`
      out =
        extra === false
          ? `z.strictObject(${shape})`
          : catchall === undefined
            ? `z.looseObject(${shape})`
            : `z.object(${shape}).catchall(${catchall})`
    }
    const { minProperties, maxProperties } = schema as Record<string, unknown>
    if (typeof minProperties === 'number') {
      out += `.refine((value) => Object.keys(value).length >= ${minProperties}, 'Too few properties: expected at least ${minProperties}')`
    }
    if (typeof maxProperties === 'number') {
      out += `.refine((value) => Object.keys(value).length <= ${maxProperties}, 'Too many properties: expected at most ${maxProperties}')`
    }
    return out
  }

  private array(schema: SchemaObject, path: string): string {
    const items = schema.items as SchemaOrBool | readonly SchemaObject[] | undefined
    let item: string
    if (Array.isArray(items)) {
      this.warn(
        `zod: ${path} lists "items" as a tuple, which has no Zod mapping; the schema skips it.`,
      )
      item = 'z.unknown()'
    } else {
      item = this.map(items as SchemaOrBool | undefined, `${path}.items`)
    }
    const { minItems, maxItems, uniqueItems } = schema as Record<string, unknown>
    let out: string
    // A non-empty list is a `[T, ...T[]]` tuple, as the generated TypeScript types it.
    if (typeof minItems === 'number' && minItems >= 1) {
      this.usesNonEmpty = true
      out = `nonEmpty(${item})`
      if (minItems > 1) {
        out += `.check(z.minLength(${minItems}))`
      }
      if (typeof maxItems === 'number') {
        out += `.check(z.maxLength(${maxItems}))`
      }
    } else {
      out = `z.array(${item})`
      if (typeof maxItems === 'number') {
        out += `.max(${maxItems})`
      }
    }
    if (uniqueItems === true) {
      out += UNIQUE_ITEMS
    }
    return out
  }
}

/** A meta or pivot member's value from its descriptor hint and listed values. */
function hintValue(hint: string, values: readonly unknown[] | undefined): string {
  if (values !== undefined && values.length > 0) {
    return hint === 'array' ? `z.array(${literals(values)})` : literals(values)
  }
  switch (hint) {
    case 'integer': {
      return 'z.int()'
    }
    case 'number': {
      return 'z.number()'
    }
    case 'boolean': {
      return 'z.boolean()'
    }
    case 'object': {
      return 'z.record(z.string(), z.unknown())'
    }
    case 'array': {
      return 'z.array(z.unknown())'
    }
    case 'unknown': {
      return 'z.unknown()'
    }
    default: {
      return 'z.string()'
    }
  }
}

/**
 * The object a meta or pivot descriptor describes, as the client types it: each declared field,
 * required when listed (every field when `required` is absent), and the undeclared members an
 * open object takes. Anything else closes the object.
 */
function descriptorObject(descriptor: PivotDescriptor): string {
  const required = new Set(descriptor.required ?? Object.keys(descriptor.fields))
  const nullableFields = new Set(descriptor.nullable ?? [])
  const members = Object.entries(descriptor.fields).map(([name, hint]) => {
    const value = nullable(hintValue(hint, descriptor.values?.[name]), nullableFields.has(name))
    return member(name, value, required.has(name))
  })
  const shape = `{ ${members.join(', ')} }`
  const additional = descriptor.additional
  if (additional === undefined || additional === false) {
    return `z.strictObject(${shape})`
  }
  const extra = nullable(
    hintValue(additional.format, additional.values),
    additional.nullable === true,
  )
  return `z.object(${shape}).catchall(${extra})`
}

const LOOSE_RECORD = 'z.record(z.string(), z.unknown())'

/** The `$pivot` a to-many member may carry, typed as the client's `WritePivotOf`. */
function pivotSchema(relation: RelationDescriptor): string {
  if (relation.writePivot !== undefined) {
    return descriptorObject(relation.writePivot)
  }
  const legacy = relation.pivotFields
  if (legacy !== undefined) {
    const members = Object.entries(legacy).map(
      ([name, hint]) => `${propertyKey(name)}: ${hintValue(hint, undefined)}`,
    )
    return `z.object({ ${members.join(', ')} })`
  }
  return LOOSE_RECORD
}

/**
 * One linkage reference: `{ type, id }` (with optional identifier `meta`) or `{ type, lid }`, one
 * object per related type as the client's ref type distributes over them. A to-many member may
 * carry `$pivot`.
 */
function refSchema(types: readonly string[], pivot: string | undefined): string {
  const extra = pivot === undefined ? '' : `, $pivot: z.exactOptional(${pivot})`
  const members = types.flatMap((related) => {
    const type = `z.literal(${stringLiteral(related)})`
    return [
      `z.object({ type: ${type}, id: z.string(), meta: z.exactOptional(${LOOSE_RECORD})${extra} })`,
      `z.object({ type: ${type}, lid: z.string()${extra} })`,
    ]
  })
  return union(members)
}

type Write = 'create' | 'update'

/**
 * A relation's input slot in write `write`, from its shared ref schema (`undefined` when it relates
 * to no type the document declares): a ref, or `null` unless the write refuses it, to-one; a list
 * of refs to-many, non-empty where the write refuses an empty one. As in the client's types, a
 * relation to no declared type takes only `null` or an empty list.
 */
function relationSlot(relation: RelationDescriptor, ref: string | undefined, write: Write): string {
  const item = ref ?? 'z.never()'
  if (relation.cardinality === 'many') {
    const nonEmpty =
      relation.nonEmptyOn?.includes(write) === true ||
      (write === 'create' && relation.requiredOnCreate === true)
    return nonEmpty ? `nonEmpty(${item})` : `z.array(${item})`
  }
  return relation.nonNullOn?.includes(write) === true
    ? item
    : ref === undefined
      ? 'z.null()'
      : `${ref}.nullable()`
}

/** Whether `slot` calls the module's `nonEmpty` helper. */
const callsNonEmpty = (slot: string): boolean => slot.startsWith('nonEmpty(')

const WRITE_NAME = { create: 'Create', update: 'Update' } as const

/** The schema-name stem of a wire type: its TS identifier stem, camelCased. */
function schemaStem(type: string): string {
  const stem = typeStem(type)
  return stem.charAt(0).toLowerCase() + stem.slice(1)
}

/** The name the create or update input schema of `type` is exported under. */
export function zodSchemaName(type: string, write: 'create' | 'update'): string {
  return `${schemaStem(type)}${WRITE_NAME[write]}Schema`
}

/**
 * Emit Zod v4 schemas for each writable type's flat create and update input, the shape the
 * client's `CreateInput`/`UpdateInput` type: the attributes, one optional slot per relation,
 * `id` per the type's client-id policy on create (and always on a singleton's update), and
 * `$meta`. Every update attribute is optional, as the update attributes component declares.
 *
 * ```ts
 * export const albumsCreateSchema = z.object({ … })
 * export const inputSchemas = { albums: { create: albumsCreateSchema, update: … }, … } as const
 * ```
 */
export function emitZod(
  source: OpenApiDocument,
  descriptor: ApiDescriptor,
  warn: ZodWarn = defaultWarn,
): string {
  const doc = unwrapRefs(source)
  const schemas = doc.components?.schemas ?? {}
  const bases = indexBases(schemas)
  const mapper = new ZodMapper(schemas, warn)
  const known = new Set(Object.keys(descriptor))

  const declarations: string[] = []
  const entries: string[] = []
  let usesNonEmpty = false
  for (const type of Object.keys(descriptor)) {
    const resource = descriptor[type]!
    const components = writeComponents(schemas, bases.get(type))
    const writes = (['create', 'update'] as const).filter(
      (write) => components[write] !== undefined,
    )
    if (writes.length === 0) {
      continue
    }
    // Each relation's ref union, declared once for the type's create and update schemas.
    const refsName = `${schemaStem(type)}Refs`
    const refs: string[] = []
    const refOf = new Map<string, string>()
    for (const [relation, spec] of Object.entries(resource.relations)) {
      const types = spec.types.filter((related) => known.has(related))
      if (types.length > 0) {
        const pivot = spec.cardinality === 'many' ? pivotSchema(spec) : undefined
        refs.push(`  ${propertyKey(relation)}: ${refSchema(types, pivot)},`)
        refOf.set(relation, `${refsName}[${stringLiteral(relation)}]`)
      }
    }
    if (refs.length > 0) {
      declarations.push(`const ${refsName} = {\n${refs.join('\n')}\n}`)
    }

    const pair: string[] = []
    for (const write of writes) {
      const component = components[write]!
      const name = zodSchemaName(type, write)
      const lines: string[] = []
      for (const field of component.fields) {
        const value = mapper.map(component.properties![field], `${name}.${field}`)
        lines.push(member(field, value, component.required.has(field)))
      }
      for (const [relation, spec] of Object.entries(resource.relations)) {
        const slot = relationSlot(spec, refOf.get(relation), write)
        usesNonEmpty ||= callsNonEmpty(slot)
        lines.push(member(relation, slot, write === 'create' && spec.requiredOnCreate === true))
      }
      if (write === 'create') {
        const policy = resource.clientId
        lines.push(
          member('id', policy === 'forbidden' ? 'z.never()' : 'z.string()', policy === 'required'),
        )
      } else if (resource.singleton === true) {
        lines.push('id: z.string()')
      }
      const meta = resource.resourceMeta?.[write]
      lines.push(member('$meta', meta === undefined ? LOOSE_RECORD : descriptorObject(meta), false))
      declarations.push(
        `export const ${name} = z.object({\n${lines.map((line) => `  ${line},`).join('\n')}\n})`,
      )
      pair.push(`${write}: ${name}`)
    }
    entries.push(`  ${propertyKey(type)}: { ${pair.join(', ')} },`)
  }

  const header = [
    '/**',
    ' * AUTO-GENERATED by @haddowg/json-api-codegen — do not edit by hand.',
    " * Zod schemas for each writable type's create and update input; regenerate from the source",
    ' * OpenAPI document. Needs `zod` 4.3 or later installed beside the client.',
    ' *',
    ...provenanceLines(deriveProvenance(source)),
    ' */',
  ].join('\n')
  const map =
    entries.length === 0
      ? 'export const inputSchemas = {} as const'
      : `export const inputSchemas = {\n${entries.join('\n')}\n} as const`
  const helpers = usesNonEmpty || mapper.usesNonEmpty ? [NON_EMPTY] : []
  return `${[header, "import { z } from 'zod'", ...helpers, ...declarations, map].join('\n\n')}\n`
}
