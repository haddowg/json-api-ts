import { type CodesOf, errorText, type JsonApiErrorOf } from './error-shared'
import { JsonApiError, type JsonApiErrorObject } from './errors'
import { joinInputPath, splitInputPath } from './input-path'
import { InputValidationError, type StandardSchemaIssue } from './input-validation'

/** One segment of a Standard Schema issue path: a key, or an array index. */
export type PathSegment = string | number

/**
 * One error shaped as a Standard Schema issue (`message` plus `path` segments), so a form library
 * that takes Standard Schema issues takes it as is.
 */
export interface FieldError<C extends string = string> {
  /** The error's `detail`, else its `title`, else its `code`. */
  readonly message: string
  /** The input path as segments: `orderedTracks[0].$pivot.position` is `['orderedTracks', 0, '$pivot', 'position']`. Empty for a form-level error. */
  readonly path: readonly PathSegment[]
  /** The input path as the runtime keys it, `''` for a form-level error. */
  readonly key: string
  readonly code?: C | (string & {})
  /** The failing operation's index in an atomic batch. */
  readonly opIndex?: number
  /** The error object as the server sent it, with its remapped `path`. Absent for an {@link InputValidationError}'s issue. */
  readonly error?: JsonApiErrorObject<C>
}

/** A write's errors for a form, split into the inputs they point at and the rest. */
export interface FieldErrors<I = unknown, C extends string = string> {
  /** Errors on an input, grouped by its path. */
  readonly fields: Readonly<Record<string, readonly FieldError<C>[]>>
  /** Errors that point at no input: no `source`, a `source.parameter` or `source.header`, or a pointer the client owns, such as `/data/type`. */
  readonly form: readonly FieldError<C>[]
  /** Every error, in the order the server sent them. */
  readonly issues: readonly FieldError<C>[]
  /** The first message on the input at `path`. */
  first(path: InputPath<I>): string | undefined
  /** Every message on the input at `path`. */
  messages(path: InputPath<I>): string[]
  /** Only the errors of the atomic operation at `index`. */
  op(index: number): FieldErrors<unknown, C>
}

declare const writeInput: unique symbol

/**
 * A {@link JsonApiError} tagged with the input of the write that raised it, at the type level
 * only, so {@link fieldErrors} types its paths without a type argument.
 */
export type WriteError<C extends string = string, I = unknown> = JsonApiError<C> & {
  readonly [writeInput]?: I
}

type InputOf<E> = [JsonApiErrorOf<E>] extends [never]
  ? unknown
  : JsonApiErrorOf<E> extends { readonly [writeInput]?: infer I }
    ? I
    : unknown

type Scalar = string | number | boolean | bigint | symbol | Date

/** The next depth down; the paths stop at four levels of nesting. */
type Deeper = [never, 0, 1, 2, 3]

/**
 * Every path the runtime can key an error on for write input `I`: attribute keys, nested map
 * keys joined with `.`, to-many members as `[n]` with their `$pivot` fields, `$meta` members, and
 * `$documentMeta` members. A union-typed value contributes only the keys its members share. Any
 * string when `I` is unknown.
 */
export type InputPath<I> = unknown extends I ? string : KeyPaths<I, 4> | `$documentMeta.${string}`

type KeyPaths<T, D extends number> = [D] extends [never]
  ? never
  : [T] extends [object]
    ? { [K in keyof T & string]-?: K | `${K}${SubPaths<NonNullable<T[K]>, D>}` }[keyof T & string]
    : never

type SubPaths<V, D extends number> = [V] extends [never]
  ? never
  : [V] extends [readonly (infer M)[]]
    ? `[${number}]` | `[${number}]${MemberPaths<NonNullable<M>, D>}`
    : MemberPaths<V, D>

// A linkage ref (it has `type`) contributes only its `$pivot` fields.
type MemberPaths<V, D extends number> = [V] extends [Scalar]
  ? never
  : 'type' extends keyof V
    ? [V] extends [{ $pivot?: infer P }]
      ? P extends object
        ? '.$pivot' | `.$pivot.${keyof P & string}`
        : never
      : never
    : `.${KeyPaths<V, Deeper[D]>}`

/**
 * The 4xx `error`'s errors keyed by the write input they point at, or `undefined` when `error`
 * is not a 4xx {@link JsonApiError} or none of its errors points at an input. An
 * {@link InputValidationError} gives its issues the same way. Pass the input type when `error`
 * carries none: `fieldErrors<Parameters<typeof client.albums.create>[0]>(caught)`.
 */
export function fieldErrors<I = never, E = unknown>(
  error: E,
): FieldErrors<[I] extends [never] ? InputOf<E> : I, CodesOf<E>> | undefined
export function fieldErrors(error: unknown): FieldErrors | undefined {
  if (error instanceof InputValidationError) {
    return group(error.issues.map((issue) => fromIssue(issue, error.opIndex)))
  }
  if (!(error instanceof JsonApiError) || !error.is4xx()) {
    return undefined
  }
  const issues = error.errors.map(toFieldError)
  return issues.some((issue) => issue.key !== '') ? group(issues) : undefined
}

function group<C extends string>(issues: readonly FieldError<C>[]): FieldErrors<unknown, C> {
  const fields: Record<string, FieldError<C>[]> = {}
  const form: FieldError<C>[] = []
  for (const issue of issues) {
    if (issue.key === '') {
      form.push(issue)
    } else {
      ;(fields[issue.key] ??= []).push(issue)
    }
  }
  return {
    fields,
    form,
    issues,
    first: (path) => fields[path]?.[0]?.message,
    messages: (path) => fields[path]?.map((issue) => issue.message) ?? [],
    op: (index) => group(issues.filter((issue) => issue.opIndex === index)),
  }
}

function toFieldError<C extends string>(error: JsonApiErrorObject<C>): FieldError<C> {
  // The runtime leaves a pointer it can't map to an input verbatim, so it still starts with `/`.
  const key = error.path === undefined || error.path.startsWith('/') ? '' : error.path
  return {
    message: errorText(error, true) ?? 'Invalid',
    path: splitInputPath(key),
    key,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.opIndex === undefined ? {} : { opIndex: error.opIndex }),
    error,
  }
}

function fromIssue(issue: StandardSchemaIssue, opIndex: number | undefined): FieldError {
  const path = (issue.path ?? []).map((segment) => {
    const key = typeof segment === 'object' ? segment.key : segment
    return typeof key === 'number' ? key : String(key)
  })
  const key = joinInputPath(path)
  return { message: issue.message, path, key, ...(opIndex === undefined ? {} : { opIndex }) }
}
