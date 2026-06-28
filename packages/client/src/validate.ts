import { StructuralGuardError } from './errors'
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
 * The opt-in per-resource validator: validate one wire `resource` against its JSON `schema`
 * (the bundle's per-type resource-object schema). The engine is the user's — throw (or
 * aggregate-then-throw) on an invalid resource; return for a valid one. With the bare-function
 * seam form there is no per-type schema, so `schema` is `undefined` and the function owns the
 * whole decision.
 */
export type Validator = (resource: WireResource, schema: unknown) => void

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

/** A normalised validator: resolve a resource's schema (or `undefined`) and validate it. */
export interface ResolvedValidator {
  validate(resource: WireResource): void
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
    return {
      validate(resource) {
        const schema = schemas[resource.type]
        // A type the bundle does not cover is skipped, not failed — partial coverage is allowed.
        if (schema !== undefined) {
          validator(resource, schema)
        }
      },
    }
  }
  return {
    validate(resource) {
      option(resource, undefined)
    },
  }
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
export function validateDocument(body: Document, validator: ResolvedValidator): void {
  const data = body.data
  if (Array.isArray(data)) {
    for (const member of data) {
      validateResourceMember(member, validator)
    }
  } else if (data !== null && data !== undefined) {
    validateResourceMember(data, validator)
  }
  if (body.included !== undefined) {
    // `included` always holds full resource objects.
    for (const member of body.included) {
      validator.validate(member as WireResource)
    }
  }
}

/**
 * Validate a `data` member, but only when it is a full RESOURCE OBJECT. A relationship-linkage
 * endpoint's `data` is bare resource IDENTIFIERS (`type`+`id`[+`meta`], no `attributes`/
 * `relationships`); the per-type schema describes the resource object, so running it over an
 * identifier would spuriously fail. The structural guard already covered the identifier shape.
 */
function validateResourceMember(member: unknown, validator: ResolvedValidator): void {
  if (isObject(member) && ('attributes' in member || 'relationships' in member)) {
    validator.validate(member as WireResource)
  }
}
