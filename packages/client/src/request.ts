import type { HeadersInit } from './client'
import { JsonApiError, type JsonApiErrorObject } from './errors'
import type { JsonApiTransport, TransportRequest } from './transport'
import { mediaType } from './types'

/**
 * A read query, in the flat shape the fluent surface accepts. Serialised to the
 * JSON:API bracketed query-parameter families by {@link serializeQuery}.
 */
export interface ReadQuery {
  filter?: Record<string, unknown>
  sort?: string | string[]
  include?: string[]
  fields?: Record<string, string[]>
  /** Relationship-count tokens (the Countable profile) — serialised comma-joined onto `withCount`. */
  withCount?: readonly string[]
  page?: Record<string, unknown>
}

/** A loose JSON:API document — enough structure for the runtime to materialise. */
export interface Document {
  data?: unknown
  included?: unknown[]
  links?: Record<string, unknown>
  meta?: Record<string, unknown>
  jsonapi?: Record<string, unknown>
}

/** The ambient context a request executes in (carried by the client). */
export interface JsonApiContext {
  baseUrl: string
  transport: JsonApiTransport
  headers?: () => HeadersInit | Promise<HeadersInit>
}

/** A single read/write request, before serialisation. */
export interface JsonApiRequest {
  method: string
  /** A path relative to `baseUrl`, or an absolute `http(s)://` URL (e.g. a page link). */
  path: string
  query?: ReadQuery
  body?: unknown
  /**
   * Override the request `Content-Type` (defaults to the negotiated JSON:API media type when a
   * body is present). Set for a custom action's `raw` input, where the payload is not a JSON:API
   * document. When set it wins over {@link ext}/{@link profiles} for `Content-Type`.
   */
  contentType?: string
  /**
   * Override the request `Accept` header (defaults to the negotiated JSON:API media type). Set
   * for a `raw`-input action that still expects a document response; when set it wins over
   * {@link ext}/{@link profiles} for `Accept`.
   */
  accept?: string
  /**
   * Extension URIs to negotiate (the media-type `ext` parameter), e.g. the atomic ext. Composed
   * into both `Accept` and (when a body is present) `Content-Type` via the JSON:API media type,
   * unless {@link accept}/{@link contentType} override the respective header.
   */
  ext?: readonly string[]
  /**
   * Profile URIs to negotiate (the media-type `profile` parameter), e.g. the Countable profile a
   * `withCount` read requires. Composed into both `Accept` and (when a body is present)
   * `Content-Type`, unless {@link accept}/{@link contentType} override the respective header.
   */
  profiles?: readonly string[]
  /**
   * Send the body verbatim (a `string`) instead of JSON-stringifying it. Used for a `raw`
   * action body that's already serialised; a non-string body still falls back to
   * `JSON.stringify`.
   */
  raw?: boolean
}

const isAbsolute = (path: string): boolean => /^https?:\/\//i.test(path)

const append = (parts: string[], key: string, value: unknown): void => {
  if (value === undefined || value === null || value === '') {
    return
  }
  parts.push(`${key}=${encodeURIComponent(String(value))}`)
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Append a filter value under its (already-bracketed) key. A plain object is a STRUCTURED filter
 * value — a `Range`/`DateRange` deepObject (`{ min, max }`) — and recurses into nested bracketed
 * keys (`filter[k][min]=`), matching the server's deepObject wire shape; an array joins with `,`;
 * a scalar is appended directly. Without the object branch a `{ min, max }` value would reach the
 * wire as `filter[k]=[object Object]` and be silently ignored by the server (D23).
 */
const appendFilterValue = (parts: string[], key: string, value: unknown): void => {
  if (isPlainObject(value)) {
    for (const [subKey, subValue] of Object.entries(value)) {
      appendFilterValue(parts, `${key}[${subKey}]`, subValue)
    }
    return
  }
  append(parts, key, Array.isArray(value) ? value.join(',') : value)
}

/**
 * Serialise a read query to a query string (no leading `?`). Bracketed keys
 * (`filter[title]`, `page[number]`, `fields[albums]`) are kept literal; only values
 * are percent-encoded. Empty/undefined entries are skipped; key order is deterministic
 * (family order, then insertion order within a family) so URLs are stable for caching.
 */
export function serializeQuery(query: ReadQuery): string {
  const parts: string[] = []

  if (query.filter) {
    for (const [key, value] of Object.entries(query.filter)) {
      appendFilterValue(parts, `filter[${key}]`, value)
    }
  }

  if (query.sort !== undefined) {
    append(parts, 'sort', Array.isArray(query.sort) ? query.sort.join(',') : query.sort)
  }

  if (query.include) {
    append(parts, 'include', query.include.join(','))
  }

  if (query.fields) {
    for (const [type, names] of Object.entries(query.fields)) {
      // An explicitly-empty fieldset (`fields[type]=`) is meaningful in JSON:API — it selects NO
      // members of that type (id-only), which is exactly what the return type narrows to. Emit the
      // empty param verbatim (the generic empty-skip would drop it, leaving the type over-narrowed
      // vs. the full resource the server would otherwise return).
      parts.push(`fields[${type}]=${encodeURIComponent(names.join(','))}`)
    }
  }

  if (query.withCount && query.withCount.length > 0) {
    append(parts, 'withCount', query.withCount.join(','))
  }

  if (query.page) {
    for (const [key, value] of Object.entries(query.page)) {
      append(parts, `page[${key}]`, Array.isArray(value) ? value.join(',') : value)
    }
  }

  return parts.join('&')
}

/**
 * Execute a request: build the URL (verbatim when already absolute — for page links —
 * else `baseUrl + path`), apply content negotiation and any async per-request headers,
 * then drive the transport. A 2xx with a body parses to a {@link Document}; an empty /
 * 204 body resolves to `undefined`. A non-2xx throws a {@link JsonApiError} carrying the
 * parsed error objects (tolerating a non-JSON error body with an empty list).
 */
export async function execute(
  ctx: JsonApiContext,
  req: JsonApiRequest,
): Promise<Document | undefined> {
  let url = isAbsolute(req.path) ? req.path : ctx.baseUrl + req.path
  if (req.query) {
    const qs = serializeQuery(req.query)
    if (qs) {
      url += (url.includes('?') ? '&' : '?') + qs
    }
  }

  // Compose the negotiated media type (`application/vnd.api+json` + any opted-in ext/profile
  // parameters) once; a bare request yields the plain JSON:API media type. An explicit
  // `accept`/`contentType` override wins over the negotiated value for its header.
  const negotiated = mediaType({ ext: req.ext, profiles: req.profiles })
  const headers: Record<string, string> = { Accept: req.accept ?? negotiated }

  const transportReq: TransportRequest = { method: req.method, url, headers }
  if (req.body !== undefined) {
    headers['Content-Type'] = req.contentType ?? negotiated
    transportReq.body =
      req.raw && typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
  }

  if (ctx.headers) {
    mergeHeaders(headers, await ctx.headers())
  }

  const res = await ctx.transport(transportReq)

  if (res.status >= 200 && res.status < 300) {
    return parseDocument(res.body)
  }

  throw new JsonApiError(res.status, parseErrors(res.body))
}

/**
 * Merge a `HeadersInit` (object / tuple array / `Headers`) into the outgoing map,
 * preserving the caller's casing (unlike the WHATWG `Headers`, which lowercases). The
 * caller's headers override the runtime defaults, so per-request `Accept` etc. can win.
 */
function mergeHeaders(into: Record<string, string>, extra: HeadersInit): void {
  if (extra instanceof Headers) {
    extra.forEach((value, key) => {
      into[key] = value
    })
  } else if (Array.isArray(extra)) {
    for (const [key, value] of extra) {
      if (key !== undefined && value !== undefined) {
        into[key] = String(value)
      }
    }
  } else {
    for (const [key, value] of Object.entries(extra)) {
      into[key] = String(value)
    }
  }
}

function parseDocument(body: string): Document | undefined {
  if (body === '') {
    return undefined
  }
  return JSON.parse(body) as Document
}

function parseErrors(body: string): JsonApiErrorObject[] {
  if (body === '') {
    return []
  }
  try {
    const doc = JSON.parse(body) as { errors?: JsonApiErrorObject[] }
    return Array.isArray(doc.errors) ? doc.errors : []
  } catch {
    return []
  }
}
