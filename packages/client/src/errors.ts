/** A single JSON:API error object (spec: error objects). */
export interface JsonApiErrorObject {
  id?: string
  status?: string
  code?: string
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
}

/**
 * Thrown for any non-2xx JSON:API response. Carries the parsed error document plus
 * expressive status matchers and pointer-grouping helpers.
 */
export class JsonApiError extends Error {
  readonly status: number
  readonly errors: JsonApiErrorObject[]

  constructor(status: number, errors: JsonApiErrorObject[], message?: string) {
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
  byPath(): Record<string, JsonApiErrorObject[]> {
    const out: Record<string, JsonApiErrorObject[]> = {}
    for (const e of this.errors) {
      const key = e.path ?? e.source?.pointer ?? e.source?.parameter ?? '_'
      ;(out[key] ??= []).push(e)
    }
    return out
  }
}
