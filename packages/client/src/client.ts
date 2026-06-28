import type { ApiDescriptor } from './descriptor'
import { JsonApiError } from './errors'
import { materialise, type MaterialiseContext } from './materialise'
import { execute, type JsonApiContext, type JsonApiRequest, type ReadQuery } from './request'
import type {
  Client,
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
 * (or a missing path template) materialises to `undefined`. `linkage` marks a
 * relationship-endpoint read (primary `data` is pure resource-identifier linkage) so an
 * attribute-less, relation-less member is still materialised as an identifier.
 */
async function run(
  ctx: ClientContext,
  type: string,
  operation: string,
  vars: Record<string, string>,
  query: ReadQuery | undefined,
  linkage = false,
): Promise<unknown> {
  const template = ctx.descriptor[type]?.paths[operation]
  if (template === undefined) {
    throw new Error(`No "${operation}" path declared for type "${type}"`)
  }
  const req: JsonApiRequest = { method: 'GET', path: fill(template, vars) }
  if (query !== undefined) {
    req.query = query
  }
  const doc = await execute(ctx.request, req)
  return doc === undefined ? undefined : materialise(doc, ctx.materialise, linkage)
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

  return {
    get: (query?: RelationReadQuery) =>
      run(
        ctx,
        type,
        'fetchRelationship',
        vars,
        query as ReadQuery | undefined,
        true,
      ) as Promise<never>,
    related: (query?: RelationReadQuery) =>
      run(ctx, type, 'fetchRelated', vars, query as ReadQuery | undefined) as Promise<never>,
    add: ((refs: unknown) => mutate('POST', refs)) as never,
    remove: ((refs: unknown) => mutate('DELETE', refs)) as never,
    replace: ((refs: unknown) => mutate('PATCH', refs)) as never,
    set: ((ref: unknown) => mutate('PATCH', ref)) as never,
  }
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
>(descriptor: D, options: ClientOptions): Client<D, A, W> {
  const request: JsonApiContext = {
    baseUrl: options.baseUrl,
    transport: options.transport ?? fetchTransport,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  }

  const ctx: ClientContext = {
    request,
    descriptor,
    materialise: {
      descriptor,
      navigate: async (url, linkage = false) => {
        const doc = await execute(request, { method: 'GET', path: url })
        return doc === undefined ? undefined : materialise(doc, ctx.materialise, linkage)
      },
    },
  }

  const accessors = new Map<string, TypeAccessor<ApiDescriptor, unknown, unknown, string>>()
  return new Proxy(Object.create(null) as object, {
    get(_target, prop) {
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
      return typeof prop === 'string' && prop in descriptor
    },
  }) as Client<D, A, W>
}
