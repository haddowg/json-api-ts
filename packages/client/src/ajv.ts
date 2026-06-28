/**
 * @haddowg/json-api-client/ajv — an optional ajv adapter for the validation seam.
 *
 * Turns a user-brought ajv instance + the codegen-emitted `schemas` map into the
 * {@link Validator} the client's `validate?` option accepts, so opting into per-field
 * validation is a few lines:
 *
 * ```ts
 * import Ajv2020 from 'ajv/dist/2020'
 * import { createClient } from '@haddowg/json-api-client'
 * import { createAjvValidator } from '@haddowg/json-api-client/ajv'
 * import { schemas } from './japi.gen' // the codegen's `schemas` constant
 *
 * // The bundle emits the JSON Schema 2020-12 dialect, so use `Ajv2020`. `strict: false`
 * // tolerates the schemas' `x-enum-*` annotations; `allErrors` aggregates every failing field.
 * const ajv = new Ajv2020({ strict: false, allErrors: true })
 * const client = createClient(descriptor, {
 *   baseUrl: 'https://music.example',
 *   validate: createAjvValidator(ajv, schemas),
 * })
 * ```
 *
 * The schemas also carry `format` annotations (`date-time`, `date`, `uuid`, `time`, `uri`). ajv
 * ignores unknown formats by default; to ENFORCE them attach `ajv-formats`
 * (`import addFormats from 'ajv-formats'; addFormats(ajv)`). Note the wire's `time` is a
 * duration-style value the strict `time` format rejects — pass `{ mode: 'fast' }` or omit `time`
 * if you hit that, since formats are advisory and the client's posture is to validate structure
 * and types, trusting the wire on format minutiae.
 *
 * `ajv` is an OPTIONAL peer dependency of this package — it is imported here as a TYPE
 * only (`import type`), so the engine is brought by the caller and never enters the core
 * client's runtime dependency tree. This module is its own sub-path export
 * (`@haddowg/json-api-client/ajv`); importing the main entry never pulls ajv in.
 */
import type { ErrorObject, ValidateFunction } from 'ajv'
import type { SchemaMap, Validator, WireResource } from './validate'

/**
 * The minimal ajv surface the adapter uses: `compile(schema)` -> a validate function. Any
 * ajv-core instance satisfies it — typically `new Ajv2020()` (the JSON Schema 2020-12 dialect
 * the bundle emits), but a base `Ajv` with the 2020 meta-schema added works too. Typed
 * structurally so the adapter binds to the capability, not a specific ajv subclass.
 */
export interface AjvLike {
  compile(schema: unknown): ValidateFunction
}

/** One failing field: the resource it came from plus ajv's pointer, keyword, and message. */
export interface AjvValidationFailure {
  /** The JSON:API type of the resource that failed (`schemas[type]` was applied). */
  type: string
  /** The resource id, when present (a bare identifier or a full resource object both carry one). */
  id?: string
  /** ajv's `instancePath` into the resource (e.g. `/attributes/title`); empty string for the root. */
  pointer: string
  /** The failing ajv keyword (e.g. `type`, `maxLength`, `enum`). */
  keyword: string
  /** ajv's human-readable message (e.g. `must be string`). */
  message: string
}

/**
 * Thrown by the ajv adapter when a wire resource fails its per-type schema. Aggregates every
 * ajv error into {@link AjvValidationFailure}s (one per failing field) and renders a message
 * listing the failing pointers, so a caller can both read the summary and walk `failures`.
 */
export class AjvValidationError extends Error {
  /** Every failing field across the resource (ajv runs with `allErrors`-aware reporting if enabled). */
  readonly failures: readonly AjvValidationFailure[]
  /** The JSON:API type of the resource that failed. */
  readonly type: string
  /** The id of the resource that failed, when present. */
  readonly resourceId?: string

  constructor(type: string, id: string | undefined, failures: readonly AjvValidationFailure[]) {
    const at = id === undefined ? type : `${type}:${id}`
    const pointers = failures.map((f) => `${f.pointer || '/'} ${f.message}`).join('; ')
    super(`Resource ${at} failed schema validation: ${pointers}`)
    this.name = 'AjvValidationError'
    this.type = type
    if (id !== undefined) {
      this.resourceId = id
    }
    this.failures = failures
  }
}

/** Map ajv's raw `ErrorObject`s for one resource to the adapter's typed failures. */
function toFailures(
  type: string,
  id: string | undefined,
  errors: ErrorObject[],
): AjvValidationFailure[] {
  return errors.map((e) => {
    const failure: AjvValidationFailure = {
      type,
      pointer: e.instancePath,
      keyword: e.keyword,
      message: e.message ?? 'is invalid',
    }
    if (id !== undefined) {
      failure.id = id
    }
    return failure
  })
}

/**
 * Build the client's {@link Validator} from a user-brought ajv instance and the codegen's per-type
 * `schemas` map. Each schema is compiled ONCE up front (keyed by JSON:API type) with the instance's
 * configured dialect — pass `new Ajv2020()` for the 2020-12 dialect the bundle emits. The returned
 * function is the bare-`Validator` seam form: it looks the compiled validator up by `resource.type`,
 * skips a type the bundle does not cover (graceful partial coverage), and on a failing resource
 * throws an aggregated {@link AjvValidationError} listing the failing pointers.
 *
 * @param ajv   A configured ajv instance ({@link AjvLike}) — typically `new Ajv2020({ allErrors: true })`.
 * @param schemas The codegen-emitted `schemas` map (type -> resource-object JSON Schema 2020-12 doc).
 */
export function createAjvValidator(ajv: AjvLike, schemas: SchemaMap): Validator {
  // Compile every per-type schema once, keyed by type. ajv key-collision (a duplicate `$id`) is the
  // engine's concern; we compile each schema independently so one bad type does not block the rest.
  const compiled = new Map<string, ValidateFunction>()
  for (const [type, schema] of Object.entries(schemas)) {
    compiled.set(type, ajv.compile(schema))
  }

  // The bare-`Validator` seam form: `(resource, schema) => void`. The adapter owns its own compiled
  // lookup (by `resource.type`), so the seam's `schema` argument is unused (the runtime passes
  // `undefined` for a bare validator); it is accepted only to satisfy the {@link Validator} signature.
  const validator: Validator = (resource: WireResource): void => {
    // Read `type`/`id` up front: ajv's `ValidateFunction` is a type guard, so calling it narrows
    // `resource` in the failing branch and the props would no longer be reachable off it.
    const { type, id } = resource
    const validate = compiled.get(type)
    // A type the bundle does not cover is skipped, not failed — matches the seam's graceful posture.
    if (validate === undefined) {
      return
    }
    if (!validate(resource)) {
      const errors = validate.errors ?? []
      throw new AjvValidationError(type, id, toFailures(type, id, errors))
    }
  }
  return validator
}
