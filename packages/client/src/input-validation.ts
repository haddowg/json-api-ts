/**
 * The parts of the Standard Schema interface (standardschema.dev) the client calls. Zod, Valibot
 * and ArkType schemas implement it.
 */
export interface StandardSchema<Input = unknown> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => StandardSchemaResult | Promise<StandardSchemaResult>
    readonly types?: { readonly input: Input } | undefined
  }
}

/** What a Standard Schema's `validate` returns. */
export type StandardSchemaResult =
  | { readonly value: unknown; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaIssue[] }

/** One problem a Standard Schema found. */
export interface StandardSchemaIssue {
  readonly message: string
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined
}

/**
 * The schemas `createClient({ validateInput })` checks a write's input against before sending it,
 * by wire type: `{ albums: { create: albumsCreateSchema, update: albumsUpdateSchema } }`. A type or
 * a write with no schema is sent unchecked. `json-api-codegen --zod` generates this map.
 */
export type InputSchemas = Readonly<
  Record<string, { readonly create?: StandardSchema; readonly update?: StandardSchema }>
>

/**
 * Thrown by a create or update whose input fails the schema `validateInput` holds for it, before
 * any request is sent. `fieldErrors(error)` takes it as it takes a server's 422.
 */
export class InputValidationError extends Error {
  readonly type: string
  readonly operation: 'create' | 'update'
  readonly issues: readonly StandardSchemaIssue[]
  /** The failing operation's index in an atomic batch. */
  readonly opIndex?: number

  constructor(
    type: string,
    operation: 'create' | 'update',
    issues: readonly StandardSchemaIssue[],
    opIndex?: number,
  ) {
    const first = issues[0]?.message
    super(
      `The ${type} ${operation} input${opIndex === undefined ? '' : ` of atomic operation ${opIndex}`} is invalid` +
        (first === undefined ? '' : `: ${first}`) +
        (issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''),
    )
    this.name = 'InputValidationError'
    this.type = type
    this.operation = operation
    this.issues = issues
    if (opIndex !== undefined) {
      this.opIndex = opIndex
    }
  }
}

/** One write's input, as `validateInput` checks it. */
export interface InputCheck {
  readonly type: string
  readonly operation: 'create' | 'update'
  readonly input: unknown
  readonly opIndex?: number
}

/**
 * The {@link InputValidationError} `check`'s input fails its schema in `schemas` with, or
 * `undefined` when it passes or has no schema. A Promise only for a schema that validates
 * asynchronously.
 */
export function inputFailure(
  schemas: InputSchemas | undefined,
  check: InputCheck,
): InputValidationError | undefined | Promise<InputValidationError | undefined> {
  const schema = schemas?.[check.type]?.[check.operation]
  if (schema === undefined) {
    return undefined
  }
  const failure = (result: StandardSchemaResult) =>
    result.issues === undefined
      ? undefined
      : new InputValidationError(check.type, check.operation, result.issues, check.opIndex)
  const result = schema['~standard'].validate(check.input)
  return result instanceof Promise ? result.then(failure) : failure(result)
}

/**
 * Run `write` once `check`'s input passes its schema, else reject with the
 * {@link InputValidationError}. A write with no schema, or a schema that validates synchronously,
 * starts in this tick.
 */
export function withInputCheck<T>(
  schemas: InputSchemas | undefined,
  check: InputCheck,
  write: () => Promise<T>,
): Promise<T> {
  const proceed = (failure: InputValidationError | undefined): Promise<T> =>
    failure === undefined ? write() : Promise.reject(failure)
  const failure = inputFailure(schemas, check)
  return failure instanceof Promise ? failure.then(proceed) : proceed(failure)
}
