import type { ApiDescriptor } from './descriptor'
import { materialise, type MaterialiseContext } from './materialise'
import { execute, type JsonApiContext, type JsonApiRequest, type ReadQuery } from './request'
import type {
  Client,
  DefaultAttributes,
  RelationReadQuery,
  RelationshipAccessor,
  ResourceHandle,
  TypeAccessor,
} from './result-types'
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

/** Build the relationship accessor for `client.<type>.id(id).<rel>` (`.get()` / `.related()`). */
function relationshipAccessor(
  ctx: ClientContext,
  type: string,
  id: string,
  rel: string,
): RelationshipAccessor<ApiDescriptor, unknown, string, never> {
  const vars = { id, rel }
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
  }
}

/**
 * The reserved members on a {@link ResourceHandle} — names the Proxy resolves itself, so a
 * relation of the same name is shadowed and must route through `.rel(name)`. The codegen
 * imports this to warn at build time (keeping the runtime + the collision detector in sync).
 * `then` is reserved so a handle is never mistaken for a thenable.
 */
export const HANDLE_RESERVED: ReadonlySet<string> = new Set(['type', 'id', 'get', 'rel', 'then'])

/** Build the id-scoped resource handle (a Proxy resolving relation accessors by name). */
function resourceHandle(
  ctx: ClientContext,
  type: string,
  id: string,
): ResourceHandle<ApiDescriptor, unknown, string> {
  const relations = ctx.descriptor[type]?.relations ?? {}
  const base = {
    type,
    id,
    get: (query?: ReadQuery) => run(ctx, type, 'fetchOne', { id }, query),
    rel: (name: string) => relationshipAccessor(ctx, type, id, name),
  }

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !HANDLE_RESERVED.has(prop) && prop in relations) {
        return relationshipAccessor(ctx, type, id, prop)
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as unknown as ResourceHandle<ApiDescriptor, unknown, string>
}

/** Build the collection-scoped accessor for one wire type (`client.albums`). */
function typeAccessor(
  ctx: ClientContext,
  type: string,
): TypeAccessor<ApiDescriptor, unknown, string> {
  return {
    list: (query?: ReadQuery) => run(ctx, type, 'fetchMany', {}, query) as Promise<never>,
    get: (id: string, query?: ReadQuery) =>
      run(ctx, type, 'fetchOne', { id }, query) as Promise<never>,
    id: (id: string) => resourceHandle(ctx, type, id),
  } as unknown as TypeAccessor<ApiDescriptor, unknown, string>
}

/**
 * Build a descriptor-driven read client. Generic at runtime (a Proxy over the descriptor),
 * not per-type codegen: `client.<type>` yields a {@link TypeAccessor}, `.id(id)` a handle,
 * and a handle's relation accessors drive the relationship/related endpoints. Navigation
 * (`$next()`/`$prev()`, related links) is wired through `materialise`'s `navigate` seam,
 * which executes the (absolute) link and re-materialises.
 */
export function createClient<D extends ApiDescriptor, A = DefaultAttributes<D>>(
  descriptor: D,
  options: ClientOptions,
): Client<D, A> {
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

  const accessors = new Map<string, TypeAccessor<ApiDescriptor, unknown, string>>()
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
  }) as Client<D, A>
}
