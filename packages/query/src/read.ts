/**
 * Read OPTION FACTORIES over the typed client (option factories, not hooks; docs/tanstack-query.md).
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
  Collection,
  CollectionMeta,
  FieldsMap,
  CountToken,
  IncludePath,
  ListPageParams,
  PageOf,
  ReadResult,
  RelationName,
  RelationReadQuery,
  RelationshipAccessor,
  ResourceCountToken,
  SingleReadQuery,
  TypedReadQuery,
  TypedRelatedReadQuery,
  TypedRelationReadQuery,
  TypeName,
  OperationMeta,
  WithDocumentMeta,
} from '@haddowg/json-api-client'
import { type KeyTarget, keyFor, type QueryKey } from './keys'

/**
 * What a collection read resolves to: the client's `Collection`, its `$page` typed by the strategy
 * and its `$meta` by the members the read's document declares.
 */
export type ListResult<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[] = [],
  F = unknown,
  Pg = undefined,
  Cnt extends readonly string[] = [],
> = Collection<
  ReadResult<D, A, T, Inc, F, Cnt[number]>,
  PageOf<D[T]['paginator'], Pg>,
  CollectionMeta<D, T>
>

/**
 * What a single read resolves to: the client's resource view, its `$document.meta` typed by the
 * members the read's document declares.
 */
export type FetchOneResult<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[] = [],
  F = unknown,
  Cnt extends readonly string[] = [],
> = WithDocumentMeta<ReadResult<D, A, T, Inc, F, Cnt[number]>, OperationMeta<D, T, 'fetchOne'>>

/**
 * The precise materialised result of `.rel(R).related()` / `.get()` — extracted (via `infer`)
 * from the client's own {@link RelationshipAccessor} so the read factories carry the client's
 * full per-relation narrowing (a `Collection` of hydrated members / identifier members, typed
 * `$pivot`, polymorphic unions) instead of a loose `unknown`. A suppressed endpoint (whose
 * method the client types `never`) falls back to `unknown`.
 */
type RelatedResult<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = RelationshipAccessor<D, A, T, R>['related'] extends (...args: never[]) => Promise<infer V>
  ? V
  : unknown

type LinkageResult<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = RelationshipAccessor<D, A, T, R>['get'] extends (...args: never[]) => Promise<infer V>
  ? V
  : unknown

/**
 * A TanStack-compatible query-options object: the deterministic {@link QueryKey} plus a
 * `queryFn` resolving the materialised result `R`. The `queryFn` passes TanStack's abort `signal`
 * to the read, so a query whose key changes, or whose last observer goes away, cancels its request. Structurally assignable to
 * `query-core`'s `QueryOptions`/`UseQueryOptions` (the user merges in `staleTime` etc.), so the
 * binding needn't import or re-export query-core's option type — it stays a peer.
 *
 * `structuralSharing` is off. A materialised value carries non-enumerable accessors such as
 * `$page`, `$next` and `$self`, and TanStack's structural sharing rebuilds a value that changed on
 * refetch as plain arrays and objects, which drops them.
 */
export interface QueryOptions<R> {
  queryKey: QueryKey
  queryFn: (context?: QueryFnContext) => Promise<R>
  structuralSharing: false
}

/** The part of TanStack's query-function context a read factory uses. */
export interface QueryFnContext {
  signal: AbortSignal
}

/**
 * The read's query with TanStack's abort signal added, or the query unchanged when the `queryFn` is
 * called without a context. The key is built from `query` alone, so the signal never reaches it.
 */
function withSignal<Q extends object>(query: Q | undefined, signal: AbortSignal | undefined): Q {
  return (signal === undefined ? query : { ...query, signal }) as Q
}

/**
 * The id a factory addresses a resource of type `T` by: a string, or `undefined` for a singleton,
 * whose reads and writes carry no id.
 */
export type ResourceId<D extends ApiDescriptor, T extends TypeName<D>> = D[T] extends {
  singleton: true
}
  ? undefined
  : string

/** The loose relation reads a handle offers at the `.rel(name)` boundary. */
interface RelationReads {
  get(query?: RelationReadQuery): Promise<unknown>
  related(query?: RelationReadQuery): Promise<unknown>
}

/** A singleton's read accessor: its single read and its relations, with no id. */
interface SingletonReads<D extends ApiDescriptor, A, T extends TypeName<D>> {
  get<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Cnt extends readonly ResourceCountToken<D, T, 'fetchOne'>[] = [],
  >(
    query?: SingleReadQuery<D, T, Inc, F, Cnt>,
  ): Promise<FetchOneResult<D, A, T, Inc, F, Cnt>>
  rel(name: RelationName<D, T>): RelationReads
}

/** A client narrowed to its per-type accessors (drops the `atomic` member, which reads don't use). */
type TypedClient<D extends ApiDescriptor, A> = {
  [T in TypeName<D>]: D[T] extends { singleton: true }
    ? SingletonReads<D, A, T>
    : TypeReads<D, A, T>
}

/** A collection type's read accessor. */
interface TypeReads<D extends ApiDescriptor, A, T extends TypeName<D>> {
  list<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Pg extends ListPageParams<D, T> | undefined = undefined,
    const Cnt extends readonly CountToken<D, T>[] = [],
  >(
    query?: TypedReadQuery<D, T, Inc, F, Pg, Cnt>,
  ): Promise<ListResult<D, A, T, Inc, F, Pg, Cnt>>
  get<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Cnt extends readonly ResourceCountToken<D, T, 'fetchOne'>[] = [],
  >(
    id: string,
    query?: SingleReadQuery<D, T, Inc, F, Cnt>,
  ): Promise<FetchOneResult<D, A, T, Inc, F, Cnt>>
  id(id: string): { rel(name: RelationName<D, T>): RelationReads }
}

/** The accessor of `type`, read as a collection type's or a singleton's. */
function readsOf<D extends ApiDescriptor, A, T extends TypeName<D>>(
  client: TypedClient<D, A>,
  type: T,
): TypeReads<D, A, T> & SingletonReads<D, A, T> {
  return client[type] as unknown as TypeReads<D, A, T> & SingletonReads<D, A, T>
}

/** The relation reads of a resource, or of a singleton when `id` is `undefined`. */
function relationReads<D extends ApiDescriptor, A, T extends TypeName<D>>(
  client: TypedClient<D, A>,
  type: T,
  id: string | undefined,
  rel: RelationName<D, T>,
): RelationReads {
  const accessor = readsOf(client, type)
  return id === undefined ? accessor.rel(rel) : accessor.id(id).rel(rel)
}

/** A key target addressing `id`, or a singleton when it is `undefined`. */
function target(
  type: string,
  operation: 'fetchOne' | 'fetchRelated' | 'fetchRelationship',
  id: string | undefined,
  rel?: string,
): KeyTarget {
  return {
    type,
    operation,
    ...(id === undefined ? {} : { id }),
    ...(rel === undefined ? {} : { rel }),
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
  const Pg extends ListPageParams<D, T> | undefined = undefined,
  const Cnt extends readonly CountToken<D, T>[] = [],
>(
  client: TypedClient<D, A>,
  type: T,
  query?: TypedReadQuery<D, T, Inc, F, Pg, Cnt>,
): QueryOptions<ListResult<D, A, T, Inc, F, Pg, Cnt>> {
  const accessor = readsOf(client, type)
  return {
    queryKey: keyFor({ type, operation: 'fetchMany' }, query),
    structuralSharing: false,
    queryFn: (context) => accessor.list<Inc, F, Pg, Cnt>(withSignal(query, context?.signal)),
  }
}

/**
 * The single-resource read (`GET /{type}/{id}`): options resolving the typed resource view,
 * narrowed by `include`/`fields` and counted by `withCount` as `client.<type>.get(id, query)`.
 * Key: `[type, 'fetchOne', id, <params>]` — the `id` sits at a fixed position so {@link keyFor}'s
 * prefix matches a resource's reads. A singleton (`GET /inbox`) takes `undefined` for the id and
 * reads as `client.<type>.get(query)`, keyed `[type, 'fetchOne', <params>]`.
 */
export function getQueryOptions<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  const Inc extends readonly IncludePath<D, T>[] = [],
  const F extends FieldsMap<D> = {},
  const Cnt extends readonly ResourceCountToken<D, T, 'fetchOne'>[] = [],
>(
  client: TypedClient<D, A>,
  type: T,
  id: ResourceId<D, T>,
  query?: SingleReadQuery<D, T, Inc, F, Cnt>,
): QueryOptions<FetchOneResult<D, A, T, Inc, F, Cnt>> {
  const accessor = readsOf(client, type)
  const resource: string | undefined = id
  return {
    queryKey: keyFor(target(type, 'fetchOne', resource), query),
    structuralSharing: false,
    queryFn: (context) =>
      resource === undefined
        ? accessor.get<Inc, F, Cnt>(withSignal(query, context?.signal))
        : accessor.get<Inc, F, Cnt>(resource, withSignal(query, context?.signal)),
  }
}

/**
 * The relationship-linkage read (`GET /{type}/{id}/relationships/{rel}`): options resolving the
 * materialised linkage (identifier members), via `client.<type>.id(id).rel(rel).get(query)`. Key:
 * `[type, 'fetchRelationship', id, rel, <params>]`. The result is the client's runtime linkage
 * shape; the relationship endpoint's per-relation value is loose at the `.rel(name)` boundary, so
 * the option resolves `unknown` unless the caller annotates it (parity with the client's runtime).
 * A singleton takes `undefined` for the id, keyed `[type, 'fetchRelationship', rel, <params>]`.
 */
export function relationshipQueryOptions<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
>(
  client: TypedClient<D, A>,
  type: T,
  id: ResourceId<D, T>,
  rel: R,
  query?: TypedRelationReadQuery<D, T, R>,
): QueryOptions<LinkageResult<D, A, T, R>> {
  return {
    queryKey: keyFor(target(type, 'fetchRelationship', id, rel), query),
    structuralSharing: false,
    queryFn: (context) =>
      relationReads(client, type, id, rel).get(withSignal(query, context?.signal)) as Promise<
        LinkageResult<D, A, T, R>
      >,
  }
}

/**
 * The related-collection read (`GET /{type}/{id}/{rel}`): options resolving the materialised
 * related resource(s), via `client.<type>.id(id).rel(rel).related(query)`. Key: `[type,
 * 'fetchRelated', id, rel, <params>]`. As with linkage, the related value is loose at the
 * `.rel(name)` boundary, so this resolves `unknown` (parity with the client runtime). A singleton
 * takes `undefined` for the id, keyed `[type, 'fetchRelated', rel, <params>]`.
 */
export function relatedQueryOptions<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
>(
  client: TypedClient<D, A>,
  type: T,
  id: ResourceId<D, T>,
  rel: R,
  query?: TypedRelatedReadQuery<D, T, R>,
): QueryOptions<RelatedResult<D, A, T, R>> {
  return {
    queryKey: keyFor(target(type, 'fetchRelated', id, rel), query),
    structuralSharing: false,
    queryFn: (context) =>
      relationReads(client, type, id, rel).related(withSignal(query, context?.signal)) as Promise<
        RelatedResult<D, A, T, R>
      >,
  }
}

// ── Bound per-type API (sugar over the standalone factories) ──────────────────────────────

/** The per-type read-option factories, with `client`/`type` pre-applied (`api.<type>.list(...)`). */
export interface TypeQueryApi<D extends ApiDescriptor, A, T extends TypeName<D>> {
  list<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Pg extends ListPageParams<D, T> | undefined = undefined,
    const Cnt extends readonly CountToken<D, T>[] = [],
  >(
    query?: TypedReadQuery<D, T, Inc, F, Pg, Cnt>,
  ): QueryOptions<ListResult<D, A, T, Inc, F, Pg, Cnt>>
  get<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Cnt extends readonly ResourceCountToken<D, T, 'fetchOne'>[] = [],
  >(
    id: string,
    query?: SingleReadQuery<D, T, Inc, F, Cnt>,
  ): QueryOptions<FetchOneResult<D, A, T, Inc, F, Cnt>>
  relationship<R extends RelationName<D, T>>(
    id: string,
    rel: R,
    query?: TypedRelationReadQuery<D, T, R>,
  ): QueryOptions<LinkageResult<D, A, T, R>>
  related<R extends RelationName<D, T>>(
    id: string,
    rel: R,
    query?: TypedRelatedReadQuery<D, T, R>,
  ): QueryOptions<RelatedResult<D, A, T, R>>
}

/**
 * A singleton's read-option factories (`api.inboxes.get(query)`), which take no id, as the
 * client's singleton accessor doesn't.
 */
export interface SingletonQueryApi<D extends ApiDescriptor, A, T extends TypeName<D>> {
  get<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Cnt extends readonly ResourceCountToken<D, T, 'fetchOne'>[] = [],
  >(
    query?: SingleReadQuery<D, T, Inc, F, Cnt>,
  ): QueryOptions<FetchOneResult<D, A, T, Inc, F, Cnt>>
  relationship<R extends RelationName<D, T>>(
    rel: R,
    query?: TypedRelationReadQuery<D, T, R>,
  ): QueryOptions<LinkageResult<D, A, T, R>>
  related<R extends RelationName<D, T>>(
    rel: R,
    query?: TypedRelatedReadQuery<D, T, R>,
  ): QueryOptions<RelatedResult<D, A, T, R>>
}

/**
 * The bound query API: one {@link TypeQueryApi} per wire type (`api.albums.list(...)`), or a
 * {@link SingletonQueryApi} for a singleton type.
 */
export type QueryApi<D extends ApiDescriptor, A> = {
  [T in TypeName<D>]: D[T] extends { singleton: true }
    ? SingletonQueryApi<D, A, T>
    : TypeQueryApi<D, A, T>
}

/**
 * Bind a client to its per-type read-option factories: `createQueryApi(client).albums.list(query)`
 * returns the same `{ queryKey, queryFn }` as `listQueryOptions(client, 'albums', query)`, with
 * `client`/`type` pre-applied. A Proxy (descriptor-free — type validity is enforced by the static
 * `QueryApi` shape) so no per-type allocation until first access.
 */
export function createQueryApi<D extends ApiDescriptor, A>(
  client: TypedClient<D, A>,
): QueryApi<D, A> {
  const cache = new Map<
    string,
    TypeQueryApi<D, A, TypeName<D>> | SingletonQueryApi<D, A, TypeName<D>>
  >()
  return new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      if (typeof prop !== 'string') {
        return undefined
      }
      let api = cache.get(prop)
      if (api === undefined) {
        const type = prop as TypeName<D>
        // A singleton's accessor offers no `.id()`, since it has no id to address.
        api =
          typeof (client[type] as { id?: unknown } | undefined)?.id === 'function'
            ? typeQueryApi(client, type)
            : singletonQueryApi(client, type)
        cache.set(prop, api)
      }
      return api
    },
  }) as QueryApi<D, A>
}

/** Build one type's bound read-option factories (delegates to the standalone factories). */
function typeQueryApi<D extends ApiDescriptor, A, T extends TypeName<D>>(
  client: TypedClient<D, A>,
  type: T,
): TypeQueryApi<D, A, T> {
  // A collection type's id is a string, which the deferred `ResourceId` can't see here.
  const of = (id: string) => id as ResourceId<D, T>
  return {
    list: (query) => listQueryOptions(client, type, query),
    get: (id, query) => getQueryOptions(client, type, of(id), query),
    relationship<R extends RelationName<D, T>>(
      id: string,
      rel: R,
      query?: TypedRelationReadQuery<D, T, R>,
    ) {
      return relationshipQueryOptions(client, type, of(id), rel, query)
    },
    related<R extends RelationName<D, T>>(
      id: string,
      rel: R,
      query?: TypedRelatedReadQuery<D, T, R>,
    ) {
      return relatedQueryOptions(client, type, of(id), rel, query)
    },
  }
}

/** Build a singleton's bound read-option factories, which address it with no id. */
function singletonQueryApi<D extends ApiDescriptor, A, T extends TypeName<D>>(
  client: TypedClient<D, A>,
  type: T,
): SingletonQueryApi<D, A, T> {
  const none = undefined as ResourceId<D, T>
  return {
    get: (query) => getQueryOptions(client, type, none, query),
    relationship<R extends RelationName<D, T>>(rel: R, query?: TypedRelationReadQuery<D, T, R>) {
      return relationshipQueryOptions(client, type, none, rel, query)
    },
    related<R extends RelationName<D, T>>(rel: R, query?: TypedRelatedReadQuery<D, T, R>) {
      return relatedQueryOptions(client, type, none, rel, query)
    },
  }
}
