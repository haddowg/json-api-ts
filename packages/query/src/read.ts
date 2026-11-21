/**
 * Read OPTION FACTORIES over the typed client (option factories, not hooks; docs/tanstack-query.md).
 *
 * Each factory returns a plain `{ queryKey, queryFn }` object compatible with
 * `@tanstack/query-core` — the user passes it to their framework's `useQuery` or to a
 * `QueryClient.fetchQuery`. The binding depends ONLY on `query-core` (framework-agnostic) and
 * preserves the client's full static narrowing: `include` widens relations to hydrated, `fields`
 * narrows to the sparse fieldset, the result type is the client's own materialised view. The key
 * is `DataTag`ged with that result and the read's error, so `getQueryData(key)` is typed, and the
 * options' declared `retry` type carries the error into `error`.
 *
 * Surface, exposed two equivalent ways:
 *  - standalone factories — `listQueryOptions(client, type, query)`, `getQueryOptions(...)`,
 *    `relationshipQueryOptions(...)`, `relatedQueryOptions(...)`, and the infinite reads
 *    `infiniteListQueryOptions(...)` and `infiniteRelatedQueryOptions(...)`;
 *  - a bound API — `createQueryApi(client).<type>.list(query)` etc. — sugar over the same
 *    factories with `client`/`type` pre-applied (the cleanest per-type call shape).
 */
import {
  type ApiDescriptor,
  type Client,
  type Collection,
  type CollectionMeta,
  type FieldsMap,
  type CountToken,
  type IncludePath,
  JsonApiError,
  type ListPageParams,
  nextPageParams,
  type Page,
  type PageOf,
  prevPageParams,
  type ReadResult,
  type RelationName,
  type RelationPageParams,
  type RelationPaginator,
  type RelationReadQuery,
  type RelationshipAccessor,
  type ResourceCountToken,
  type SingleReadQuery,
  StructuralGuardError,
  type TypedReadQuery,
  type TypedRelatedReadQuery,
  type TypedRelationReadQuery,
  type TypeName,
  type OperationMeta,
  type WithDocumentMeta,
} from '@haddowg/json-api-client'
import type { DataTag, InfiniteData, SkipToken } from '@tanstack/query-core'
import {
  INFINITE_SEGMENT,
  infiniteKeyFor,
  type KeyTarget,
  keyFor,
  type QueryKey,
  type ReadOperation,
  SKIPPED_SEGMENT,
} from './keys'
import { stamped } from './freshness'
import { scopeApi, type ScopeOption } from './scope'

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

/** Type-only brands keeping {@link ReadError}'s members apart; no value carries them. */
declare const guardFailure: unique symbol
declare const otherFailure: unique symbol

/**
 * A {@link StructuralGuardError} as a read's error type carries it. The brand is optional and never
 * present at runtime: it only stops TypeScript treating this member and {@link ReadFailure} as one
 * type. `status` is absent, so `error.status` reads `undefined` on it.
 */
export type ReadGuardError = StructuralGuardError & {
  readonly status?: undefined
  readonly [guardFailure]?: true
}

/**
 * Any other failure a read rejects with (a network failure, an abort, an error thrown by a
 * transport): an `Error` with no `status`, branded as {@link ReadGuardError} is.
 */
export type ReadFailure = Error & {
  readonly status?: undefined
  readonly [otherFailure]?: true
}

/**
 * What a read rejects with: a {@link JsonApiError} carrying the server's error-code union `C` (a
 * generated client's `ErrorCode`), a {@link StructuralGuardError} when the response isn't a
 * JSON:API document ({@link ReadGuardError}), or any other `Error` ({@link ReadFailure}).
 *
 * No member is a subtype of another. Both error classes extend `Error`, so a plain
 * `JsonApiError<C> | StructuralGuardError | Error` collapses to a single member wherever TypeScript
 * reduces a union by subtype (TanStack's infinite result types do, when they union `error` across
 * statuses), losing `C`. Each member here has an optional property the others lack, which keeps all
 * three. Narrow with `instanceof JsonApiError` or `instanceof StructuralGuardError`, or on
 * `error.status`, which is a `number` on a {@link JsonApiError} only. Any `Error` is assignable to it.
 */
export type ReadError<C extends string = string> = JsonApiError<C> | ReadGuardError | ReadFailure

/**
 * A typed TanStack `retry` callback. The read options declare it, optional and never set, so TanStack
 * infers the query's `error` as `E` while the QueryClient's configured `retry` still applies.
 */
export type ReadRetry<E = ReadError> = (failureCount: number, error: E) => boolean

/**
 * A read's query function: it passes TanStack's abort `signal` to the client call, and stamps the
 * result with the moment the request started, so normalisation can tell a newer response from an
 * older one that arrives after it.
 */
export type ReadQueryFn<R> = (context?: QueryFnContext) => Promise<R>

/**
 * A TanStack-compatible query-options object: the deterministic {@link QueryKey}, `DataTag`ged
 * with the result `R` and the error `E` so `queryClient.getQueryData(options.queryKey)` and
 * `setQueryData` are typed, plus a `queryFn` resolving the materialised result `R`. The tag is a
 * type-level brand only; the runtime key is the plain tuple {@link keyFor} builds.
 *
 * The `queryFn` passes TanStack's abort `signal` to the read, so a query whose key changes, or
 * whose last observer goes away, cancels its request. `retry` is declared, typed with `E`, but never
 * set: the declaration is how TanStack types the query's `error`, and leaving the property absent
 * keeps the QueryClient's configured `retry` in charge (see {@link jsonApiRetry} for the default
 * `installNormalization` installs). Structurally
 * assignable to `query-core`'s `QueryOptions`/`UseQueryOptions` (the user merges in `staleTime`
 * etc.), so the binding needn't re-export query-core's option type — it stays a peer.
 *
 * `structuralSharing` is off. A materialised value carries non-enumerable accessors such as
 * `$page`, `$next` and `$self`, and TanStack's structural sharing rebuilds a value that changed on
 * refetch as plain arrays and objects, which drops them.
 */
export interface QueryOptions<R, E = ReadError> {
  queryKey: DataTag<QueryKey, R, E>
  queryFn: ReadQueryFn<R>
  retry?: ReadRetry<E>
  structuralSharing: false
}

/**
 * The options of a read that may be skipped: built from `skipToken` in place of the id (or of a
 * list's query), its `queryFn` is TanStack's `skipToken`, which disables the query.
 */
export interface SkippableQueryOptions<R, E = ReadError> extends Omit<
  QueryOptions<R, E>,
  'queryFn'
> {
  queryFn: ReadQueryFn<R> | SkipToken
}

/** {@link QueryOptions}, or {@link SkippableQueryOptions} when the address `I` may be `skipToken`. */
export type ReadOptions<R, E, I> = SkipToken extends I
  ? SkippableQueryOptions<R, E>
  : QueryOptions<R, E>

/**
 * The relations of type `T` that are to-many: the relations an infinite related read pages
 * through. A to-one related read has no pages. Every relation of a descriptor that doesn't type its
 * cardinalities counts.
 */
export type ToManyRelationName<D extends ApiDescriptor, T extends TypeName<D>> = {
  [R in RelationName<D, T>]: 'many' extends D[T]['relations'][R]['cardinality'] ? R : never
}[RelationName<D, T>]

/**
 * The types whose collection read an infinite read pages through: every type but one whose
 * descriptor paginator is `'none'`, since an unpaginated collection has no pages.
 */
export type PaginatedTypeName<D extends ApiDescriptor> = Extract<
  { [T in TypeName<D>]: [D[T]['paginator']] extends ['none'] ? never : T }[TypeName<D>],
  TypeName<D>
>

/**
 * The to-many relations of type `T` whose related read an infinite related read pages through:
 * every {@link ToManyRelationName} but one whose related endpoint's paginator (the relation's own,
 * else its related type's collection paginator) is `'none'`.
 */
export type PaginatedRelationName<D extends ApiDescriptor, T extends TypeName<D>> = Extract<
  {
    [R in Extract<ToManyRelationName<D, T>, RelationName<D, T>>]: [
      RelationPaginator<D, T, R>,
    ] extends ['none']
      ? never
      : R
  }[Extract<ToManyRelationName<D, T>, RelationName<D, T>>],
  RelationName<D, T>
>

/**
 * The page param an infinite read of type `T`'s collection passes between pages: the read's typed
 * `page` argument, or `undefined` for the server's first page.
 */
export type ListPageParam<D extends ApiDescriptor, T extends TypeName<D>> =
  | ListPageParams<D, T>
  | undefined

/** The page param an infinite read of relation `R`'s related collection passes between pages. */
export type RelatedPageParam<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = RelationPageParams<D, T, R> | undefined

/** The part of TanStack's query-function context an infinite read uses: the page to read. */
export interface InfiniteQueryFnContext<P> {
  pageParam: P
  signal: AbortSignal
}

/** An infinite read's query function: it reads the page `pageParam` names. */
export type InfiniteQueryFn<R, P> = (context: InfiniteQueryFnContext<P>) => Promise<R>

/**
 * TanStack-compatible infinite query options: each page is the read's materialised result `R`, and
 * `P` is the `page` argument that reads one. `initialPageParam` is the query's own `page`, and
 * `getNextPageParam`/`getPreviousPageParam` read the params of the page after or before from its
 * `next`/`prev` link (through the client's `nextPageParams`/`prevPageParams`), `undefined` when
 * there is none. Each page param replaces the query's whole `page`, since the server's link carries
 * every page member. The key is the plain read's key plus `'$infinite'`, `DataTag`ged with the
 * cached `InfiniteData<R, P>` and the error `E`, which the declared-but-unset `retry` carries into
 * `error` as {@link QueryOptions} does. Structurally assignable to `query-core`'s
 * `InfiniteQueryObserverOptions` and `FetchInfiniteQueryOptions`, so `useInfiniteQuery`,
 * `injectInfiniteQuery` and `QueryClient.fetchInfiniteQuery` take it; `maxPages` and the rest are
 * TanStack's own options, merged in by the caller.
 */
export interface InfiniteQueryOptions<R, P, E = ReadError> {
  queryKey: DataTag<QueryKey, InfiniteData<R, P>, E>
  queryFn: InfiniteQueryFn<R, P>
  initialPageParam: P
  getNextPageParam: (lastPage: R) => P | undefined
  getPreviousPageParam: (firstPage: R) => P | undefined
  retry?: ReadRetry<E>
  structuralSharing: false
}

/** {@link InfiniteQueryOptions} of a read that may be skipped: its `queryFn` may be `skipToken`. */
export interface SkippableInfiniteQueryOptions<R, P, E = ReadError> extends Omit<
  InfiniteQueryOptions<R, P, E>,
  'queryFn'
> {
  queryFn: InfiniteQueryFn<R, P> | SkipToken
}

/**
 * {@link InfiniteQueryOptions}, or {@link SkippableInfiniteQueryOptions} when the address `I` may be
 * `skipToken`.
 */
export type InfiniteReadOptions<R, P, E, I> = SkipToken extends I
  ? SkippableInfiniteQueryOptions<R, P, E>
  : InfiniteQueryOptions<R, P, E>

/** The part of TanStack's query-function context a read factory uses. */
export interface QueryFnContext {
  signal: AbortSignal
}

/** How many times {@link jsonApiRetry} retries a failure it retries at all (TanStack's default). */
const DEFAULT_RETRIES = 3

/**
 * The JSON:API read retry policy: never retry a {@link JsonApiError} below 500 (a 4xx won't change
 * on a retry) or a {@link StructuralGuardError}; retry anything else (a 5xx, a network failure)
 * while `failureCount < 3`, TanStack's default count. `installNormalization` installs it as
 * the QueryClient's `defaultOptions.queries.retry` when the app configured none; set it yourself
 * when you build the defaults another way.
 */
export function jsonApiRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof JsonApiError && error.status < 500) {
    return false
  }
  if (error instanceof StructuralGuardError) {
    return false
  }
  return failureCount < DEFAULT_RETRIES
}

/**
 * The read's query with TanStack's abort signal added, or the query unchanged when the `queryFn` is
 * called without a context. The key is built from `query` alone, so the signal never reaches it.
 */
function withSignal<Q extends object>(query: Q | undefined, signal: AbortSignal | undefined): Q {
  return (signal === undefined ? query : { ...query, signal }) as Q
}

/** Brand a runtime key with the read's result and error types. */
function tag<R, E>(key: QueryKey): DataTag<QueryKey, R, E> {
  return key as DataTag<QueryKey, R, E>
}

/** The deterministic key of a skipped read. */
function skippedKey(type: string, operation: ReadOperation, rel?: string): QueryKey {
  return rel === undefined
    ? [type, operation, SKIPPED_SEGMENT]
    : [type, operation, SKIPPED_SEGMENT, rel]
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

/**
 * The key the client carries its error-code union under. The client keeps the symbol private (a
 * type-only member, read back with `ErrorCodeOf`), so it is recovered from the `Client` type.
 */
type ErrorCodesKey = Extract<keyof Client<{}>, symbol>

/**
 * A client narrowed to its per-type accessors (drops the `atomic` member, which reads don't use),
 * plus the error-code union `C` it carries, which the factories infer to type `error`.
 */
type TypedClient<D extends ApiDescriptor, A, C extends string = string> = {
  [T in TypeName<D>]: D[T] extends { singleton: true }
    ? SingletonReads<D, A, T>
    : TypeReads<D, A, T>
} & { readonly [K in ErrorCodesKey]?: C }

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

// ── Implementations (shared by the standalone factories and the bound API) ─────────────────

/**
 * Whether an address (an id, or a list's query) is a skip token. TanStack's `skipToken` is a
 * `Symbol()` unique to each copy of `@tanstack/query-core`, and an app can hold two, so any symbol
 * is the caller's token rather than a comparison against this module's own import; no id or query
 * is ever a symbol.
 */
function isSkip(value: unknown): value is SkipToken {
  return typeof value === 'symbol'
}

/** Options whose `queryFn` is the caller's skip token, under the skipped read's key. */
function skipped(
  token: SkipToken,
  type: string,
  operation: ReadOperation,
  rel?: string,
): SkippableQueryOptions<unknown, unknown> {
  return {
    queryKey: tag(skippedKey(type, operation, rel)),
    queryFn: token,
    structuralSharing: false,
  }
}

function listOptions<D extends ApiDescriptor, A>(
  client: TypedClient<D, A>,
  type: TypeName<D>,
  query: object | SkipToken | undefined,
): SkippableQueryOptions<unknown, unknown> {
  if (isSkip(query)) {
    return skipped(query, type, 'fetchMany')
  }
  const accessor = readsOf(client, type)
  return {
    queryKey: tag(keyFor({ type, operation: 'fetchMany' }, query)),
    structuralSharing: false,
    queryFn: (context) => stamped(() => accessor.list(withSignal(query, context?.signal) as never)),
  }
}

function getOptions<D extends ApiDescriptor, A>(
  client: TypedClient<D, A>,
  type: TypeName<D>,
  id: string | undefined | SkipToken,
  query: object | undefined,
): SkippableQueryOptions<unknown, unknown> {
  if (isSkip(id)) {
    return skipped(id, type, 'fetchOne')
  }
  const accessor = readsOf(client, type)
  return {
    queryKey: tag(keyFor(target(type, 'fetchOne', id), query)),
    structuralSharing: false,
    queryFn: (context) =>
      stamped(() =>
        id === undefined
          ? accessor.get(withSignal(query, context?.signal) as never)
          : accessor.get(id, withSignal(query, context?.signal) as never),
      ),
  }
}

function relationOptions<D extends ApiDescriptor, A>(
  client: TypedClient<D, A>,
  type: TypeName<D>,
  operation: 'fetchRelated' | 'fetchRelationship',
  id: string | undefined | SkipToken,
  rel: RelationName<D, TypeName<D>>,
  query: RelationReadQuery | undefined,
): SkippableQueryOptions<unknown, unknown> {
  if (isSkip(id)) {
    return skipped(id, type, operation, rel)
  }
  return {
    queryKey: tag(keyFor(target(type, operation, id, rel), query)),
    structuralSharing: false,
    queryFn: (context) =>
      stamped(() => {
        const reads = relationReads(client, type, id, rel)
        const params = withSignal(query, context?.signal)
        return operation === 'fetchRelated' ? reads.related(params) : reads.get(params)
      }),
  }
}

// ── Infinite reads ────────────────────────────────────────────────────────────────────────

type LooseInfiniteOptions = SkippableInfiniteQueryOptions<unknown, unknown, unknown>

/** A page an infinite read resolved, when it is a paginated collection carrying `$page`. */
function paged(result: unknown): { readonly $page: Page } | undefined {
  if (typeof result !== 'object' || result === null) {
    return undefined
  }
  return (result as { $page?: Page }).$page === undefined ? undefined : (result as { $page: Page })
}

const nextPageParam = (lastPage: unknown): unknown => nextPageParams(paged(lastPage))
const previousPageParam = (firstPage: unknown): unknown => prevPageParams(paged(firstPage))

/** The `page` the query starts at: its own, or `undefined` for the server's first page. */
function initialPage(query: object | undefined): unknown {
  return (query as { page?: unknown } | undefined)?.page
}

/**
 * The query reading the page `page` names, with TanStack's abort signal: `page` replaces the
 * query's whole `page`, and `undefined` leaves it out, so the server answers with its first page.
 */
function atPage<Q extends object>(
  query: Q | undefined,
  page: unknown,
  signal: AbortSignal | undefined,
): Q {
  const { page: _replaced, ...rest } = (query ?? {}) as { page?: unknown }
  return {
    ...rest,
    ...(page === undefined ? {} : { page }),
    ...(signal === undefined ? {} : { signal }),
  } as Q
}

/** Infinite options whose `queryFn` is the caller's skip token, under the skipped read's key. */
function skippedInfinite(
  token: SkipToken,
  type: string,
  operation: ReadOperation,
  rel?: string,
): LooseInfiniteOptions {
  return {
    queryKey: tag([...skippedKey(type, operation, rel), INFINITE_SEGMENT]),
    queryFn: token,
    initialPageParam: undefined,
    getNextPageParam: nextPageParam,
    getPreviousPageParam: previousPageParam,
    structuralSharing: false,
  }
}

function infiniteListOptions<D extends ApiDescriptor, A>(
  client: TypedClient<D, A>,
  type: TypeName<D>,
  query: object | SkipToken | undefined,
): LooseInfiniteOptions {
  if (isSkip(query)) {
    return skippedInfinite(query, type, 'fetchMany')
  }
  const accessor = readsOf(client, type)
  return {
    queryKey: tag(infiniteKeyFor({ type, operation: 'fetchMany' }, query)),
    structuralSharing: false,
    initialPageParam: initialPage(query),
    getNextPageParam: nextPageParam,
    getPreviousPageParam: previousPageParam,
    queryFn: ({ pageParam, signal }) =>
      stamped(() => accessor.list(atPage(query, pageParam, signal) as never)),
  }
}

function infiniteRelatedOptions<D extends ApiDescriptor, A>(
  client: TypedClient<D, A>,
  type: TypeName<D>,
  id: string | undefined | SkipToken,
  rel: RelationName<D, TypeName<D>>,
  query: RelationReadQuery | undefined,
): LooseInfiniteOptions {
  if (isSkip(id)) {
    return skippedInfinite(id, type, 'fetchRelated', rel)
  }
  return {
    queryKey: tag(infiniteKeyFor(target(type, 'fetchRelated', id, rel), query)),
    structuralSharing: false,
    initialPageParam: initialPage(query),
    getNextPageParam: nextPageParam,
    getPreviousPageParam: previousPageParam,
    queryFn: ({ pageParam, signal }) =>
      stamped(() => relationReads(client, type, id, rel).related(atPage(query, pageParam, signal))),
  }
}

// ── Standalone factories ──────────────────────────────────────────────────────────────────

/**
 * The collection-list read (`GET /{type}`): options resolving the typed `Collection`, narrowed by
 * `include`/`fields` exactly as `client.<type>.list(query)`. The key is `[type, 'fetchMany',
 * <params>]` — the normalised query rides the trailing segment, so two equal queries share a key.
 * Passing `skipToken` for the query skips the read (key `[type, 'fetchMany', { $skip: true }]`).
 */
export function listQueryOptions<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  const Inc extends readonly IncludePath<D, T>[] = [],
  const F extends FieldsMap<D> = {},
  const Pg extends ListPageParams<D, T> | undefined = undefined,
  const Cnt extends readonly CountToken<D, T>[] = [],
  C extends string = string,
>(
  client: TypedClient<D, A, C>,
  type: T,
  query?: TypedReadQuery<D, T, Inc, F, Pg, Cnt>,
): QueryOptions<ListResult<D, A, T, Inc, F, Pg, Cnt>, ReadError<C>>
export function listQueryOptions<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  const Inc extends readonly IncludePath<D, T>[] = [],
  const F extends FieldsMap<D> = {},
  const Pg extends ListPageParams<D, T> | undefined = undefined,
  const Cnt extends readonly CountToken<D, T>[] = [],
  C extends string = string,
>(
  client: TypedClient<D, A, C>,
  type: T,
  query: TypedReadQuery<D, T, Inc, F, Pg, Cnt> | SkipToken,
): SkippableQueryOptions<ListResult<D, A, T, Inc, F, Pg, Cnt>, ReadError<C>>
export function listQueryOptions<D extends ApiDescriptor, A>(
  client: TypedClient<D, A>,
  type: TypeName<D>,
  query?: object | SkipToken,
): unknown {
  return listOptions(client, type, query)
}

/**
 * The single-resource read (`GET /{type}/{id}`): options resolving the typed resource view,
 * narrowed by `include`/`fields` and counted by `withCount` as `client.<type>.get(id, query)`.
 * Key: `[type, 'fetchOne', id, <params>]` — the `id` sits at a fixed position so {@link keyFor}'s
 * prefix matches a resource's reads. A singleton (`GET /inbox`) takes `undefined` for the id and
 * reads as `client.<type>.get(query)`, keyed `[type, 'fetchOne', <params>]`. Passing `skipToken`
 * for the id skips the read (key `[type, 'fetchOne', { $skip: true }]`), as in
 * `get(id ?? skipToken)`.
 */
export function getQueryOptions<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  const Inc extends readonly IncludePath<D, T>[] = [],
  const F extends FieldsMap<D> = {},
  const Cnt extends readonly ResourceCountToken<D, T, 'fetchOne'>[] = [],
  C extends string = string,
  I extends ResourceId<D, T> | SkipToken = ResourceId<D, T>,
>(
  client: TypedClient<D, A, C>,
  type: T,
  id: I,
  query?: SingleReadQuery<D, T, Inc, F, Cnt>,
): ReadOptions<FetchOneResult<D, A, T, Inc, F, Cnt>, ReadError<C>, I> {
  return getOptions(
    client,
    type,
    id as string | undefined | SkipToken,
    query as object | undefined,
  ) as ReadOptions<FetchOneResult<D, A, T, Inc, F, Cnt>, ReadError<C>, I>
}

/**
 * The relationship-linkage read (`GET /{type}/{id}/relationships/{rel}`): options resolving the
 * materialised linkage (identifier members), via `client.<type>.id(id).rel(rel).get(query)`. Key:
 * `[type, 'fetchRelationship', id, rel, <params>]`. The result is the client's runtime linkage
 * shape; the relationship endpoint's per-relation value is loose at the `.rel(name)` boundary, so
 * the option resolves `unknown` unless the caller annotates it (parity with the client's runtime).
 * A singleton takes `undefined` for the id, keyed `[type, 'fetchRelationship', rel, <params>]`.
 * Passing `skipToken` for the id skips the read (key `[type, 'fetchRelationship',
 * { $skip: true }, rel]`).
 */
export function relationshipQueryOptions<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
  C extends string = string,
  I extends ResourceId<D, T> | SkipToken = ResourceId<D, T>,
>(
  client: TypedClient<D, A, C>,
  type: T,
  id: I,
  rel: R,
  query?: TypedRelationReadQuery<D, T, R>,
): ReadOptions<LinkageResult<D, A, T, R>, ReadError<C>, I> {
  return relationOptions(
    client,
    type,
    'fetchRelationship',
    id as string | undefined | SkipToken,
    rel,
    query,
  ) as ReadOptions<LinkageResult<D, A, T, R>, ReadError<C>, I>
}

/**
 * The related-collection read (`GET /{type}/{id}/{rel}`): options resolving the materialised
 * related resource(s), via `client.<type>.id(id).rel(rel).related(query)`. Key: `[type,
 * 'fetchRelated', id, rel, <params>]`. As with linkage, the related value is loose at the
 * `.rel(name)` boundary, so this resolves `unknown` (parity with the client runtime). A singleton
 * takes `undefined` for the id, keyed `[type, 'fetchRelated', rel, <params>]`. Passing `skipToken`
 * for the id skips the read (key `[type, 'fetchRelated', { $skip: true }, rel]`).
 */
export function relatedQueryOptions<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
  C extends string = string,
  I extends ResourceId<D, T> | SkipToken = ResourceId<D, T>,
>(
  client: TypedClient<D, A, C>,
  type: T,
  id: I,
  rel: R,
  query?: TypedRelatedReadQuery<D, T, R>,
): ReadOptions<RelatedResult<D, A, T, R>, ReadError<C>, I> {
  return relationOptions(
    client,
    type,
    'fetchRelated',
    id as string | undefined | SkipToken,
    rel,
    query as RelationReadQuery | undefined,
  ) as ReadOptions<RelatedResult<D, A, T, R>, ReadError<C>, I>
}

/**
 * The infinite collection-list read (`GET /{type}`, page after page): {@link InfiniteQueryOptions}
 * whose every page is the typed `Collection` `client.<type>.list(query)` resolves. The first page
 * is the query's own `page` (the server's first page when it has none), and each next or previous
 * page is read with the `page` params of the `next`/`prev` link. Key: `[type, 'fetchMany',
 * <params>, '$infinite']`, under the same `[type, 'fetchMany']` prefix a create or delete
 * invalidates. Passing `skipToken` for the query skips the read (key `[type, 'fetchMany',
 * { $skip: true }, '$infinite']`). A type whose paginator is `'none'` is a compile error here.
 */
export function infiniteListQueryOptions<
  D extends ApiDescriptor,
  A,
  T extends PaginatedTypeName<D>,
  const Inc extends readonly IncludePath<D, T>[] = [],
  const F extends FieldsMap<D> = {},
  const Pg extends ListPageParams<D, T> | undefined = undefined,
  const Cnt extends readonly CountToken<D, T>[] = [],
  C extends string = string,
>(
  client: TypedClient<D, A, C>,
  type: T,
  query?: TypedReadQuery<D, T, Inc, F, Pg, Cnt>,
): InfiniteQueryOptions<ListResult<D, A, T, Inc, F, Pg, Cnt>, ListPageParam<D, T>, ReadError<C>>
export function infiniteListQueryOptions<
  D extends ApiDescriptor,
  A,
  T extends PaginatedTypeName<D>,
  const Inc extends readonly IncludePath<D, T>[] = [],
  const F extends FieldsMap<D> = {},
  const Pg extends ListPageParams<D, T> | undefined = undefined,
  const Cnt extends readonly CountToken<D, T>[] = [],
  C extends string = string,
>(
  client: TypedClient<D, A, C>,
  type: T,
  query: TypedReadQuery<D, T, Inc, F, Pg, Cnt> | SkipToken,
): SkippableInfiniteQueryOptions<
  ListResult<D, A, T, Inc, F, Pg, Cnt>,
  ListPageParam<D, T>,
  ReadError<C>
>
export function infiniteListQueryOptions<D extends ApiDescriptor, A>(
  client: TypedClient<D, A>,
  type: TypeName<D>,
  query?: object | SkipToken,
): unknown {
  return infiniteListOptions(client, type, query)
}

/**
 * The infinite related-collection read (`GET /{type}/{id}/{rel}`, page after page) of a to-many
 * relation: {@link InfiniteQueryOptions} whose every page is what
 * `client.<type>.id(id).rel(rel).related(query)` resolves, paged as
 * {@link infiniteListQueryOptions} pages. Key: `[type, 'fetchRelated', id, rel, <params>,
 * '$infinite']`, under the `(parent, relation)` prefix a relationship write invalidates. A
 * singleton takes `undefined` for the id, keyed `[type, 'fetchRelated', rel, <params>,
 * '$infinite']`. Passing `skipToken` for the id skips the read (key `[type, 'fetchRelated',
 * { $skip: true }, rel, '$infinite']`). A to-one relation, or one whose related read's paginator is
 * `'none'`, is a compile error here.
 */
export function infiniteRelatedQueryOptions<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  R extends PaginatedRelationName<D, T>,
  C extends string = string,
  I extends ResourceId<D, T> | SkipToken = ResourceId<D, T>,
>(
  client: TypedClient<D, A, C>,
  type: T,
  id: I,
  rel: R,
  query?: TypedRelatedReadQuery<D, T, R, RelationPageParams<D, T, R>>,
): InfiniteReadOptions<RelatedResult<D, A, T, R>, RelatedPageParam<D, T, R>, ReadError<C>, I> {
  return infiniteRelatedOptions(
    client,
    type,
    id as string | undefined | SkipToken,
    rel,
    query as RelationReadQuery | undefined,
  ) as InfiniteReadOptions<RelatedResult<D, A, T, R>, RelatedPageParam<D, T, R>, ReadError<C>, I>
}

// ── Bound per-type API (sugar over the standalone factories) ──────────────────────────────

/**
 * The per-type read-option factories, with `client`/`type` pre-applied (`api.<type>.list(...)`).
 * `E` is the read's error. Each id (and a list's query) accepts `skipToken`. A type whose paginator
 * is `'none'` has no `infinite`, since its collection has no pages.
 */
export type TypeQueryApi<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  E = ReadError,
> = TypeReadQueryApi<D, A, T, E> &
  ([D[T]['paginator']] extends ['none'] ? {} : InfiniteListQueryApi<D, A, T, E>)

/** The read-option factories every collection type has; see {@link TypeQueryApi}. */
export interface TypeReadQueryApi<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  E = ReadError,
> {
  list<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Pg extends ListPageParams<D, T> | undefined = undefined,
    const Cnt extends readonly CountToken<D, T>[] = [],
  >(
    query?: TypedReadQuery<D, T, Inc, F, Pg, Cnt>,
  ): QueryOptions<ListResult<D, A, T, Inc, F, Pg, Cnt>, E>
  list<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Pg extends ListPageParams<D, T> | undefined = undefined,
    const Cnt extends readonly CountToken<D, T>[] = [],
  >(
    query: TypedReadQuery<D, T, Inc, F, Pg, Cnt> | SkipToken,
  ): SkippableQueryOptions<ListResult<D, A, T, Inc, F, Pg, Cnt>, E>
  get<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Cnt extends readonly ResourceCountToken<D, T, 'fetchOne'>[] = [],
    I extends string | SkipToken = string,
  >(
    id: I,
    query?: SingleReadQuery<D, T, Inc, F, Cnt>,
  ): ReadOptions<FetchOneResult<D, A, T, Inc, F, Cnt>, E, I>
  relationship<R extends RelationName<D, T>, I extends string | SkipToken = string>(
    id: I,
    rel: R,
    query?: TypedRelationReadQuery<D, T, R>,
  ): ReadOptions<LinkageResult<D, A, T, R>, E, I>
  related<R extends RelationName<D, T>, I extends string | SkipToken = string>(
    id: I,
    rel: R,
    query?: TypedRelatedReadQuery<D, T, R>,
  ): ReadOptions<RelatedResult<D, A, T, R>, E, I>
  /** The infinite related read of a to-many relation; see {@link infiniteRelatedQueryOptions}. */
  relatedInfinite<R extends PaginatedRelationName<D, T>, I extends string | SkipToken = string>(
    id: I,
    rel: R,
    query?: TypedRelatedReadQuery<D, T, R, RelationPageParams<D, T, R>>,
  ): InfiniteReadOptions<RelatedResult<D, A, T, R>, RelatedPageParam<D, T, R>, E, I>
}

/** The infinite list read of a type whose collection paginates; see {@link TypeQueryApi}. */
export interface InfiniteListQueryApi<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  E = ReadError,
> {
  /** The infinite list read; see {@link infiniteListQueryOptions}. */
  infinite<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Pg extends ListPageParams<D, T> | undefined = undefined,
    const Cnt extends readonly CountToken<D, T>[] = [],
  >(
    query?: TypedReadQuery<D, T, Inc, F, Pg, Cnt>,
  ): InfiniteQueryOptions<ListResult<D, A, T, Inc, F, Pg, Cnt>, ListPageParam<D, T>, E>
  infinite<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Pg extends ListPageParams<D, T> | undefined = undefined,
    const Cnt extends readonly CountToken<D, T>[] = [],
  >(
    query: TypedReadQuery<D, T, Inc, F, Pg, Cnt> | SkipToken,
  ): SkippableInfiniteQueryOptions<ListResult<D, A, T, Inc, F, Pg, Cnt>, ListPageParam<D, T>, E>
}

/**
 * A singleton's read-option factories (`api.inboxes.get(query)`), which take no id, as the
 * client's singleton accessor doesn't. Passing `skipToken` for the query skips the read.
 */
export interface SingletonQueryApi<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  E = ReadError,
> {
  get<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Cnt extends readonly ResourceCountToken<D, T, 'fetchOne'>[] = [],
  >(
    query?: SingleReadQuery<D, T, Inc, F, Cnt>,
  ): QueryOptions<FetchOneResult<D, A, T, Inc, F, Cnt>, E>
  get<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Cnt extends readonly ResourceCountToken<D, T, 'fetchOne'>[] = [],
  >(
    query: SingleReadQuery<D, T, Inc, F, Cnt> | SkipToken,
  ): SkippableQueryOptions<FetchOneResult<D, A, T, Inc, F, Cnt>, E>
  relationship<R extends RelationName<D, T>>(
    rel: R,
    query?: TypedRelationReadQuery<D, T, R>,
  ): QueryOptions<LinkageResult<D, A, T, R>, E>
  relationship<R extends RelationName<D, T>>(
    rel: R,
    query: TypedRelationReadQuery<D, T, R> | SkipToken,
  ): SkippableQueryOptions<LinkageResult<D, A, T, R>, E>
  related<R extends RelationName<D, T>>(
    rel: R,
    query?: TypedRelatedReadQuery<D, T, R>,
  ): QueryOptions<RelatedResult<D, A, T, R>, E>
  related<R extends RelationName<D, T>>(
    rel: R,
    query: TypedRelatedReadQuery<D, T, R> | SkipToken,
  ): SkippableQueryOptions<RelatedResult<D, A, T, R>, E>
  /** The infinite related read of a to-many relation; see {@link infiniteRelatedQueryOptions}. */
  relatedInfinite<R extends PaginatedRelationName<D, T>>(
    rel: R,
    query?: TypedRelatedReadQuery<D, T, R, RelationPageParams<D, T, R>>,
  ): InfiniteQueryOptions<RelatedResult<D, A, T, R>, RelatedPageParam<D, T, R>, E>
  relatedInfinite<R extends PaginatedRelationName<D, T>>(
    rel: R,
    query: TypedRelatedReadQuery<D, T, R, RelationPageParams<D, T, R>> | SkipToken,
  ): SkippableInfiniteQueryOptions<RelatedResult<D, A, T, R>, RelatedPageParam<D, T, R>, E>
}

/**
 * The bound query API: one {@link TypeQueryApi} per wire type (`api.albums.list(...)`), or a
 * {@link SingletonQueryApi} for a singleton type. `C` is the client's error-code union.
 */
export type QueryApi<D extends ApiDescriptor, A, C extends string = string> = {
  [T in TypeName<D>]: D[T] extends { singleton: true }
    ? SingletonQueryApi<D, A, T, ReadError<C>>
    : TypeQueryApi<D, A, T, ReadError<C>>
}

/**
 * Bind a client to its per-type read-option factories: `createQueryApi(client).albums.list(query)`
 * returns the same options as `listQueryOptions(client, 'albums', query)`, with `client`/`type`
 * pre-applied. A Proxy (descriptor-free — type validity is enforced by the static `QueryApi` shape) so
 * no per-type allocation until first access.
 *
 * `options.scope` scopes every read, for a server sharing the QueryClient with another: each key is
 * led by `{ $scope }`, so the server's queries are normalised only by the descriptor installed for
 * that scope. The standalone factories take {@link withScope} instead.
 */
export function createQueryApi<D extends ApiDescriptor, A, C extends string = string>(
  client: TypedClient<D, A, C>,
  options: ScopeOption = {},
): QueryApi<D, A, C> {
  return scopeApi(unscopedQueryApi(client), options.scope)
}

/** The bound read API, unscoped. */
function unscopedQueryApi<D extends ApiDescriptor, A, C extends string = string>(
  client: TypedClient<D, A, C>,
): QueryApi<D, A, C> {
  const cache = new Map<string, LooseTypeQueryApi | LooseSingletonQueryApi>()
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
  }) as QueryApi<D, A, C>
}

type LooseOptions = SkippableQueryOptions<unknown, unknown>

/** One type's bound factories as built at runtime; the static `QueryApi` shape types them. */
interface LooseTypeQueryApi {
  list(query?: unknown): LooseOptions
  get(id: string | SkipToken, query?: unknown): LooseOptions
  relationship(id: string | SkipToken, rel: string, query?: unknown): LooseOptions
  related(id: string | SkipToken, rel: string, query?: unknown): LooseOptions
  infinite(query?: unknown): LooseInfiniteOptions
  relatedInfinite(id: string | SkipToken, rel: string, query?: unknown): LooseInfiniteOptions
}

/** A singleton's bound factories as built at runtime. */
interface LooseSingletonQueryApi {
  get(query?: unknown): LooseOptions
  relationship(rel: string, query?: unknown): LooseOptions
  related(rel: string, query?: unknown): LooseOptions
  relatedInfinite(rel: string, query?: unknown): LooseInfiniteOptions
}

/** Build one type's bound read-option factories (shares the standalone factories' builders). */
function typeQueryApi<D extends ApiDescriptor, A>(
  client: TypedClient<D, A>,
  type: TypeName<D>,
): LooseTypeQueryApi {
  type Rel = RelationName<D, TypeName<D>>
  return {
    list: (query) => listOptions(client, type, query as object | SkipToken),
    get: (id, query) => getOptions(client, type, id, query as object),
    relationship: (id, rel, query) =>
      relationOptions(
        client,
        type,
        'fetchRelationship',
        id,
        rel as Rel,
        query as RelationReadQuery,
      ),
    related: (id, rel, query) =>
      relationOptions(client, type, 'fetchRelated', id, rel as Rel, query as RelationReadQuery),
    infinite: (query) => infiniteListOptions(client, type, query as object | SkipToken),
    relatedInfinite: (id, rel, query) =>
      infiniteRelatedOptions(client, type, id, rel as Rel, query as RelationReadQuery),
  }
}

/** A singleton read's address: `skipToken` (where a resource's id would go) when it is skipped. */
function singletonAt(query: unknown): undefined | SkipToken {
  return isSkip(query) ? query : undefined
}

/** A singleton read's query, or none when it is skipped. */
function singletonParams(query: unknown): RelationReadQuery | undefined {
  return isSkip(query) ? undefined : (query as RelationReadQuery | undefined)
}

/**
 * Build a singleton's bound read-option factories, which address it with no id; `skipToken` in
 * place of the query skips the read.
 */
function singletonQueryApi<D extends ApiDescriptor, A>(
  client: TypedClient<D, A>,
  type: TypeName<D>,
): LooseSingletonQueryApi {
  type Rel = RelationName<D, TypeName<D>>
  return {
    get: (query) => getOptions(client, type, singletonAt(query), singletonParams(query) as object),
    relationship: (rel, query) =>
      relationOptions(
        client,
        type,
        'fetchRelationship',
        singletonAt(query),
        rel as Rel,
        singletonParams(query),
      ),
    related: (rel, query) =>
      relationOptions(
        client,
        type,
        'fetchRelated',
        singletonAt(query),
        rel as Rel,
        singletonParams(query),
      ),
    relatedInfinite: (rel, query) =>
      infiniteRelatedOptions(client, type, singletonAt(query), rel as Rel, singletonParams(query)),
  }
}
