/**
 * Mutation OPTION FACTORIES over the client write surface (docs/tanstack-query.md).
 *
 * Each factory returns a plain `{ mutationKey, mutationFn, meta }` object structurally compatible
 * with `@tanstack/query-core` — the user passes it to their framework's `useMutation` /
 * `injectMutation`, or to a `MutationObserver`/`mutationCache.build(...)`. The binding depends only
 * on `query-core` (framework-agnostic) and preserves the client's full static narrowing on the
 * variables (create/update input) and the resolved result.
 *
 * A factory sets no lifecycle callbacks. Its cache upkeep (normalization on success, invalidation
 * on settle, the optimistic change and its rollback) is described as plain data in
 * `meta[JSON_API_PLAN]` and carried out by {@link JsonApiMutationCache}, which the QueryClient must
 * be built with; see ./upkeep.ts for what each verb does. So the `onMutate`/`onError`/`onSuccess`/
 * `onSettled` an app spreads alongside are its own, and never replace the upkeep.
 */
import {
  type ApiDescriptor,
  type AtomicRecorder,
  type AtomicResult,
  type CreateInput,
  type CreateMethod,
  type DeleteArgs,
  type DeleteResult,
  type DocumentMetaOperation,
  type FieldsMap,
  type IncludePath,
  type LinkageRef,
  type MetaOption,
  type OperationMeta,
  type OptionsArg,
  type ReadResult,
  type RelationName,
  type RequestMetaOf,
  type RequiresRequestMeta,
  type ResourceCountToken,
  type SingletonUpdateInput,
  type TypeName,
  type UpdateInput,
  type UpdateMethod,
  type WaitedWriteResult,
  type WaitValue,
  type WithDocumentMeta,
  type WriteOptions,
} from '@haddowg/json-api-client'
import type { MutationFunctionContext, QueryClient } from '@tanstack/query-core'
import { assertUpkeepRuns } from './mutation-cache'
import type { ResourceId } from './read'
import {
  JSON_API_PLAN,
  type JsonApiMutationMeta,
  type JsonApiMutationPlan,
  type JsonApiResourceVerb,
  planKey,
} from './upkeep'

/**
 * A TanStack-compatible mutation-options object: the mutation's key, its async `mutationFn`, and
 * the `meta` carrying the plan {@link JsonApiMutationCache} runs the cache upkeep from. It sets no
 * lifecycle callbacks, so the app spreads in its own (`retry`, `onSuccess`, …) freely. Structurally
 * assignable to `query-core`'s `MutationOptions` and the framework adapters' `useMutation` /
 * `injectMutation` options, so the binding needn't re-export query-core's option type.
 *
 * Replace `meta` only by merging with this one (`meta: { ...options.meta, mine }`): a mutation whose
 * plan is gone throws rather than skip its upkeep.
 *
 * `TData` is the resolved result and `TVars` the input the caller passes to `mutate(vars)`.
 */
export interface MutationOptions<TData, TVars> {
  /** `[type, verb, id?, rel?]`, as {@link mutationKeyFor} builds it (`['$atomic']` for a batch). */
  mutationKey: readonly string[]
  mutationFn: (variables: TVars, context: MutationFunctionContext) => Promise<TData>
  meta: JsonApiMutationMeta
}

/** The options of a plan's mutation, its `mutationFn` refusing to run where the upkeep can't. */
function planned<TData, TVars>(
  plan: JsonApiMutationPlan,
  run: (variables: TVars) => Promise<TData>,
): MutationOptions<TData, TVars> {
  return {
    mutationKey: planKey(plan),
    mutationFn: (variables, context) => {
      assertUpkeepRuns(context)
      return run(variables)
    },
    meta: { [JSON_API_PLAN]: plan },
  }
}

/** The plan of a write on `type`, leaving out the members it doesn't have. */
function resourcePlan(
  verb: JsonApiResourceVerb,
  type: string,
  id: string | undefined,
  rel: string | undefined,
  optimistic: boolean,
): JsonApiMutationPlan {
  return {
    verb,
    type,
    ...(id === undefined ? {} : { id }),
    ...(rel === undefined ? {} : { rel }),
    optimistic,
  }
}

/**
 * The resource a create or update resolves to, its `$document.meta` typed by the members the
 * write's document declares.
 */
type WriteResource<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[],
  F,
  Cnt extends readonly string[],
  Op extends DocumentMetaOperation,
> = WithDocumentMeta<ReadResult<D, A, T, Inc, F, Cnt[number]>, OperationMeta<D, T, Op>>

/** The loose relationship mutations a handle offers at the `.rel(name)` boundary. */
interface RelationWrites {
  add(refs: readonly LinkageRef<string>[], opts?: LooseMetaOpts): Promise<unknown>
  remove(refs: readonly LinkageRef<string>[], opts?: LooseMetaOpts): Promise<unknown>
  replace(refs: readonly LinkageRef<string>[], opts?: LooseMetaOpts): Promise<unknown>
  set(ref: LinkageRef<string> | null, opts?: LooseMetaOpts): Promise<unknown>
}

/** The `meta` option a write sends, untyped. */
interface LooseMetaOpts {
  meta?: Readonly<Record<string, unknown>>
}

/**
 * The request `meta` a mutation factory sends with each call: the object itself, or a function
 * building it from the call's variables, so each call can send its own, such as an idempotency key.
 */
export type MutationMeta<M, V> = M | ((variables: V) => M)

/**
 * The `meta` option of a mutation factory whose write declares request `meta` `M`, as
 * {@link MetaOption} types it for the client call, given as a {@link MutationMeta}.
 */
export type MutationMetaOption<M, V> =
  MetaOption<M> extends { meta: infer Value }
    ? { meta: MutationMeta<Value, V> }
    : MetaOption<M> extends { meta?: infer Value }
      ? { meta?: MutationMeta<NonNullable<Value>, V> }
      : never

/** The options a client write is called with: the factory's, with its `meta` built for `variables`. */
function callOptions<O extends { meta?: unknown }>(
  opts: O | undefined,
  variables: unknown,
): O | undefined {
  if (typeof opts?.meta !== 'function') {
    return opts
  }
  return { ...opts, meta: (opts.meta as (variables: unknown) => unknown)(variables) }
}

/** A collection type's write accessor. */
interface TypeWrites<D extends ApiDescriptor, A, W, T extends TypeName<D>> {
  create: CreateMethod<D, A, W, T>
  id(id: string): {
    update: UpdateMethod<D, A, W, T>
    delete(...opts: DeleteArgs<D, T>): Promise<DeleteResult<D, T>>
    rel(name: RelationName<D, T>): RelationWrites
  }
}

/** A singleton's write accessor: an update taking the id in its input, and its relations. */
interface SingletonWrites<D extends ApiDescriptor, A, W, T extends TypeName<D>> {
  update: UpdateMethod<D, A, W, T, SingletonUpdateInput<D, W, T>>
  rel(name: RelationName<D, T>): RelationWrites
}

/** A client narrowed to the per-type write methods the mutation factories drive. */
type WriteClient<D extends ApiDescriptor, A, W> = {
  [T in TypeName<D>]: D[T] extends { singleton: true }
    ? SingletonWrites<D, A, W, T>
    : TypeWrites<D, A, W, T>
}

/** The accessor of `type`, read as a collection type's or a singleton's. */
function writesOf<D extends ApiDescriptor, A, W, T extends TypeName<D>>(
  client: WriteClient<D, A, W>,
  type: T,
): TypeWrites<D, A, W, T> & SingletonWrites<D, A, W, T> {
  return client[type] as unknown as TypeWrites<D, A, W, T> & SingletonWrites<D, A, W, T>
}

/** The relationship mutations of a resource, or of a singleton when `id` is `undefined`. */
function relationWrites<D extends ApiDescriptor, A, W, T extends TypeName<D>>(
  client: WriteClient<D, A, W>,
  type: T,
  id: string | undefined,
  rel: RelationName<D, T>,
): RelationWrites {
  const accessor = writesOf(client, type)
  return id === undefined ? accessor.rel(rel) : accessor.id(id).rel(rel)
}

/**
 * The input an update of type `T` takes: its {@link UpdateInput}, with the resource's `id` for a
 * singleton, whose path carries none.
 */
export type UpdateVariables<D extends ApiDescriptor, W, T extends TypeName<D>> = D[T] extends {
  singleton: true
}
  ? SingletonUpdateInput<D, W, T>
  : UpdateInput<D, W, T>

// ── Create / update / delete ──────────────────────────────────────────────────────────────

// A create or update called through a client whose method type is still a deferred conditional.
type LooseWrite = (body: unknown, opts?: unknown) => Promise<unknown>

/**
 * The write options a create or update mutation takes: `include`/`fields`, the `withCount` write
 * `Op` advertises, and `wait` for a write that declares a `202`.
 */
export type WriteMutationOpts<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[] = [],
  F extends FieldsMap<D> = FieldsMap<D>,
  Wt = undefined,
  Op extends 'create' | 'update' = 'create',
  Cnt extends readonly ResourceCountToken<D, T, Op>[] = readonly ResourceCountToken<D, T, Op>[],
  V = unknown,
> = WriteOptions<D, T, Inc, F, Op, Cnt> & { wait?: Wt } & MutationMetaOption<
    RequestMetaOf<D, T, Op>,
    V
  >

/**
 * The create mutation (`POST /{type}`), keyed `[type, 'create']`: `mutationFn` runs
 * `client.<type>.create(input, opts)`. Its upkeep normalizes the fresh resource on success, so any
 * query already holding it reflects it, and invalidates the type's lists on settle (a new member
 * changes collection membership, which a patch can't insert). A create that declares a `202` may
 * resolve to an `Accepted` job instead, which is not normalized, unless `wait` polls it.
 *
 * No optimistic insert: inserting into the right cached lists requires knowing each list's
 * sort/filter/page, which is list-specific, so the lists are invalidated instead.
 *
 * @param queryClient Deprecated and ignored: the upkeep runs on the QueryClient the mutation runs
 * on. Kept so existing calls compile; it will be removed in a future major.
 */
export function createMutationOptions<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
  const Inc extends readonly IncludePath<D, T>[] = [],
  const F extends FieldsMap<D> = {},
  const Wt extends WaitValue<D, T, 'create'> = undefined,
  const Cnt extends readonly ResourceCountToken<D, T, 'create'>[] = [],
>(
  queryClient: QueryClient,
  client: WriteClient<D, A, W>,
  descriptor: D,
  type: T,
  ...[opts]: OptionsArg<
    RequiresRequestMeta<RequestMetaOf<D, T, 'create'>>,
    WriteMutationOpts<D, T, Inc, F, Wt, 'create', Cnt, CreateInput<D, W, T>>
  >
): MutationOptions<
  WaitedWriteResult<D, A, T, 'create', WriteResource<D, A, T, Inc, F, Cnt, 'create'>, Wt>,
  CreateInput<D, W, T>
> {
  const accessor = writesOf(client, type)
  return planned(
    resourcePlan('create', type, undefined, undefined, false),
    (input: CreateInput<D, W, T>) =>
      (accessor.create as LooseWrite)(input, callOptions(opts, input)) as Promise<
        WaitedWriteResult<D, A, T, 'create', WriteResource<D, A, T, Inc, F, Cnt, 'create'>, Wt>
      >,
  )
}

/**
 * The update mutation (`PATCH /{type}/{id}`), keyed `[type, 'update', id]`: `mutationFn` runs
 * `client.<type>.id(id).update(patch, opts)`. An update only changes a node's attributes/linkage,
 * so its upkeep PATCHES the result across the cache via `normalize` on success (no refetch). When
 * optimistic, the patch's attributes (those keys that are declared attributes of the type —
 * relation slots are skipped) are applied through the normalized patch before the write and
 * restored on error. An update that declares a `202` may resolve to an `Accepted` job, which is not
 * normalized, unless `wait` polls it.
 *
 * A singleton (`PATCH /inbox`) takes `undefined` for the id, is keyed `[type, 'update']`, and runs
 * `client.<type>.update(input)`, whose input carries the resource's `id` for the body.
 *
 * `optimistic` applies the patch's attributes immediately (rolled back on error). Default off.
 *
 * @param queryClient Deprecated and ignored: the upkeep runs on the QueryClient the mutation runs
 * on. Kept so existing calls compile; it will be removed in a future major.
 */
export function updateMutationOptions<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
  const Inc extends readonly IncludePath<D, T>[] = [],
  const F extends FieldsMap<D> = {},
  const Wt extends WaitValue<D, T, 'update'> = undefined,
  const Cnt extends readonly ResourceCountToken<D, T, 'update'>[] = [],
>(
  queryClient: QueryClient,
  client: WriteClient<D, A, W>,
  descriptor: D,
  type: T,
  id: ResourceId<D, T>,
  ...[opts]: OptionsArg<
    RequiresRequestMeta<RequestMetaOf<D, T, 'update'>>,
    UpdateMutationOpts<D, T, Inc, F, Wt, Cnt, UpdateVariables<D, W, T>>
  >
): MutationOptions<
  WaitedWriteResult<D, A, T, 'update', WriteResource<D, A, T, Inc, F, Cnt, 'update'>, Wt>,
  UpdateVariables<D, W, T>
> {
  const accessor = writesOf(client, type)
  const resource: string | undefined = id
  return planned(
    resourcePlan('update', type, resource, undefined, opts?.optimistic === true),
    (patch: UpdateVariables<D, W, T>) =>
      ((resource === undefined ? accessor.update : accessor.id(resource).update) as LooseWrite)(
        patch,
        callOptions(opts, patch),
      ) as Promise<
        WaitedWriteResult<D, A, T, 'update', WriteResource<D, A, T, Inc, F, Cnt, 'update'>, Wt>
      >,
  )
}

/**
 * The options of a delete mutation whose request document declares its `meta`: that `meta`,
 * required when a member is. A delete declaring none takes none.
 */
export type DeleteMutationArgs<D extends ApiDescriptor, T extends TypeName<D>> = [
  RequestMetaOf<D, T, 'delete'>,
] extends [never]
  ? []
  : OptionsArg<
      RequiresRequestMeta<RequestMetaOf<D, T, 'delete'>>,
      MutationMetaOption<RequestMetaOf<D, T, 'delete'>, void>
    >

/**
 * The delete mutation (`DELETE /{type}/{id}`), keyed `[type, 'delete', id]`: `mutationFn` runs
 * `client.<type>.id(id).delete()` (resolves the `meta` of the meta-only `200` the delete declares,
 * else `void`), with the request `meta` a delete declaring it takes. Its upkeep invalidates the
 * type's lists AND that resource's reads on settle (a delete changes collection membership and
 * orphans the resource's `get`).
 *
 * @param queryClient Deprecated and ignored: the upkeep runs on the QueryClient the mutation runs
 * on. Kept so existing calls compile; it will be removed in a future major.
 */
export function deleteMutationOptions<D extends ApiDescriptor, A, W, T extends TypeName<D>>(
  queryClient: QueryClient,
  client: WriteClient<D, A, W>,
  type: T,
  id: string,
  ...[opts]: DeleteMutationArgs<D, T>
): MutationOptions<DeleteResult<D, T>, void> {
  const accessor = writesOf(client, type)
  const remove = accessor.id(id).delete as (opts?: unknown) => Promise<DeleteResult<D, T>>
  return planned(resourcePlan('delete', type, id, undefined, false), () =>
    remove(callOptions(opts as { meta?: unknown } | undefined, undefined)),
  )
}

// ── Relationship mutations ──────────────────────────────────────────────────────────────────

/** Options for a relationship mutation: opt into an optimistic membership/linkage patch (default off). */
export interface RelationshipMutationOpts<V = never> {
  /**
   * Apply the membership change to the parent's cached related/relationship reads immediately
   * (by key prefix — every page variant), snapshotting for automatic rollback on error. The
   * relation subtree is still invalidated on settle so the server reconciles. Default off (a plain
   * invalidate-on-settle). An optimistic `add` appends bare identifier members (`{type,id}` + any
   * `$pivot` on the ref) — the settle refetch replaces them with the fully-hydrated resources.
   */
  optimistic?: boolean
  /**
   * The top-level `meta` the write sends, for a relation whose write declares it: the object, or a
   * function building it from the call's refs.
   */
  meta?: MutationMeta<Readonly<Record<string, unknown>>, V>
}

/** True when `opts` requests the optimistic membership patch. */
const isOptimistic = <V>(opts?: RelationshipMutationOpts<V>): boolean => opts?.optimistic === true

/**
 * A to-one relationship `set` (`PATCH …/relationships/{rel}` with a single ref or `null`), keyed
 * `[type, 'set', id, rel]`: `mutationFn` runs `client.<type>.id(id).rel(rel).set(ref)`. A `set`
 * changes which resource the to-one points at — linkage, not collection membership and not a node
 * attribute — so its upkeep normalizes the response (linkage) on success and invalidates the
 * PARENT's reads of the relation, and the parent itself, on settle. When optimistic, the parent's
 * cached relationship/related reads swap to the new single value (or `null`) before the write and
 * roll back on error.
 *
 * @param queryClient Deprecated and ignored: the upkeep runs on the QueryClient the mutation runs
 * on. Kept so existing calls compile; it will be removed in a future major.
 */
export function setRelationshipMutationOptions<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
>(
  queryClient: QueryClient,
  client: WriteClient<D, A, W>,
  descriptor: D,
  type: T,
  id: ResourceId<D, T>,
  rel: RelationName<D, T>,
  opts?: RelationshipMutationOpts<LinkageRef<string> | null>,
): MutationOptions<unknown, LinkageRef<string> | null> {
  return planned(
    resourcePlan('set', type, id, rel, isOptimistic(opts)),
    (ref: LinkageRef<string> | null) =>
      relationWrites(client, type, id, rel).set(ref, callOptions(opts, ref) as LooseMetaOpts),
  )
}

/**
 * A to-many relationship `replace` (`PATCH …/relationships/{rel}` with the full new set), keyed
 * `[type, 'replace', id, rel]`: `mutationFn` runs `client.<type>.id(id).rel(rel).replace(refs)`. A
 * full replacement resets the relation's membership, so its upkeep normalizes the response (the
 * new linkage) on success and invalidates the parent's reads of the relation on settle. When
 * optimistic, the cached membership is swapped to `refs` and rolled back on error.
 *
 * @param queryClient Deprecated and ignored: the upkeep runs on the QueryClient the mutation runs
 * on. Kept so existing calls compile; it will be removed in a future major.
 */
export function replaceRelationshipMutationOptions<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
>(
  queryClient: QueryClient,
  client: WriteClient<D, A, W>,
  descriptor: D,
  type: T,
  id: ResourceId<D, T>,
  rel: RelationName<D, T>,
  opts?: RelationshipMutationOpts<readonly LinkageRef<string>[]>,
): MutationOptions<unknown, readonly LinkageRef<string>[]> {
  return planned(
    resourcePlan('replace', type, id, rel, isOptimistic(opts)),
    (refs: readonly LinkageRef<string>[]) =>
      relationWrites(client, type, id, rel).replace(refs, callOptions(opts, refs) as LooseMetaOpts),
  )
}

/**
 * A to-many relationship `add` (`POST …/relationships/{rel}`), keyed `[type, 'add', id, rel]`:
 * `mutationFn` runs `client.<type>.id(id).rel(rel).add(refs)`. Adding changes the relation's
 * membership, so its upkeep invalidates the parent's reads of the relation on settle (a patch can't
 * insert linkage members). When optimistic, the added refs are appended to the cached membership
 * (deduplicated by `type:id`) and rolled back on error.
 *
 * @param queryClient Deprecated and ignored: the upkeep runs on the QueryClient the mutation runs
 * on. Kept so existing calls compile; it will be removed in a future major.
 */
export function addRelationshipMutationOptions<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
>(
  queryClient: QueryClient,
  client: WriteClient<D, A, W>,
  type: T,
  id: ResourceId<D, T>,
  rel: RelationName<D, T>,
  opts?: RelationshipMutationOpts<readonly LinkageRef<string>[]>,
): MutationOptions<unknown, readonly LinkageRef<string>[]> {
  return planned(
    resourcePlan('add', type, id, rel, isOptimistic(opts)),
    (refs: readonly LinkageRef<string>[]) =>
      relationWrites(client, type, id, rel).add(refs, callOptions(opts, refs) as LooseMetaOpts),
  )
}

/**
 * A to-many relationship `remove` (`DELETE …/relationships/{rel}`), keyed
 * `[type, 'remove', id, rel]`: `mutationFn` runs `client.<type>.id(id).rel(rel).remove(refs)`.
 * Removing changes the relation's membership, so its upkeep invalidates the parent's reads of the
 * relation on settle. When optimistic, the removed refs are dropped from the cached membership and
 * rolled back on error.
 *
 * @param queryClient Deprecated and ignored: the upkeep runs on the QueryClient the mutation runs
 * on. Kept so existing calls compile; it will be removed in a future major.
 */
export function removeRelationshipMutationOptions<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
>(
  queryClient: QueryClient,
  client: WriteClient<D, A, W>,
  type: T,
  id: ResourceId<D, T>,
  rel: RelationName<D, T>,
  opts?: RelationshipMutationOpts<readonly LinkageRef<string>[]>,
): MutationOptions<unknown, readonly LinkageRef<string>[]> {
  return planned(
    resourcePlan('remove', type, id, rel, isOptimistic(opts)),
    (refs: readonly LinkageRef<string>[]) =>
      relationWrites(client, type, id, rel).remove(refs, callOptions(opts, refs) as LooseMetaOpts),
  )
}

// ── Atomic (a thin passthrough) ─────────────────────────────────────────────────────────────

/**
 * A thin atomic-batch mutation (`POST /operations`), keyed `['$atomic']`: `mutationFn` forwards the
 * `build` callback to `client.atomic(build)`. The variables are the build callback, which may
 * record any operation and return anything, and the result is the loose, ordered `AtomicResult[]`.
 * Its upkeep runs the materialised results through `normalize` on success so any updated resource
 * patches across the cache.
 *
 * INVALIDATION is the caller's responsibility for atomic: a batch can mix creates/updates/deletes
 * across many types, and the recorded ops aren't enumerable after the build runs, so the binding
 * can't know which list subtrees changed membership. Updates self-heal via the success
 * normalization; for a batch that creates/deletes, add an `onSettled` that invalidates the
 * affected `operationKey(type, 'fetchMany')` subtrees (or `queryClient.invalidateQueries()` for a
 * blanket refetch). Kept deliberately minimal — atomic is an escape hatch, not a normalized path.
 *
 * @param queryClient Deprecated and ignored: the upkeep runs on the QueryClient the mutation runs
 * on. Kept so existing calls compile; it will be removed in a future major.
 * @param _descriptor The descriptor, which types the batch's recorder.
 */
export function atomicMutationOptions<D extends ApiDescriptor, A, W>(
  queryClient: QueryClient,
  client: WriteClient<D, A, W>,
  _descriptor: D,
): MutationOptions<AtomicResult[], (tx: AtomicRecorder<D, W>) => unknown> {
  return planned({ verb: 'atomic' }, (build) =>
    // The client's `atomic` carries the precise per-op return type; the binding's loose
    // `AtomicResult[]` result is the common supertype (a caller wanting the positional tuple
    // calls `client.atomic` directly — the binding's value is the cache normalization).
    (client as unknown as { atomic: (b: unknown) => Promise<AtomicResult[]> }).atomic(build),
  )
}

// ── Bound per-type mutation API (sugar over the standalone factories) ────────────────────────

/**
 * Extra options for an `update(...)` mutation: the write `include`/`fields`, the update's
 * `withCount`, `wait` for an update that declares a `202`, plus the optimistic toggle.
 */
export type UpdateMutationOpts<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[] = [],
  F extends FieldsMap<D> = FieldsMap<D>,
  Wt = undefined,
  Cnt extends readonly ResourceCountToken<D, T, 'update'>[] = readonly ResourceCountToken<
    D,
    T,
    'update'
  >[],
  V = unknown,
> = WriteMutationOpts<D, T, Inc, F, Wt, 'update', Cnt, V> & { optimistic?: boolean }

/**
 * The relationship-mutation option factories for one relation (`api.<type>.id(id).rel(rel).add(...)`).
 * Refs are typed loosely (`LinkageRef<string>`) at the `.rel(name)` boundary — parity with the
 * read API, whose per-relation value is also loose there (the related type isn't recoverable from
 * the relation name alone in the bound surface). Each accepts an optional
 * {@link RelationshipMutationOpts} to opt into the optimistic membership/linkage patch.
 */
export interface RelationMutationApi {
  add(
    opts?: RelationshipMutationOpts<readonly LinkageRef<string>[]>,
  ): MutationOptions<unknown, readonly LinkageRef<string>[]>
  remove(
    opts?: RelationshipMutationOpts<readonly LinkageRef<string>[]>,
  ): MutationOptions<unknown, readonly LinkageRef<string>[]>
  replace(
    opts?: RelationshipMutationOpts<readonly LinkageRef<string>[]>,
  ): MutationOptions<unknown, readonly LinkageRef<string>[]>
  set(
    opts?: RelationshipMutationOpts<LinkageRef<string> | null>,
  ): MutationOptions<unknown, LinkageRef<string> | null>
}

/** The id-scoped mutation option factories (`api.<type>.id(id).update(...)` etc.). */
export interface HandleMutationApi<D extends ApiDescriptor, A, W, T extends TypeName<D>> {
  update<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Wt extends WaitValue<D, T, 'update'> = undefined,
    const Cnt extends readonly ResourceCountToken<D, T, 'update'>[] = [],
  >(
    ...opts: OptionsArg<
      RequiresRequestMeta<RequestMetaOf<D, T, 'update'>>,
      UpdateMutationOpts<D, T, Inc, F, Wt, Cnt, UpdateInput<D, W, T>>
    >
  ): MutationOptions<
    WaitedWriteResult<D, A, T, 'update', WriteResource<D, A, T, Inc, F, Cnt, 'update'>, Wt>,
    UpdateInput<D, W, T>
  >
  delete(...opts: DeleteMutationArgs<D, T>): MutationOptions<DeleteResult<D, T>, void>
  rel(name: RelationName<D, T>): RelationMutationApi
}

/** The per-type mutation option factories, with `queryClient`/`client`/`descriptor`/`type` pre-applied. */
export interface TypeMutationApi<D extends ApiDescriptor, A, W, T extends TypeName<D>> {
  create<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Wt extends WaitValue<D, T, 'create'> = undefined,
    const Cnt extends readonly ResourceCountToken<D, T, 'create'>[] = [],
  >(
    ...opts: OptionsArg<
      RequiresRequestMeta<RequestMetaOf<D, T, 'create'>>,
      WriteMutationOpts<D, T, Inc, F, Wt, 'create', Cnt, CreateInput<D, W, T>>
    >
  ): MutationOptions<
    WaitedWriteResult<D, A, T, 'create', WriteResource<D, A, T, Inc, F, Cnt, 'create'>, Wt>,
    CreateInput<D, W, T>
  >
  id(id: string): HandleMutationApi<D, A, W, T>
}

/**
 * A singleton's mutation option factories (`api.inboxes.update()`), which take no id, as the
 * client's singleton accessor doesn't. The update's variables carry the resource's `id`.
 */
export interface SingletonMutationApi<D extends ApiDescriptor, A, W, T extends TypeName<D>> {
  update<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Wt extends WaitValue<D, T, 'update'> = undefined,
    const Cnt extends readonly ResourceCountToken<D, T, 'update'>[] = [],
  >(
    ...opts: OptionsArg<
      RequiresRequestMeta<RequestMetaOf<D, T, 'update'>>,
      UpdateMutationOpts<D, T, Inc, F, Wt, Cnt, SingletonUpdateInput<D, W, T>>
    >
  ): MutationOptions<
    WaitedWriteResult<D, A, T, 'update', WriteResource<D, A, T, Inc, F, Cnt, 'update'>, Wt>,
    SingletonUpdateInput<D, W, T>
  >
  rel(name: RelationName<D, T>): RelationMutationApi
}

/**
 * The bound mutation API: one {@link TypeMutationApi} per wire type (`api.albums.create()`), or a
 * {@link SingletonMutationApi} for a singleton type.
 */
export type MutationApi<D extends ApiDescriptor, A, W> = {
  [T in TypeName<D>]: D[T] extends { singleton: true }
    ? SingletonMutationApi<D, A, W, T>
    : TypeMutationApi<D, A, W, T>
}

/**
 * Bind a client + QueryClient to the per-type mutation option factories:
 * `createMutationApi(queryClient, client, descriptor).albums.id('1').update({ optimistic: true })`
 * returns the same `MutationOptions` as the standalone {@link updateMutationOptions}, with the
 * common arguments pre-applied. A Proxy (descriptor-keyed type validity is enforced by the static
 * `MutationApi` shape) — no per-type allocation until first access.
 *
 * @param queryClient Deprecated and ignored: the upkeep runs on the QueryClient the mutation runs
 * on. Kept so existing calls compile; it will be removed in a future major.
 */
export function createMutationApi<D extends ApiDescriptor, A, W>(
  queryClient: QueryClient,
  client: WriteClient<D, A, W>,
  descriptor: D,
): MutationApi<D, A, W> {
  const cache = new Map<
    string,
    TypeMutationApi<D, A, W, TypeName<D>> | SingletonMutationApi<D, A, W, TypeName<D>>
  >()
  return new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      if (typeof prop !== 'string') {
        return undefined
      }
      let api = cache.get(prop)
      if (api === undefined) {
        const type = prop as TypeName<D>
        api =
          descriptor[type]?.singleton === true
            ? singletonMutationApi(queryClient, client, descriptor, type)
            : typeMutationApi(queryClient, client, descriptor, type)
        cache.set(prop, api)
      }
      return api
    },
  }) as MutationApi<D, A, W>
}

/** Build one type's bound mutation option factories (delegates to the standalone factories). */
function typeMutationApi<D extends ApiDescriptor, A, W, T extends TypeName<D>>(
  queryClient: QueryClient,
  client: WriteClient<D, A, W>,
  descriptor: D,
  type: T,
): TypeMutationApi<D, A, W, T> {
  return {
    create: (...opts) =>
      (createMutationOptions as (...args: unknown[]) => never)(
        queryClient,
        client,
        descriptor,
        type,
        ...opts,
      ),
    id: (resource) => {
      // A collection type's id is a string, which the deferred `ResourceId` can't see here.
      const id = resource as ResourceId<D, T>
      return {
        update: (...opts) =>
          (updateMutationOptions as (...args: unknown[]) => never)(
            queryClient,
            client,
            descriptor,
            type,
            id,
            ...opts,
          ),
        delete: (...opts) => deleteMutationOptions(queryClient, client, type, resource, ...opts),
        rel: (name) => ({
          add: (opts) => addRelationshipMutationOptions(queryClient, client, type, id, name, opts),
          remove: (opts) =>
            removeRelationshipMutationOptions(queryClient, client, type, id, name, opts),
          replace: (opts) =>
            replaceRelationshipMutationOptions(
              queryClient,
              client,
              descriptor,
              type,
              id,
              name,
              opts,
            ),
          set: (opts) =>
            setRelationshipMutationOptions(queryClient, client, descriptor, type, id, name, opts),
        }),
      }
    },
  }
}

/** Build a singleton's bound mutation option factories, which address it with no id. */
function singletonMutationApi<D extends ApiDescriptor, A, W, T extends TypeName<D>>(
  queryClient: QueryClient,
  client: WriteClient<D, A, W>,
  descriptor: D,
  type: T,
): SingletonMutationApi<D, A, W, T> {
  const id = undefined as ResourceId<D, T>
  return {
    update: (...opts) =>
      (updateMutationOptions as (...args: unknown[]) => never)(
        queryClient,
        client,
        descriptor,
        type,
        id,
        ...opts,
      ),
    rel: (name) => ({
      add: (opts) => addRelationshipMutationOptions(queryClient, client, type, id, name, opts),
      remove: (opts) =>
        removeRelationshipMutationOptions(queryClient, client, type, id, name, opts),
      replace: (opts) =>
        replaceRelationshipMutationOptions(queryClient, client, descriptor, type, id, name, opts),
      set: (opts) =>
        setRelationshipMutationOptions(queryClient, client, descriptor, type, id, name, opts),
    }),
  }
}
