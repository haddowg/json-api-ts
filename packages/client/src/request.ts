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
  /** Cancels the read when signalled. Never serialised; passed to the transport. */
  signal?: AbortSignal
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
  /** Follow server links to another origin, without {@link headers}. Off by default. */
  allowCrossOriginLinks?: boolean
}

/** A single read/write request, before serialisation. */
export interface JsonApiRequest {
  method: string
  /**
   * A path appended to `baseUrl` (a filled path template such as `/albums/1`), or an absolute
   * `http(s)://` URL. With {@link link} set, a link from the server instead.
   */
  path: string
  /**
   * `path` is a link the server sent (a `links` member such as `next`, or a `Location` header).
   * It resolves against `baseUrl` per RFC 3986, so a root-relative `/api/v5/albums?page[number]=2`
   * keeps the base's origin but not its path, where a path template is appended to the base.
   */
  link?: boolean
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
  /** Passed through to the transport so the caller can cancel the request. */
  signal?: AbortSignal
}

const isAbsolute = (path: string): boolean => /^https?:\/\//i.test(path)

// Stands in for the origin when `baseUrl` is relative and there's no page to resolve it against.
const RELATIVE_ORIGIN = 'http://relative.invalid'

/** A server link resolved for following, and whether it stays on the base URL's origin. */
interface ResolvedLink {
  url: string
  sameOrigin: boolean
}

/**
 * Resolve a server link against `baseUrl` per RFC 3986 and check where it lands. A link on the
 * base's origin is followed; a relative base (e.g. `/api`) takes the page's origin in a browser and
 * otherwise only accepts a link that keeps the host. Anything that isn't plain http(s) is refused.
 */
function resolveLink(link: string, baseUrl: string): ResolvedLink {
  // The URL parser drops tabs and newlines and trims control characters, so check what it sees.
  let normalised = link.replace(/[\t\n\r]/g, '')
  let start = 0
  while (start < normalised.length && normalised.charCodeAt(start) <= 0x20) start++
  normalised = normalised.slice(start)
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalised)?.[1]?.toLowerCase()
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') {
    throw new Error(`Refusing to follow link "${link}": only http(s) links are followed`)
  }

  const relativeBase = !isAbsolute(baseUrl)
  const page = (globalThis as { location?: { href?: unknown } }).location?.href
  const base = new URL(
    baseUrl,
    relativeBase ? (typeof page === 'string' ? page : RELATIVE_ORIGIN) : undefined,
  )
  const resolved = new URL(link, base)
  // `https:host` names a scheme without `//`, which the parser may read as a path or a host.
  const sameOrigin =
    resolved.origin === base.origin && (scheme === undefined || /^https?:\/\//i.test(normalised))

  if (!sameOrigin) {
    return { url: resolved.href, sameOrigin }
  }
  return {
    url: relativeBase ? resolved.pathname + resolved.search + resolved.hash : resolved.href,
    sameOrigin,
  }
}

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
 * Execute a request: build the URL (a server link resolved against `baseUrl` and held to its
 * origin, an absolute path verbatim, else `baseUrl + path`), apply content negotiation and any async per-request headers,
 * then drive the transport. A 2xx with a body parses to a {@link Document}; an empty /
 * 204 body resolves to `undefined`. A non-2xx throws a {@link JsonApiError} carrying the
 * parsed error objects (tolerating a non-JSON error body with an empty list).
 */
export async function execute(
  ctx: JsonApiContext,
  req: JsonApiRequest,
): Promise<Document | undefined> {
  let url: string
  let sendHeaders = true
  if (req.link) {
    const link = resolveLink(req.path, ctx.baseUrl)
    if (!link.sameOrigin && ctx.allowCrossOriginLinks !== true) {
      throw new Error(
        `Refusing to follow link "${req.path}": it leaves the base URL's origin (set allowCrossOriginLinks to follow it without the configured headers)`,
      )
    }
    url = link.url
    sendHeaders = link.sameOrigin
  } else {
    url = isAbsolute(req.path) ? req.path : ctx.baseUrl + req.path
  }
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
  if (req.signal !== undefined) {
    transportReq.signal = req.signal
  }
  if (req.body !== undefined) {
    headers['Content-Type'] = req.contentType ?? negotiated
    transportReq.body =
      req.raw && typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
  }

  if (ctx.headers && sendHeaders) {
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
