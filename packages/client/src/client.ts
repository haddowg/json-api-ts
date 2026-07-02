import { type AtomicRecorder, runAtomic } from './atomic'
import type { ActionDescriptor, ActionScope, ApiDescriptor, AtomicDescriptor } from './descriptor'
import { JsonApiError } from './errors'
import { materialise, type MaterialiseContext } from './materialise'
import { execute, type JsonApiContext, type JsonApiRequest, type ReadQuery } from './request'
import type {
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
  const req: JsonApiRequest = { method: 'GET', path: fill(template, vars) }
  if (query !== undefined) {
    req.query = query
    negotiateProfiles(ctx, type, query, req, relationForCount)
  }
  const doc = await execute(ctx.request, req)
  // Pass the statically-known primary type for the top-level collection read so an EMPTY page
  // still reports the collection's real `$page.kind` instead of the sniffed-from-`data[0]` `none`
  // (D6). A single/related read doesn't need it (no top-level page, or the related type is sniffed).
  const primaryType = operation === 'fetchMany' ? type : undefined
  return doc === undefined ? undefined : materialise(doc, ctx.materialise, linkage, primaryType)
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
    path: fill(template, spec.vars),
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
 * The response is shaped by the action's `output`: `document` materialises into the resource /
 * collection view, `meta` returns the document's top-level `meta`, `none` resolves `undefined` (a
 * `204` / no body).
 */
async function runAction(
  ctx: ClientContext,
  action: ActionDescriptor,
  vars: Record<string, string>,
  input: unknown,
): Promise<unknown> {
  const req: JsonApiRequest = { method: action.method ?? 'POST', path: fill(action.path, vars) }
  let remap: ((error: JsonApiError) => JsonApiError) | undefined
  if (action.input === 'document') {
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
    req.body = input
    // Send the action's declared media type (e.g. application/octet-stream); fall back to a
    // wildcard only when the spec declared none.
    req.contentType = action.contentType ?? '*/*'
    req.raw = true
  }
  let doc: Awaited<ReturnType<typeof execute>>
  try {
    doc = await execute(ctx.request, req)
  } catch (error) {
    if (remap !== undefined && error instanceof JsonApiError) {
      throw remap(error)
    }
    throw error
  }
  if (action.output === 'none' || doc === undefined) {
    return undefined
  }
  if (action.output === 'meta') {
    return doc.meta
  }
  return materialise(doc, ctx.materialise)
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
  const out: Record<string, (input?: unknown) => Promise<unknown>> = {}
  for (const [name, action] of Object.entries(actions)) {
    if (action.scope === scope) {
      out[name] = (input?: unknown) => runAction(ctx, action, vars, input)
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
  const accessor: Record<string, unknown> = {}
  if (relation?.relationship !== false) {
    accessor['get'] = (query?: RelationReadQuery) =>
      run(ctx, type, 'fetchRelationship', vars, query as ReadQuery | undefined, true, rel)
  }
  if (relation?.related !== false) {
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
 * which executes the (absolute) link and re-materialises.
 */
export function createClient<
  D extends ApiDescriptor,
  A = DefaultAttributes<D>,
  W = DefaultWriteAttributes<D>,
  Act = DefaultActionTypes,
>(descriptor: D, options: ClientOptions): Client<D, A, W, Act> {
  const request: JsonApiContext = {
    baseUrl: options.baseUrl,
    transport: options.transport ?? fetchTransport,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  }

  const validator = resolveValidator(options.validate)
  const ctx: ClientContext = {
    request,
    descriptor,
    materialise: {
      descriptor,
      navigate: async (url, linkage = false) => {
        const doc = await execute(request, { method: 'GET', path: url })
        return doc === undefined ? undefined : materialise(doc, ctx.materialise, linkage)
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
  }) as Client<D, A, W, Act>
}
