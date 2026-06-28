import type { HeadersInit } from './client'
import { JsonApiError, type JsonApiErrorObject } from './errors'
import type { JsonApiTransport, TransportRequest } from './transport'
import { JSON_API_MEDIA_TYPE } from './types'

/**
 * A read query, in the flat shape the fluent surface accepts. Serialised to the
 * JSON:API bracketed query-parameter families by {@link serializeQuery}.
 */
export interface ReadQuery {
  filter?: Record<string, unknown>
  sort?: string | string[]
  include?: string[]
  fields?: Record<string, string[]>
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
   * Override the request `Content-Type` (defaults to the JSON:API media type when a body is
   * present). Set for a custom action's `raw` input, where the payload is not a JSON:API
   * document, or for an atomic batch (the ext media type). When unset, `Accept` is unaffected.
   */
  contentType?: string
  /**
   * Override the request `Accept` header (defaults to the JSON:API media type). Set for an
   * atomic batch, where the response is the atomic-ext document; a `raw`-input action leaves
   * it at the JSON:API default (a document response is still expected).
   */
  accept?: string
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
      append(parts, `filter[${key}]`, Array.isArray(value) ? value.join(',') : value)
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
      append(parts, `fields[${type}]`, names.join(','))
    }
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

  const headers: Record<string, string> = { Accept: req.accept ?? JSON_API_MEDIA_TYPE }

  const transportReq: TransportRequest = { method: req.method, url, headers }
  if (req.body !== undefined) {
    headers['Content-Type'] = req.contentType ?? JSON_API_MEDIA_TYPE
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
