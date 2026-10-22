/**
 * A single JSON:API error object (spec: error objects).
 *
 * `C` is the server's documented error-code union (a generated client's `ErrorCode`). `code` is
 * typed `C | (string & {})`: editors suggest the documented codes, yet any other string still
 * fits, because the catalogue is open and a server may send a code it never documented.
 */
export interface JsonApiErrorObject<C extends string = string> {
  id?: string
  status?: string
  code?: C | (string & {})
  title?: string
  detail?: string
  source?: { pointer?: string; parameter?: string; header?: string }
  meta?: Record<string, unknown>
  /**
   * The user-facing input path, remapped from `source.pointer` for write errors
   * (e.g. `/data/attributes/title` -> `title`). Populated by the runtime, which
   * built the envelope and therefore knows the inverse mapping. See CONTEXT.md.
   */
  path?: string
  /**
   * The zero-based index of the failing operation within an atomic batch, parsed from a
   * `source.pointer` carrying an `/atomic:operations/{n}` prefix. Populated only for atomic
   * errors; `path` then holds the flat path within that operation's input.
   */
  opIndex?: number
}

/**
 * Thrown by the always-on light structural guards (ADR 0004) when a parsed response is not a
 * JSON:API document, or a `data`/`included` member is not a resource object carrying `type`+`id`.
 * Distinct from {@link JsonApiError} (a non-2xx server response): this signals the wire shape the
 * runtime relies on was violated, not an application error the server reported. The opt-in
 * per-field validator throws its engine's own error type, never this one.
 */
export class StructuralGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StructuralGuardError'
  }
}

/**
 * Thrown for any non-2xx JSON:API response. Carries the parsed error document plus
 * expressive status matchers and pointer-grouping helpers.
 *
 * `C` types each error object's `code` (see {@link JsonApiErrorObject}). It is a compile-time
 * hint only: the runtime never checks a code against it.
 */
export class JsonApiError<C extends string = string> extends Error {
  readonly status: number
  readonly errors: JsonApiErrorObject<C>[]

  constructor(status: number, errors: JsonApiErrorObject<C>[], message?: string) {
    super(message ?? `JSON:API request failed with status ${status}`)
    this.name = 'JsonApiError'
    this.status = status
    this.errors = errors
  }

  hasStatus(status: number): boolean {
    return this.status === status
  }

  is4xx(): boolean {
    return this.status >= 400 && this.status < 500
  }

  is5xx(): boolean {
    return this.status >= 500 && this.status < 600
  }

  isBadRequest(): boolean {
    return this.status === 400
  }

  isUnauthorized(): boolean {
    return this.status === 401
  }

  isForbidden(): boolean {
    return this.status === 403
  }

  isNotFound(): boolean {
    return this.status === 404
  }

  isNotAcceptable(): boolean {
    return this.status === 406
  }

  isConflict(): boolean {
    return this.status === 409
  }

  isUnsupportedMediaType(): boolean {
    return this.status === 415
  }

  isUnprocessable(): boolean {
    return this.status === 422
  }

  /** Alias of {@link isUnprocessable} — the JSON:API validation status. */
  isValidationError(): boolean {
    return this.status === 422
  }

  isRateLimited(): boolean {
    return this.status === 429
  }

  /**
   * Group errors by user-facing input path (falls back to the raw pointer, then the
   * query parameter). The payoff for form/validation UX — 422 `source.pointer`s are
   * remapped to the flat shape the caller actually supplied.
   */
  byPath(): Record<string, JsonApiErrorObject<C>[]> {
    const out: Record<string, JsonApiErrorObject<C>[]> = {}
    for (const e of this.errors) {
      const key = e.path ?? e.source?.pointer ?? e.source?.parameter ?? '_'
      ;(out[key] ??= []).push(e)
    }
    return out
  }
}

/**
 * True when `err` is a {@link JsonApiError} and any of its error objects carries `code`. Takes
 * any string, so it also matches codes the server never documented. A generated client exports a
 * `hasErrorCode` bound to its server's `ErrorCode` union, which rejects a misspelt code at
 * compile time; reach for this one only to match an undocumented code.
 */
export function hasErrorCode(err: unknown, code: string): err is JsonApiError {
  return err instanceof JsonApiError && err.errors.some((e) => e.code === code)
}

/**
 * {@link hasErrorCode} restricted to one server's documented codes. A generated client binds it:
 * `export const hasErrorCode = hasErrorCodeRuntime as ErrorCodeGuard<ErrorCode>`. The cast is
 * needed because `JsonApiError<string>` doesn't assign to `JsonApiError<ErrorCode>`.
 */
export type ErrorCodeGuard<C extends string> = (err: unknown, code: C) => err is JsonApiError<C>
