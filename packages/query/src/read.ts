/**
 * Read OPTION FACTORIES over the typed client (CONTEXT.md: "option factories, not hooks").
 *
 * Each factory returns a plain `{ queryKey, queryFn }` object compatible with
 * `@tanstack/query-core` — the user passes it to their framework's `useQuery` or to a
 * `QueryClient.fetchQuery`. The binding depends ONLY on `query-core` (framework-agnostic) and
 * preserves the client's full static narrowing: `include` widens relations to hydrated, `fields`
 * narrows to the sparse fieldset, the result type is the client's own materialised view.
 *
 * Surface, exposed two equivalent ways:
 *  - standalone factories — `listQueryOptions(client, type, query)`, `getQueryOptions(...)`,
 *    `relationshipQueryOptions(...)`, `relatedQueryOptions(...)`;
 *  - a bound API — `createQueryApi(client).<type>.list(query)` etc. — sugar over the same
 *    factories with `client`/`type` pre-applied (the cleanest per-type call shape).
 */
import type {
  ApiDescriptor,
  Client,
  Collection,
  FieldsMap,
  IncludePath,
  ReadResult,
  RelationName,
  RelationReadQuery,
  SingleReadQuery,
  TypedReadQuery,
  TypeName,
} from '@haddowg/json-api-client'
import { keyFor, type QueryKey } from './keys'

/**
 * A TanStack-compatible query-options object: the deterministic {@link QueryKey} plus a
 * zero-arg `queryFn` resolving the materialised result `R`. Structurally assignable to
 * `query-core`'s `QueryOptions`/`UseQueryOptions` (the user merges in `staleTime` etc.), so the
 * binding needn't import or re-export query-core's option type — it stays a peer.
 */
export interface QueryOptions<R> {
  queryKey: QueryKey
  queryFn: () => Promise<R>
}

/** A client narrowed to its per-type accessors (drops the `atomic` member, which reads don't use). */
type TypedClient<D extends ApiDescriptor, A> = {
  [T in TypeName<D>]: {
    list<const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
      query?: TypedReadQuery<D, T, Inc, F>,
    ): Promise<Collection<ReadResult<D, A, T, Inc, F>>>
    get<const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
      id: string,
      query?: SingleReadQuery<D, T, Inc, F>,
    ): Promise<ReadResult<D, A, T, Inc, F>>
    id(id: string): {
      rel(name: RelationName<D, T>): {
        get(query?: RelationReadQuery): Promise<unknown>
        related(query?: RelationReadQuery): Promise<unknown>
      }
    }
  }
}

/**
 * The collection-list read (`GET /{type}`): options resolving the typed `Collection`, narrowed by
 * `include`/`fields` exactly as `client.<type>.list(query)`. The key is `[type, 'fetchMany',
 * <params>]` — the normalised query rides the trailing segment, so two equal queries share a key.
 */
export function listQueryOptions<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  const Inc extends readonly IncludePath<D, T>[] = [],
  const F extends FieldsMap<D> = {},
>(
  client: Client<D, A>,
  type: T,
  query?: TypedReadQuery<D, T, Inc, F>,
): QueryOptions<Collection<ReadResult<D, A, T, Inc, F>>> {
  const accessor = (client as unknown as TypedClient<D, A>)[type]
  return {
    queryKey: keyFor({ type, operation: 'fetchMany' }, query),
    queryFn: () => accessor.list<Inc, F>(query),
  }
}

/**
 * The single-resource read (`GET /{type}/{id}`): options resolving the typed resource view,
 * narrowed by `include`/`fields` as `client.<type>.get(id, query)`. Key: `[type, 'fetchOne', id,
 * <params>]` — the `id` sits at a fixed position so {@link keyFor}'s prefix matches a resource's
 * reads.
 */
export function getQueryOptions<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  const Inc extends readonly IncludePath<D, T>[] = [],
  const F extends FieldsMap<D> = {},
>(
  client: Client<D, A>,
  type: T,
  id: string,
  query?: SingleReadQuery<D, T, Inc, F>,
): QueryOptions<ReadResult<D, A, T, Inc, F>> {
  const accessor = (client as unknown as TypedClient<D, A>)[type]
  return {
    queryKey: keyFor({ type, operation: 'fetchOne', id }, query),
    queryFn: () => accessor.get<Inc, F>(id, query),
  }
}

/**
 * The relationship-linkage read (`GET /{type}/{id}/relationships/{rel}`): options resolving the
 * materialised linkage (identifier members), via `client.<type>.id(id).rel(rel).get(query)`. Key:
 * `[type, 'fetchRelationship', id, rel, <params>]`. The result is the client's runtime linkage
 * shape; the relationship endpoint's per-relation value is loose at the `.rel(name)` boundary, so
 * the option resolves `unknown` unless the caller annotates it (parity with the client's runtime).
 */
export function relationshipQueryOptions<D extends ApiDescriptor, A, T extends TypeName<D>>(
  client: Client<D, A>,
  type: T,
  id: string,
  rel: RelationName<D, T>,
  query?: RelationReadQuery,
): QueryOptions<unknown> {
  const accessor = (client as unknown as TypedClient<D, A>)[type]
  return {
    queryKey: keyFor({ type, operation: 'fetchRelationship', id, rel }, query),
    queryFn: () => accessor.id(id).rel(rel).get(query),
  }
}

/**
 * The related-collection read (`GET /{type}/{id}/{rel}`): options resolving the materialised
 * related resource(s), via `client.<type>.id(id).rel(rel).related(query)`. Key: `[type,
 * 'fetchRelated', id, rel, <params>]`. As with linkage, the related value is loose at the
 * `.rel(name)` boundary, so this resolves `unknown` (parity with the client runtime).
 */
export function relatedQueryOptions<D extends ApiDescriptor, A, T extends TypeName<D>>(
  client: Client<D, A>,
  type: T,
  id: string,
  rel: RelationName<D, T>,
  query?: RelationReadQuery,
): QueryOptions<unknown> {
  const accessor = (client as unknown as TypedClient<D, A>)[type]
  return {
    queryKey: keyFor({ type, operation: 'fetchRelated', id, rel }, query),
    queryFn: () => accessor.id(id).rel(rel).related(query),
  }
}

// ── Bound per-type API (sugar over the standalone factories) ──────────────────────────────

/** The per-type read-option factories, with `client`/`type` pre-applied (`api.<type>.list(...)`). */
export interface TypeQueryApi<D extends ApiDescriptor, A, T extends TypeName<D>> {
  list<const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
    query?: TypedReadQuery<D, T, Inc, F>,
  ): QueryOptions<Collection<ReadResult<D, A, T, Inc, F>>>
  get<const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
    id: string,
    query?: SingleReadQuery<D, T, Inc, F>,
  ): QueryOptions<ReadResult<D, A, T, Inc, F>>
  relationship(
    id: string,
    rel: RelationName<D, T>,
    query?: RelationReadQuery,
  ): QueryOptions<unknown>
  related(id: string, rel: RelationName<D, T>, query?: RelationReadQuery): QueryOptions<unknown>
}

/** The bound query API: one {@link TypeQueryApi} per wire type (`api.albums.list(...)`). */
export type QueryApi<D extends ApiDescriptor, A> = {
  [T in TypeName<D>]: TypeQueryApi<D, A, T>
}

/**
 * Bind a client to its per-type read-option factories: `createQueryApi(client).albums.list(query)`
 * returns the same `{ queryKey, queryFn }` as `listQueryOptions(client, 'albums', query)`, with
 * `client`/`type` pre-applied. A Proxy (descriptor-free — type validity is enforced by the static
 * `QueryApi` shape) so no per-type allocation until first access.
 */
export function createQueryApi<D extends ApiDescriptor, A>(client: Client<D, A>): QueryApi<D, A> {
  const cache = new Map<string, TypeQueryApi<D, A, TypeName<D>>>()
  return new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      if (typeof prop !== 'string') {
        return undefined
      }
      let api = cache.get(prop)
      if (api === undefined) {
        api = typeQueryApi(client, prop as TypeName<D>)
        cache.set(prop, api)
      }
      return api
    },
  }) as QueryApi<D, A>
}

/** Build one type's bound read-option factories (delegates to the standalone factories). */
function typeQueryApi<D extends ApiDescriptor, A, T extends TypeName<D>>(
  client: Client<D, A>,
  type: T,
): TypeQueryApi<D, A, T> {
  return {
    list: (query) => listQueryOptions(client, type, query),
    get: (id, query) => getQueryOptions(client, type, id, query),
    relationship: (id, rel, query) => relationshipQueryOptions(client, type, id, rel, query),
    related: (id, rel, query) => relatedQueryOptions(client, type, id, rel, query),
  }
}
