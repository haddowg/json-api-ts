import { type AtomicRecorder, runAtomic } from './atomic'
import type {
  ActionDescriptor,
  ActionScope,
  ApiDescriptor,
  AtomicDescriptor,
  InputMediaKind,
} from './descriptor'
import { JsonApiError } from './errors'
import { materialise, type MaterialiseContext, relatedPaginator } from './materialise'
import { resolvePaginator } from './pagination'
import {
  execute,
  executeRaw,
  type JsonApiContext,
  type JsonApiRequest,
  type ReadQuery,
} from './request'
import type {
  ActionCallOptions,
  ActionsAccessor,
  Client,
  DefaultActionTypes,
  DefaultAttributes,
  DefaultWriteAttributes,
  RelationReadQuery,
  RelationshipAccessor,
  ResourceHandle,
  TypeAccessor,
} from './result-types'
import {
  toDocument,
  toRelationshipDocument,
  withRemappedPaths,
  withRemappedRelationshipPaths,
} from './serialize-write'
import { fetchTransport, type JsonApiTransport } from './transport'
import { JSON_API_MEDIA_TYPE } from './types'
import { resolveValidator, type ValidationOption } from './validate'

/**
 * The `fetch` headers init type. `@types/node` declares the global `RequestInit` (used
 * by the transport) but not `HeadersInit`; we derive it from `RequestInit.headers` to
 * stay dep-free and consistent with the rest of the runtime's web-globals usage.
 */
export type HeadersInit = NonNullable<RequestInit['headers']>

/** Options for {@link createClient}. */
export interface ClientOptions {
  /** Base URL the generated path templates are resolved against. */
  baseUrl: string
  /** Transport seam; defaults to the `fetch` adapter when omitted. */
  transport?: JsonApiTransport
  /** Per-request header provider (e.g. bearer auth); may be async. */
  headers?: () => HeadersInit | Promise<HeadersInit>
  /**
   * Follow a server link (`$next()`, `$prev()`) that leaves `baseUrl`'s origin. Off by default, so
   * such a link rejects without sending a request. When on, the request goes out without
   * {@link headers}.
   */
  allowCrossOriginLinks?: boolean
  /**
   * The server-level Atomic Operations capability (the codegen's `atomic` constant): `{ path }`
   * when the server exposes the atomic endpoint, else `null`/omitted. When present, the client
   * exposes `client.atomic(tx => …)`; otherwise calling it throws.
   */
  atomic?: AtomicDescriptor | null
  /**
   * The opt-in per-field validation seam (ADR 0004). Off by default — the client always runs
   * light structural guards (is this a JSON:API document? does each `data`/`included` member
   * carry `type`+`id`?) but otherwise trusts the wire. Supply either the schema-driven config
   * `{ schemas, validator }` — the codegen-emitted per-type `schemas` map plus a validation
   * engine adapter (each wire resource is validated against `schemas[type]`; a type with no
   * schema is skipped) — or a bare validator function that owns schema lookup itself. The
   * validation engine (e.g. ajv) is brought by the caller; the client never depends on one.
   */
  validate?: ValidationOption
}

/** The ambient runtime context every read shares: transport seam + descriptor + materialise glue. */
interface ClientContext {
  readonly request: JsonApiContext
  readonly materialise: MaterialiseContext
  readonly descriptor: ApiDescriptor
}

/** Substitute `{key}` placeholders in a path template (`/albums/{id}/{rel}` -> `/albums/1/tracks`). */
const fill = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`)

/**
 * Fill a type's path template, putting a relation's URI segment (its `uriField`, else its name)
 * in place of `{rel}`. `vars.rel` stays the relation's name everywhere else.
 */
function fillPath(
  ctx: ClientContext,
  type: string,
  template: string,
  vars: Record<string, string>,
): string {
  const rel = vars['rel']
  const uriField = rel === undefined ? undefined : ctx.descriptor[type]?.relations[rel]?.uriField
  return fill(template, uriField === undefined ? vars : { ...vars, rel: uriField })
}

/**
 * Run an operation: resolve the path template from the type's descriptor, fill its
 * placeholders, execute, and materialise the resulting document. A no-body / 204 response
 * materialises to `undefined`; an operation the type does not declare (no path template) throws
 * a local `Error` before any request. `linkage` marks a relationship-endpoint read (primary
 * `data` is pure resource-identifier linkage) so an attribute-less, relation-less member is
 * still materialised as an identifier.
 */
async function run(
  ctx: ClientContext,
  type: string,
  operation: string,
  vars: Record<string, string>,
  query: ReadQuery | undefined,
  linkage = false,
  relationForCount?: string,
): Promise<unknown> {
  const template = ctx.descriptor[type]?.paths[operation]
  if (template === undefined) {
    throw new Error(`No "${operation}" path declared for type "${type}"`)
  }
  const req: JsonApiRequest = { method: 'GET', path: fillPath(ctx, type, template, vars) }
  if (query !== undefined) {
    const { signal, ...params } = query
    req.query = params
    if (signal !== undefined) {
      req.signal = signal
    }
    negotiateProfiles(ctx, type, params, req, relationForCount)
  }
  const doc = await execute(ctx.request, req)
  // Resolve the strategy that answers from the endpoint's paginator and the `page` sent, so an
  // EMPTY page still reports the real `$page.kind` (D6) and a menu read reports the arm it picked.
  // A related/relationship read uses the RELATION's paginator, which may diverge from the related
  // type's collection (D6a).
  const relation =
    (operation === 'fetchRelated' || operation === 'fetchRelationship') && vars['rel'] !== undefined
      ? ctx.descriptor[type]?.relations[vars['rel']]
      : undefined
  const paginator =
    operation === 'fetchMany'
      ? ctx.descriptor[type]?.paginator
      : relation !== undefined
        ? relatedPaginator(relation, ctx.materialise)
        : undefined
  const primaryType = operation === 'fetchMany' ? type : undefined
  const paginatorOverride =
    paginator === undefined ? undefined : resolvePaginator(paginator, query?.page)
  return doc === undefined
    ? undefined
    : materialise(doc, ctx.materialise, linkage, primaryType, paginatorOverride)
}

/**
 * Add any profiles a query's parameters require to the request's negotiated `profiles`. A
 * `withCount` read needs the type's Countable profile in `Accept` — else the server rejects it
 * (400) under strict query-param validation. The profile URI is read from the descriptor's
 * `countable` block (never hardcoded); absent when the type advertises no Countable profile.
 */
function negotiateProfiles(
  ctx: ClientContext,
  type: string,
  query: ReadQuery,
  req: JsonApiRequest,
  relationForCount?: string,
): void {
  if (query.withCount === undefined || query.withCount.length === 0) {
    return
  }
  // A related/relationship read negotiates the RELATION's Countable profile (its tokens differ
  // from the collection's); a top-level collection read uses the type's (D3).
  const profile =
    relationForCount !== undefined
      ? ctx.descriptor[type]?.relations[relationForCount]?.countable?.profile
      : ctx.descriptor[type]?.countable?.profile
  if (profile !== undefined) {
    req.profiles = [...(req.profiles ?? []), profile]
  }
}

/** A write opts object: an optional `include`/`fields` narrowing the materialised response. */
interface WriteOpts {
  include?: readonly string[]
  fields?: Record<string, readonly string[]>
}

/** Project a write's opts to the read-query families the response honours (`include`/`fields`). */
function writeQuery(opts: WriteOpts | undefined): ReadQuery | undefined {
  if (opts === undefined) {
    return undefined
  }
  const query: ReadQuery = {}
  if (opts.include !== undefined) {
    query.include = [...opts.include]
  }
  if (opts.fields !== undefined) {
    const fields: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(opts.fields)) {
      fields[k] = [...v]
    }
    query.fields = fields
  }
  return Object.keys(query).length > 0 ? query : undefined
}

/** A write's spec: how to address it, what to send, and how to shape the result + errors. */
interface WriteSpec {
  type: string
  operation: string
  vars: Record<string, string>
  method: string
  body: unknown
  query?: ReadQuery | undefined
  /** Materialise the primary `data` as identifier linkage (relationship endpoints) vs resources. */
  linkage?: boolean
  /** Remap a thrown error's pointers to flat input paths (resource-write vs relationship-write). */
  remap: (error: JsonApiError) => JsonApiError
}

/**
 * Drive a write: fill the path template, attach the body (and any `include`/`fields` query),
 * execute, and materialise the response (`undefined` for a `204`/no body — so create/update
 * return the resource and delete/`204` relationship mutations resolve `undefined`/`void`).
 * On a thrown {@link JsonApiError}, each error's flat `path` is populated (via `spec.remap`)
 * before it propagates, so a caller's `byPath()` keys are the flat input shape.
 */
async function runWrite(ctx: ClientContext, spec: WriteSpec): Promise<unknown> {
  const template = ctx.descriptor[spec.type]?.paths[spec.operation]
  if (template === undefined) {
    throw new Error(`No "${spec.operation}" path declared for type "${spec.type}"`)
  }
  const req: JsonApiRequest = {
    method: spec.method,
    path: fillPath(ctx, spec.type, template, spec.vars),
    body: spec.body,
  }
  if (spec.query !== undefined) {
    req.query = spec.query
  }
  let doc
  try {
    doc = await execute(ctx.request, req)
  } catch (error) {
    if (error instanceof JsonApiError) {
      throw spec.remap(error)
    }
    throw error
  }
  return doc === undefined ? undefined : materialise(doc, ctx.materialise, spec.linkage ?? false)
}

/**
 * Invoke a custom action over its declared HTTP method (`action.method`, default `POST`) at its
 * (filled) path, with a body shaped by the action's `input` mode:
 *
 * - `none` — no body;
 * - `document` — when the action names an `inputType`, FLAT input (the resource's attributes /
 *   relationships) is built into the JSON:API envelope like `create`, and a `422`'s
 *   `source.pointer`s are remapped to the flat paths; a bespoke command document (no `inputType`)
 *   is sent verbatim;
 * - `raw` — the caller's payload, sent with the action's declared media type (e.g.
 *   `application/octet-stream`), falling back to a wildcard when the spec declared none.
 *
 * An action listing several request media types (`inputMedia`) sends the one the caller picks
 * with `options.contentType`, or JSON:API when listed, else the first.
 *
 * The response is shaped by the action's `output`: `document` materialises into the resource /
 * collection view, `meta` returns the document's top-level `meta`, `none` resolves `undefined` (a
 * `204` / no body). An action declaring `rawOutput` answers in the media type the caller picks
 * with `options.accept`: JSON:API as above, or a `string`, a `Blob` or `ArrayBuffer`, or parsed
 * JSON by the media type's kind.
 */
async function runAction(
  ctx: ClientContext,
  action: ActionDescriptor,
  vars: Record<string, string>,
  input: unknown,
  options: ActionCallOptions = {},
): Promise<unknown> {
  const req: JsonApiRequest = { method: action.method ?? 'POST', path: fill(action.path, vars) }
  if (options.signal !== undefined) {
    req.signal = options.signal
  }
  let remap: ((error: JsonApiError) => JsonApiError) | undefined
  const media = requestMedia(action, options.contentType)
  if (media !== undefined && media.kind !== 'document') {
    req.body = encodeFields(media.mediaType, media.kind, input)
    req.raw = true
    req.contentType = sentContentType(media.mediaType, media.kind, req.body)
  } else if (action.input === 'document') {
    if (action.inputType !== undefined) {
      // Flat input: build the envelope like create, and remap 422 pointers to the flat paths.
      const inputType = action.inputType
      req.body = toDocument(ctx.descriptor, inputType, (input ?? {}) as Record<string, unknown>)
      remap = (error) => withRemappedPaths(error, ctx.descriptor, inputType)
    } else {
      // A bespoke command document (no resolvable input type): pass the caller's envelope through.
      req.body = input
    }
  } else if (action.input === 'raw') {
    req.body = encodeFields(action.contentType ?? '*/*', undefined, input)
    // Send the action's declared media type (e.g. application/octet-stream); fall back to a
    // wildcard only when the spec declared none.
    req.contentType = sentContentType(action.contentType ?? '*/*', undefined, req.body)
    req.raw = true
  }

  const raw = responseMedia(action, options.accept)
  try {
    if (raw !== undefined) {
      req.accept = raw.mediaType
      if (raw.kind === 'binary') {
        return await executeRaw(
          ctx.request,
          req,
          options.responseType === 'arrayBuffer' ? 'arraybuffer' : 'blob',
        )
      }
      const text = await executeRaw(ctx.request, req, 'text')
      return raw.kind === 'json' && text !== undefined ? (JSON.parse(text) as unknown) : text
    }
    const doc = await execute(ctx.request, req)
    if (action.output === 'none' || doc === undefined) {
      return undefined
    }
    if (action.output === 'meta') {
      return doc.meta
    }
    return materialise(doc, ctx.materialise)
  } catch (error) {
    if (remap !== undefined && error instanceof JsonApiError) {
      throw remap(error)
    }
    throw error
  }
}

/**
 * The request media type an action with several (`inputMedia`) sends: the caller's pick, matched
 * exactly or through a declared wildcard such as `image/*`, else JSON:API when listed, else the
 * first. `undefined` for an action with a single request media type.
 */
function requestMedia(
  action: ActionDescriptor,
  picked: string | undefined,
): { mediaType: string; kind: InputMediaKind } | undefined {
  const listed = action.inputMedia
  if (listed === undefined || listed.length === 0) {
    if (picked !== undefined) {
      throw new Error(`This action declares no request media types to choose "${picked}" from.`)
    }
    return undefined
  }
  if (picked === undefined) {
    const media = listed.find((entry) => entry.mediaType === JSON_API_MEDIA_TYPE) ?? listed[0]!
    return { mediaType: media.mediaType, kind: media.kind }
  }
  const essence = picked.split(';')[0]!.trim().toLowerCase()
  const match =
    listed.find((entry) => entry.mediaType === essence) ??
    listed.find((entry) => entry.mediaType === `${essence.split('/')[0]}/*`) ??
    listed.find((entry) => entry.mediaType === '*/*')
  if (match === undefined) {
    throw new Error(
      `This action does not accept "${picked}"; it accepts ${listed.map((entry) => entry.mediaType).join(', ')}.`,
    )
  }
  return { mediaType: picked, kind: match.kind }
}

/**
 * A multipart or URL-encoded body given as a plain object of fields, encoded into a `FormData` or
 * `URLSearchParams`. Any other body, a ready `FormData` included, is sent as it is.
 */
function encodeFields(mediaType: string, kind: InputMediaKind | undefined, body: unknown): unknown {
  const multipart = kind === 'multipart' || mediaType.startsWith('multipart/')
  const form = kind === 'form' || mediaType === 'application/x-www-form-urlencoded'
  if ((!multipart && !form) || !isPlainObject(body)) {
    return body
  }
  return multipart ? toFormData(body) : toSearchParams(body)
}

/** Whether a body is a plain object of fields rather than a ready payload. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/**
 * The entries a field contributes: nothing for `null` or `undefined`, one `name[]` entry per item
 * for an array (the bracket suffix is how PHP servers read a repeated field as a list), else one
 * `name` entry.
 */
function fieldEntries(name: string, value: unknown): [string, unknown][] {
  if (value === null || value === undefined) {
    return []
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== null && item !== undefined)
      .map((item): [string, unknown] => [`${name}[]`, item])
  }
  return [[name, value]]
}

/** A field's text value: booleans as `true` or `false`, everything else through `String`. */
function fieldText(value: unknown): string {
  return typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)
}

/** A multipart body from fields. A `File` keeps its name; a bare `Blob` is named after its field. */
function toFormData(fields: Record<string, unknown>): FormData {
  const data = new FormData()
  for (const [field, value] of Object.entries(fields)) {
    for (const [name, item] of fieldEntries(field, value)) {
      if (typeof Blob !== 'undefined' && item instanceof Blob) {
        const fileName =
          typeof File !== 'undefined' && item instanceof File && item.name !== ''
            ? item.name
            : field
        data.append(name, item, fileName)
      } else {
        data.append(name, fieldText(item))
      }
    }
  }
  return data
}

/** A URL-encoded body from fields. */
function toSearchParams(fields: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams()
  for (const [field, value] of Object.entries(fields)) {
    for (const [name, item] of fieldEntries(field, value)) {
      params.append(name, fieldText(item))
    }
  }
  return params
}

/**
 * The `Content-Type` for a non-JSON:API body. A multipart `FormData` body gets none, so the
 * transport writes the boundary. A wildcard media type takes a `Blob` body's own type.
 */
function sentContentType(
  mediaType: string,
  kind: InputMediaKind | undefined,
  body: unknown,
): string | null {
  if (
    (kind === 'multipart' || mediaType.startsWith('multipart/')) &&
    typeof FormData !== 'undefined' &&
    body instanceof FormData
  ) {
    return null
  }
  if (mediaType.includes('*') && typeof Blob !== 'undefined' && body instanceof Blob) {
    return body.type === '' ? mediaType : body.type
  }
  return mediaType
}

/**
 * The non-JSON:API media type an action is asked to answer in: the caller's `accept` when it isn't
 * JSON:API, else, with no `accept`, the first raw media type of an action that answers in no
 * JSON:API document. `undefined` means a JSON:API response.
 */
function responseMedia(
  action: ActionDescriptor,
  accept: string | undefined,
): { mediaType: string; kind: string } | undefined {
  const raw = action.rawOutput ?? []
  if (accept === undefined) {
    return action.output === 'none' ? raw[0] : undefined
  }
  if (accept === JSON_API_MEDIA_TYPE) {
    return undefined
  }
  const media = raw.find((entry) => entry.mediaType === accept)
  if (media === undefined) {
    throw new Error(
      `This action does not answer in "${accept}"; it answers in ${[...(action.output === 'none' ? [] : [JSON_API_MEDIA_TYPE]), ...raw.map((entry) => entry.mediaType)].join(', ')}.`,
    )
  }
  return media
}

/**
 * Build the typed `.actions` accessor at one scope: a plain object exposing exactly the
 * type's actions declared at `scope` (collection on the type accessor, resource on a handle),
 * each a function dispatching to {@link runAction} with the action descriptor + the scope's
 * path vars (resource scope supplies `{id}`). Names not declared at this scope are absent —
 * `client.albums.actions.reissue` (resource-scoped) is undefined; reach it via `.id(id)`.
 */
function actionsAccessor(
  ctx: ClientContext,
  type: string,
  scope: ActionScope,
  vars: Record<string, string>,
): ActionsAccessor<ApiDescriptor, unknown, unknown, string, ActionScope> {
  const actions = ctx.descriptor[type]?.actions ?? {}
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const [name, action] of Object.entries(actions)) {
    if (action.scope === scope) {
      // An action without input takes only the options; any other takes the body first.
      out[name] = (...args: unknown[]) =>
        action.input === 'none'
          ? runAction(ctx, action, vars, undefined, args[0] as ActionCallOptions | undefined)
          : runAction(ctx, action, vars, args[0], args[1] as ActionCallOptions | undefined)
    }
  }
  return out as ActionsAccessor<ApiDescriptor, unknown, unknown, string, ActionScope>
}

/**
 * Build the relationship accessor for `client.<type>.id(id).<rel>`: reads
 * (`.get()` linkage / `.related()` collection) plus mutations — to-many `.add` (POST) /
 * `.remove` (DELETE) / `.replace` (PATCH) and to-one `.set` (PATCH). Every mutation posts
 * a `{ data: <linkage> }` body to `fetchRelationship` and materialises the response as
 * linkage (or `undefined`/`void` for a `204`). The cardinality is read off the descriptor
 * so the linkage is coerced correctly; the static types gate which verb is callable.
 */
function relationshipAccessor(
  ctx: ClientContext,
  type: string,
  id: string,
  rel: string,
): RelationshipAccessor<ApiDescriptor, unknown, string, never> {
  const vars = { id, rel }
  const relation = ctx.descriptor[type]?.relations[rel]
  const cardinality = relation?.cardinality ?? 'many'
  const hasPivot = relation?.pivot === true
  const mutate = (method: string, refs: unknown): Promise<unknown> =>
    runWrite(ctx, {
      type,
      operation: 'fetchRelationship',
      vars,
      method,
      body: toRelationshipDocument(refs, cardinality),
      linkage: true,
      remap: (error) => withRemappedRelationshipPaths(error, rel, hasPivot),
    })

  // Whether the relation advertises a mutation verb: the descriptor's `mutations` flags are
  // authoritative when present (mirrors the type-level `AdvertisesVerb`), so a verb the
  // bundle forbids (`cannotReplace` -> no PATCH) is absent at runtime, not just untyped. A
  // relation with no `mutations` block falls back to cardinality alone.
  const advertises = (verb: 'add' | 'remove' | 'replace' | 'set'): boolean => {
    const mutations = relation?.mutations
    return mutations === undefined ? true : mutations[verb] === true
  }

  // A read is present only when the relation exposes that endpoint (the descriptor's
  // `relationship`/`related` flags, from the bundle's `withoutRelationshipEndpoint()` /
  // `withoutRelatedEndpoint()`). A suppressed read is omitted (a JS caller gets "not a function"
  // rather than a 404); the static types gate it to `never` for a typed caller (D24).
  // A write-only relation is never rendered, so it has neither read.
  const accessor: Record<string, unknown> = {}
  const readable = relation?.writeOnly !== true
  if (readable && relation?.relationship !== false) {
    accessor['get'] = (query?: RelationReadQuery) =>
      run(ctx, type, 'fetchRelationship', vars, query as ReadQuery | undefined, true, rel)
  }
  if (readable && relation?.related !== false) {
    accessor['related'] = (query?: RelationReadQuery) =>
      run(ctx, type, 'fetchRelated', vars, query as ReadQuery | undefined, false, rel)
  }
  if (cardinality === 'many') {
    if (advertises('add')) {
      accessor['add'] = (refs: unknown) => mutate('POST', refs)
    }
    if (advertises('remove')) {
      accessor['remove'] = (refs: unknown) => mutate('DELETE', refs)
    }
    if (advertises('replace')) {
      accessor['replace'] = (refs: unknown) => mutate('PATCH', refs)
    }
  } else if (advertises('set')) {
    accessor['set'] = (ref: unknown) => mutate('PATCH', ref)
  }

  return accessor as unknown as RelationshipAccessor<ApiDescriptor, unknown, string, never>
}

/**
 * The reserved members on a {@link ResourceHandle} — names the Proxy resolves itself, so a
 * relation of the same name is shadowed and must route through `.rel(name)`. The codegen
 * imports this to warn at build time (keeping the runtime + the collision detector in sync).
 * `then` is reserved so a handle is never mistaken for a thenable.
 */
export const HANDLE_RESERVED: ReadonlySet<string> = new Set([
  'type',
  'id',
  'get',
  'update',
  'delete',
  'rel',
  'actions',
  'then',
])

/** Build the id-scoped resource handle (a Proxy resolving relation accessors by name). */
function resourceHandle(
  ctx: ClientContext,
  type: string,
  id: string,
): ResourceHandle<ApiDescriptor, unknown, unknown, string> {
  const relations = ctx.descriptor[type]?.relations ?? {}
  const base = {
    type,
    id,
    get: (query?: ReadQuery) => run(ctx, type, 'fetchOne', { id }, query),
    update: (patch: Record<string, unknown>, opts?: WriteOpts) =>
      runWrite(ctx, {
        type,
        operation: 'update',
        vars: { id },
        method: 'PATCH',
        body: toDocument(ctx.descriptor, type, patch, { id }),
        query: writeQuery(opts),
        remap: (error) => withRemappedPaths(error, ctx.descriptor, type),
      }),
    delete: () =>
      runWrite(ctx, {
        type,
        operation: 'delete',
        vars: { id },
        method: 'DELETE',
        body: undefined,
        remap: (error) => withRemappedPaths(error, ctx.descriptor, type),
      }) as never,
    rel: (name: string) => relationshipAccessor(ctx, type, id, name),
    actions: actionsAccessor(ctx, type, 'resource', { id }),
  }

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !HANDLE_RESERVED.has(prop) && prop in relations) {
        return relationshipAccessor(ctx, type, id, prop)
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as unknown as ResourceHandle<ApiDescriptor, unknown, unknown, string>
}

/** Build the collection-scoped accessor for one wire type (`client.albums`). */
function typeAccessor(
  ctx: ClientContext,
  type: string,
): TypeAccessor<ApiDescriptor, unknown, unknown, string> {
  return {
    list: (query?: ReadQuery) => run(ctx, type, 'fetchMany', {}, query) as Promise<never>,
    get: (id: string, query?: ReadQuery) =>
      run(ctx, type, 'fetchOne', { id }, query) as Promise<never>,
    create: (input: Record<string, unknown>, opts?: WriteOpts) =>
      runWrite(ctx, {
        type,
        operation: 'create',
        vars: {},
        method: 'POST',
        body: toDocument(ctx.descriptor, type, input),
        query: writeQuery(opts),
        remap: (error) => withRemappedPaths(error, ctx.descriptor, type),
      }) as Promise<never>,
    id: (id: string) => resourceHandle(ctx, type, id),
    actions: actionsAccessor(ctx, type, 'collection', {}),
  } as unknown as TypeAccessor<ApiDescriptor, unknown, unknown, string>
}

/**
 * Build a descriptor-driven read client. Generic at runtime (a Proxy over the descriptor),
 * not per-type codegen: `client.<type>` yields a {@link TypeAccessor}, `.id(id)` a handle,
 * and a handle's relation accessors drive the relationship/related endpoints. Navigation
 * (`$next()`/`$prev()`, related links) is wired through `materialise`'s `navigate` seam,
 * which resolves the server's link against `baseUrl`, executes it and re-materialises.
 */
export function createClient<
  D extends ApiDescriptor,
  A = DefaultAttributes<D>,
  W = DefaultWriteAttributes<D>,
  Act = DefaultActionTypes,
  E extends string = string,
  L = Record<never, never>,
>(descriptor: D, options: ClientOptions): Client<D, A, W, Act, E, L> {
  const request: JsonApiContext = {
    baseUrl: options.baseUrl,
    transport: options.transport ?? fetchTransport,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    ...(options.allowCrossOriginLinks !== undefined
      ? { allowCrossOriginLinks: options.allowCrossOriginLinks }
      : {}),
  }

  const validator = resolveValidator(options.validate)
  const ctx: ClientContext = {
    request,
    descriptor,
    materialise: {
      descriptor,
      navigate: async (url, linkage = false, paginator, signal) => {
        const doc = await execute(request, {
          method: 'GET',
          path: url,
          link: true,
          ...(signal !== undefined ? { signal } : {}),
        })
        return doc === undefined
          ? undefined
          : materialise(doc, ctx.materialise, linkage, undefined, paginator)
      },
      ...(validator !== undefined ? { validate: validator } : {}),
    },
  }

  const atomicDescriptor = options.atomic ?? null
  // `client.atomic(tx => …)`: post the recorded batch to the atomic endpoint. Built once and
  // reused; throws when the server declares no atomic capability (`atomic` was null/omitted).
  // Typed via the single conditional-return `Client['atomic']` signature (tuple-of-handles ->
  // positional results; void -> loose results); the runtime forwards the callback to `runAtomic`.
  const atomic = (build: (tx: AtomicRecorder<D, W>) => unknown): Promise<unknown> => {
    if (atomicDescriptor === null) {
      throw new Error('This API does not expose an Atomic Operations endpoint')
    }
    return runAtomic(
      request,
      ctx.materialise,
      descriptor,
      atomicDescriptor.path,
      build as (tx: AtomicRecorder<D, W>) => void,
    )
  }

  const accessors = new Map<string, TypeAccessor<ApiDescriptor, unknown, unknown, string>>()
  return new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      if (prop === 'atomic') {
        return atomic
      }
      if (typeof prop !== 'string' || !(prop in descriptor)) {
        return undefined
      }
      let accessor = accessors.get(prop)
      if (accessor === undefined) {
        accessor = typeAccessor(ctx, prop)
        accessors.set(prop, accessor)
      }
      return accessor
    },
    has(_target, prop) {
      return prop === 'atomic' || (typeof prop === 'string' && prop in descriptor)
    },
  }) as Client<D, A, W, Act, E, L>
}
