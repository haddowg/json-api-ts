import { StructuralGuardError } from './errors'
import { keySelection } from './key-selection'
import type { Document } from './request'

/**
 * A wire resource as it appears in a document's `data`/`included` — a JSON:API resource
 * object (or bare identifier). The structural guards assert `type` (and, where required,
 * `id`); the opt-in validator sees the whole object to check the rest against its schema.
 */
export interface WireResource {
  type: string
  id?: string
  [key: string]: unknown
}

/**
 * What the request a resource answered tells a validator. `fields` is the sparse fieldset the
 * request sent for the resource's type, `fields[type]`, absent when it sent none.
 */
export interface ValidationContext {
  readonly fields?: readonly string[]
}

/**
 * The opt-in per-resource validator: validate one wire `resource` against its JSON `schema`
 * (the bundle's per-type resource-object schema). The engine is the user's — throw (or
 * aggregate-then-throw) on an invalid resource; return for a valid one. With the bare-function
 * seam form there is no per-type schema, so `schema` is `undefined` and the function owns the
 * whole decision. With the schema-driven form, `schema` is already relaxed for the request's
 * sparse fieldset (see {@link sparseSchema}). `context` carries that fieldset either way, so a
 * bare validator can relax its own schema.
 */
export type Validator = (
  resource: WireResource,
  schema: unknown,
  context?: ValidationContext,
) => void

/** A per-type JSON Schema map (the codegen-emitted `schemas` constant), keyed by JSON:API type. */
export type SchemaMap = Readonly<Record<string, unknown>>

/**
 * The schema-driven validation seam: a per-type `schemas` map plus a `validator` engine. Each
 * wire resource is validated against `schemas[resource.type]`; a type with no schema is skipped.
 */
export interface ValidationConfig {
  schemas: SchemaMap
  validator: Validator
}

/**
 * The `validate?` option on {@link ClientOptions}: either the schema-driven {@link ValidationConfig}
 * (the common case — the codegen-emitted `schemas` map + an engine adapter) or a bare
 * {@link Validator} that owns schema lookup itself (it is called per resource with `schema` =
 * `undefined`). Absent => no per-field validation (zero overhead, no engine dependency).
 */
export type ValidationOption = ValidationConfig | Validator

/**
 * A normalised validator: resolve a resource's schema (or `undefined`) and validate it. `fields`
 * is the request's sparse fieldset for the resource's type, when it sent one.
 */
export interface ResolvedValidator {
  validate(resource: WireResource, fields?: readonly string[]): void
}

/** Whether a `validate` option is the schema-driven config (vs a bare validator function). */
function isConfig(option: ValidationOption): option is ValidationConfig {
  return typeof option === 'object' && option !== null && !Array.isArray(option)
}

/**
 * Normalise the `validate?` option to a single per-resource validator. The config form looks the
 * schema up by `resource.type` and skips a type with no schema (the seam stays graceful for a
 * partially-covered bundle); the bare-function form calls the validator with `schema = undefined`,
 * delegating the whole decision to the caller. Returns `undefined` when validation is off.
 */
export function resolveValidator(
  option: ValidationOption | undefined,
): ResolvedValidator | undefined {
  if (option === undefined) {
    return undefined
  }
  if (isConfig(option)) {
    const { schemas, validator } = option
    const sparse = sparseSchemas()
    return {
      validate(resource, fields) {
        const schema = schemas[resource.type]
        // A type the bundle does not cover is skipped, not failed — partial coverage is allowed.
        if (schema === undefined) {
          return
        }
        if (fields === undefined) {
          validator(resource, schema)
        } else {
          validator(resource, sparse(schema, fields), { fields })
        }
      },
    }
  }
  return {
    validate(resource, fields) {
      if (fields === undefined) {
        option(resource, undefined)
      } else {
        option(resource, undefined, { fields })
      }
    },
  }
}

/**
 * A cache of {@link sparseSchema} results, by schema and fieldset, so each pair is relaxed once.
 * A schema with no fieldset comes back as it is.
 */
export function sparseSchemas(): (
  schema: unknown,
  fields: readonly string[] | undefined,
) => unknown {
  const cache = new WeakMap<object, Map<string, unknown>>()
  return (schema, fields) => {
    if (fields === undefined || !isObject(schema)) {
      return schema
    }
    let bySet = cache.get(schema)
    if (bySet === undefined) {
      bySet = new Map()
      cache.set(schema, bySet)
    }
    const key = fields.join(',')
    if (!bySet.has(key)) {
      bySet.set(key, sparseSchema(schema, fields))
    }
    return bySet.get(key)
  }
}

/**
 * The members one object level of a sparse fieldset selects: `keep`, the keys it renders, and
 * `children`, the keys it narrows further, a list's items under `*`.
 */
interface Narrowing {
  keep: ReadonlySet<string>
  children: ReadonlyMap<string, Narrowing>
}

/** The {@link Narrowing} of key paths relative to one level, such as `b`, `c.d` or `*.sku`. */
function narrowingOf(paths: readonly string[]): Narrowing {
  const keep = new Set<string>()
  const whole = new Set<string>()
  const deeper = new Map<string, string[]>()
  for (const path of paths) {
    const dot = path.indexOf('.')
    const head = dot < 0 ? path : path.slice(0, dot)
    keep.add(head)
    if (dot < 0) {
      whole.add(head)
    } else {
      const rest = deeper.get(head) ?? []
      rest.push(path.slice(dot + 1))
      deeper.set(head, rest)
    }
  }
  const children = new Map<string, Narrowing>()
  for (const [head, rest] of deeper) {
    if (!whole.has(head)) {
      children.set(head, narrowingOf(rest))
    }
  }
  return { keep, children }
}

/**
 * One {@link Narrowing} for a schema several keys share, such as a map's `additionalProperties`:
 * a key stays required only when every sharer renders it, and a key one sharer narrows is narrowed.
 */
function merged(narrowings: readonly Narrowing[]): Narrowing {
  if (narrowings.length === 1) {
    return narrowings[0]!
  }
  const keep = new Set(
    [...narrowings[0]!.keep].filter((key) => narrowings.every((n) => n.keep.has(key))),
  )
  const grouped = new Map<string, Narrowing[]>()
  for (const narrowing of narrowings) {
    for (const [key, child] of narrowing.children) {
      grouped.set(key, [...(grouped.get(key) ?? []), child])
    }
  }
  const children = new Map<string, Narrowing>()
  for (const [key, group] of grouped) {
    children.set(key, merged(group))
  }
  return { keep, children }
}

/** The schema a local `$ref` such as `#/$defs/Address` points at within `root`. */
function resolveRef(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith('#')) {
    return undefined
  }
  let node: unknown = root
  for (const raw of ref.slice(1).split('/').slice(1)) {
    const segment = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~')
    node = isObject(node) ? node[segment] : undefined
  }
  return node
}

/** `schema` with `narrowing` applied: its `required` cut to what the level renders, its narrowed keys relaxed in turn. */
function narrowed(
  root: Record<string, unknown>,
  schema: unknown,
  narrowing: Narrowing,
  depth = 0,
): unknown {
  if (!isObject(schema) || depth > 64) {
    return schema
  }
  if (typeof schema['$ref'] === 'string') {
    const { $ref: ref, ...siblings } = schema
    const target = resolveRef(root, ref as string)
    if (isObject(target)) {
      return narrowed(root, { ...target, ...siblings }, narrowing, depth + 1)
    }
  }
  const out: Record<string, unknown> = { ...schema }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = out[key]
    if (Array.isArray(branches)) {
      out[key] = branches.map((branch) => narrowed(root, branch, narrowing, depth + 1))
    }
  }
  const required = out['required']
  if (Array.isArray(required)) {
    out['required'] = required.filter((key) => typeof key === 'string' && narrowing.keep.has(key))
  }
  const properties = isObject(out['properties']) ? { ...out['properties'] } : undefined
  const patterns = isObject(out['patternProperties']) ? out['patternProperties'] : undefined
  const shared = new Map<string, Narrowing[]>()
  const share = (target: string, child: Narrowing): void => {
    shared.set(target, [...(shared.get(target) ?? []), child])
  }
  for (const [key, child] of narrowing.children) {
    if (key === '*') {
      if (isObject(out['items'])) {
        out['items'] = narrowed(root, out['items'], child, depth + 1)
      }
      continue
    }
    if (properties !== undefined && key in properties) {
      properties[key] = narrowed(root, properties[key], child, depth + 1)
      continue
    }
    const matching = Object.keys(patterns ?? {}).filter((pattern) => matches(pattern, key))
    if (matching.length > 0) {
      matching.forEach((pattern) => share(`pattern:${pattern}`, child))
    } else if (isObject(out['additionalProperties'])) {
      share('additional', child)
    }
  }
  if (properties !== undefined) {
    out['properties'] = properties
  }
  if (patterns !== undefined) {
    const next = { ...patterns }
    for (const pattern of Object.keys(patterns)) {
      const group = shared.get(`pattern:${pattern}`)
      if (group !== undefined) {
        next[pattern] = narrowed(root, patterns[pattern], merged(group), depth + 1)
      }
    }
    out['patternProperties'] = next
  }
  const additional = shared.get('additional')
  if (additional !== undefined) {
    out['additionalProperties'] = narrowed(
      root,
      out['additionalProperties'],
      merged(additional),
      depth + 1,
    )
  }
  return out
}

/** Whether a `patternProperties` pattern matches `key`; an unreadable pattern matches nothing. */
function matches(pattern: string, key: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(key)
  } catch {
    return false
  }
}

/**
 * A resource object schema relaxed for a response to a request whose sparse fieldset for the type
 * named `members`. An attribute or relation the fieldset leaves out is no longer required, and an
 * attribute it narrows to some of its keys, such as `address.city`, `location.geo.lat` or
 * `lines.*.sku`, requires only the keys selected at each level along those paths. A member the
 * fieldset also lists whole is left as declared, as the server renders it whole. Everything else
 * in the schema is kept, so a selected value is still checked, but for its `$id`: the copy is a
 * schema of its own.
 */
export function sparseSchema(schema: unknown, members: readonly string[]): unknown {
  if (!isObject(schema)) {
    return schema
  }
  const selection = keySelection(members)
  const selected = new Set([
    ...members.filter((member) => member !== '' && !member.includes('.')),
    ...Object.keys(selection),
  ])
  const children = new Map<string, Narrowing>()
  for (const [attribute, paths] of Object.entries(selection)) {
    children.set(attribute, narrowingOf(paths))
  }
  // The resource object keeps its own required members, but `attributes` and `relationships`
  // may be left out when the fieldset empties them.
  const required = Array.isArray(schema['required']) ? (schema['required'] as unknown[]) : []
  const out = narrowed(schema, schema, {
    keep: new Set(
      required.filter(
        (key): key is string =>
          typeof key === 'string' && key !== 'attributes' && key !== 'relationships',
      ),
    ),
    children: new Map([
      ['attributes', { keep: selected, children }],
      ['relationships', { keep: selected, children: new Map() }],
    ]),
  }) as Record<string, unknown>
  // An engine keying schemas by `$id` can then hold the copy beside the whole schema.
  delete out['$id']
  return out
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The light structural guards every parsed response passes through (ADR 0004): assert the body
 * is a JSON:API document and that each `data`/`included` member carries a string `type` (and,
 * for a full resource, an `id`). This is the always-on, engine-free floor — it never duplicates
 * the opt-in per-field validation; it only proves the envelope invariant the runtime relies on.
 *
 * A primary-`data` resource and every `included` resource must carry `type`+`id`. A relationship
 * endpoint's primary data is pure resource-identifier linkage, which also carries `type`+`id`, so
 * the same guard holds; `linkage` is accepted for symmetry with the materialiser but the assertion
 * is identical (an identifier is `type`+`id`). `data: null` (an empty to-one) and a missing
 * `data` (a meta-only document) are valid and pass.
 */
export function assertJsonApiDocument(body: unknown): asserts body is Document {
  if (!isObject(body)) {
    throw new StructuralGuardError('Response body is not a JSON:API document (expected an object)')
  }
  // A JSON:API document must carry at least one of `data`, `errors`, or `meta`. An error
  // document never reaches here (a non-2xx throws a JsonApiError upstream), so the guard
  // requires a `data` or `meta` top-level member.
  if (!('data' in body) && !('meta' in body)) {
    throw new StructuralGuardError(
      'Response body is not a JSON:API document (missing top-level "data" or "meta")',
    )
  }
  const data = body['data']
  if (Array.isArray(data)) {
    data.forEach((member, i) => assertResource(member, `data[${i}]`))
  } else if (data !== null && data !== undefined) {
    assertResource(data, 'data')
  }
  const included = body['included']
  if (included !== undefined) {
    if (!Array.isArray(included)) {
      throw new StructuralGuardError('Response "included" is not an array')
    }
    included.forEach((member, i) => assertResource(member, `included[${i}]`))
  }
}

/** Assert a single member is a resource object/identifier carrying string `type` + `id`. */
function assertResource(member: unknown, at: string): void {
  if (!isObject(member)) {
    throw new StructuralGuardError(`${at} is not a JSON:API resource object`)
  }
  if (typeof member['type'] !== 'string') {
    throw new StructuralGuardError(`${at} is missing a string "type"`)
  }
  if (typeof member['id'] !== 'string') {
    throw new StructuralGuardError(`${at} (type "${member['type']}") is missing a string "id"`)
  }
}

/**
 * Run the opt-in validator over every wire resource in a document's `data` + `included`, each
 * against its per-type schema. Called only when a validator is configured (off by default). The
 * structural guards have already proven each member carries `type`+`id`, so the cast is sound.
 */
export function validateDocument(
  body: Document,
  validator: ResolvedValidator,
  fields?: Readonly<Record<string, readonly string[]>>,
): void {
  const data = body.data
  if (Array.isArray(data)) {
    for (const member of data) {
      validateResourceMember(member, validator, fields)
    }
  } else if (data !== null && data !== undefined) {
    validateResourceMember(data, validator, fields)
  }
  if (body.included !== undefined) {
    // `included` always holds full resource objects.
    for (const member of body.included) {
      const resource = member as WireResource
      validator.validate(resource, fields?.[resource.type])
    }
  }
}

/**
 * Validate a `data` member, but only when it is a full RESOURCE OBJECT. A relationship-linkage
 * endpoint's `data` is bare resource IDENTIFIERS (`type`+`id`[+`meta`], no `attributes`/
 * `relationships`); the per-type schema describes the resource object, so running it over an
 * identifier would spuriously fail. The structural guard already covered the identifier shape.
 */
function validateResourceMember(
  member: unknown,
  validator: ResolvedValidator,
  fields: Readonly<Record<string, readonly string[]>> | undefined,
): void {
  if (isObject(member) && ('attributes' in member || 'relationships' in member)) {
    const resource = member as WireResource
    validator.validate(resource, fields?.[resource.type])
  }
}
