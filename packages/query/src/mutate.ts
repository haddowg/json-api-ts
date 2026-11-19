/**
 * Mutation OPTION FACTORIES over the client write surface (optimistic updates routed
 * through the normalized patch; docs/tanstack-query.md).
 *
 * Each factory returns a plain `{ mutationFn, onMutate?, onError?, onSuccess?, onSettled? }`
 * object structurally compatible with `@tanstack/query-core` — the user passes it to their
 * framework's `useMutation` or to a `MutationObserver`/`mutationCache.build(...)`. The binding
 * depends only on `query-core` (framework-agnostic) and preserves the client's full static
 * narrowing on the variables (create/update input) and the resolved result.
 *
 * The PATCH-vs-INVALIDATE split (ADR 0003):
 *  - an UPDATE (or a relationship set/replace on an existing resource) only changes a node's
 *    attributes/linkage, never collection membership -> on success run the Build-2 write-through
 *    {@link normalize} so the fresh resource patches everywhere it is cached, silently (no
 *    refetch);
 *  - a CREATE or DELETE (or a relationship add/remove — membership change) changes which
 *    resources a list/relationship holds, which is not a node patch -> on settle invalidate the
 *    relevant query subtrees by key PREFIX (the Build-1 hierarchy) so they refetch.
 *
 * OPTIMISTIC updates (update/relationship-set/replace only — the membership-changing verbs
 * have no node to pre-patch): `onMutate` applies the expected attribute change THROUGH the
 * same normalized patch and snapshots the touched queries; `onError` restores the snapshot;
 * `onSettled` runs the post-write reconciliation (the success patch having already landed).
 */
import {
  type ApiDescriptor,
  type AtomicHandle,
  type AtomicRecorder,
  type AtomicResult,
  type AtomicResults,
  type CreateInput,
  type CreateMethod,
  type DeleteArgs,
  type DeleteResult,
  type DocumentMetaOperation,
  type FieldsMap,
  type IncludePath,
  isAccepted,
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
import type { QueryClient } from '@tanstack/query-core'
import { operationKey, parentRelationReadKeys, resourceKey } from './keys'
import {
  applyOptimisticMembership,
  applyOptimisticPatch,
  applyOptimisticToOne,
  type MembershipRef,
  normalize,
  sameRef,
  type Snapshot,
} from './normalize'
import type { ResourceId } from './read'

/**
 * A TanStack-compatible mutation-options object: the async `mutationFn` plus the lifecycle
 * callbacks the binding wires for normalization / invalidation / optimism. Structurally
 * assignable to `query-core`'s `MutationOptions`/`UseMutationOptions` (the user merges in
 * `retry`, `onMutate` of their own, etc.), so the binding needn't import or re-export
 * query-core's option type — it stays a peer.
 *
 * `TData` is the resolved result, `TVars` the input the caller passes to `mutate(vars)`, and
 * `TContext` the value `onMutate` threads to `onError`/`onSettled` (here a {@link MutationContext}
 * carrying the optimistic snapshot).
 */
export interface MutationOptions<TData, TVars, TContext = unknown> {
  mutationFn: (variables: TVars) => Promise<TData>
  onMutate?: (variables: TVars) => Promise<TContext> | TContext
  onError?: (error: unknown, variables: TVars, context: TContext | undefined) => void
  onSuccess?: (data: TData, variables: TVars, context: TContext | undefined) => void
  onSettled?: (
    data: TData | undefined,
    error: unknown,
    variables: TVars,
    context: TContext | undefined,
  ) => void
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

/** The context an optimistic `onMutate` threads forward: the snapshot to roll back to on error. */
export interface MutationContext {
  snapshot: Snapshot
}

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

/**
 * Invalidate the list/collection subtree of a type (`[type, 'fetchMany']`) — refetched after a
 * create/delete changes which resources the collection holds. A prefix match, so every cached
 * list of the type (any filter/sort/page) is marked stale at once.
 */
function invalidateLists(queryClient: QueryClient, type: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: operationKey(type, 'fetchMany') })
}

/**
 * Invalidate every read OF a single resource on delete: its `fetchOne` reads (so a stale `get`
 * refetches and 404s/clears) AND its own `fetchRelated`/`fetchRelationship` reads (orphaned once
 * the resource is gone — `[type, 'fetchOne', id]` does not prefix those). Prefix matches across
 * include/fields/rel. NOTE: this covers the deleted resource's OWN reads; OTHER resources whose
 * relationship/related queries listed this one as a member are not auto-invalidated here (the
 * binding can't know which parents hold it without a cache scan — invalidate those explicitly, or
 * model the parent's own relationship mutation which DOES target it).
 */
function invalidateResource(queryClient: QueryClient, type: string, id: string): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: resourceKey(type, id) }),
    queryClient.invalidateQueries({ queryKey: [type, 'fetchRelated', id] }),
    queryClient.invalidateQueries({ queryKey: [type, 'fetchRelationship', id] }),
  ]).then(() => undefined)
}

/**
 * Invalidate one parent resource's reads of one relation after a set/replace/add/remove changes
 * that relation's linkage/membership (a TARGETED invalidation). We invalidate exactly:
 *  - the relation's related-collection reads (`[type, 'fetchRelated', id, rel]`),
 *  - the relation's linkage reads (`[type, 'fetchRelationship', id, rel]`),
 *  - the parent resource's own reads (`[type, 'fetchOne', id]`) — whose `?include` of the relation
 *    embeds the now-stale members.
 * It deliberately does NOT touch `[type, 'fetchMany']` (the type's collection lists): a relationship
 * change never alters which resources a collection holds, so scoping to the type would needlessly
 * invalidate every list of the type.
 */
function invalidateParentRelations(
  queryClient: QueryClient,
  type: string,
  id: string | undefined,
  rel: string,
): Promise<void> {
  // A singleton's keys carry no id, so its single reads sit under `[type, 'fetchOne']`.
  const parent = id === undefined ? operationKey(type, 'fetchOne') : resourceKey(type, id)
  return Promise.all([
    ...parentRelationReadKeys(type, id, rel).map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
    queryClient.invalidateQueries({ queryKey: parent }),
  ]).then(() => undefined)
}

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
 * The create mutation (`POST /{type}`): `mutationFn` runs `client.<type>.create(input, opts)`;
 * on settle the type's list subtree is invalidated (a new member changes collection membership —
 * a patch can't insert it). The fresh resource is also normalized on success so any
 * query already holding the (server-assigned-id) resource reflects it. A create that declares a
 * `202` may resolve to an `Accepted` job instead, which is not normalized, unless `wait` polls it.
 *
 * No optimistic insert by default: inserting into the right cached lists requires knowing each
 * list's sort/filter/page, which is list-specific — we invalidate instead (the documented,
 * always-correct default). A caller wanting optimism supplies their own `onMutate`.
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
  return {
    mutationFn: (input) =>
      (accessor.create as LooseWrite)(input, callOptions(opts, input)) as Promise<
        WaitedWriteResult<D, A, T, 'create', WriteResource<D, A, T, Inc, F, Cnt, 'create'>, Wt>
      >,
    onSuccess: (data) => {
      if (!isAccepted(data)) {
        normalize(queryClient, data, descriptor)
      }
    },
    onSettled: () => invalidateLists(queryClient, type),
  }
}

/**
 * The update mutation (`PATCH /{type}/{id}`): `mutationFn` runs
 * `client.<type>.id(id).update(patch, opts)`. An update only changes a node's attributes/linkage,
 * so on success it PATCHES across the cache via {@link normalize} (no refetch). When optimistic,
 * `onMutate` pre-applies the patch's attributes (those keys that are declared attributes of the
 * type — relation slots are skipped) through the normalized patch and snapshots the touched
 * queries; `onError` restores the snapshot. An update that declares a `202` may resolve to an
 * `Accepted` job, which is not normalized, unless `wait` polls it.
 *
 * A singleton (`PATCH /inbox`) takes `undefined` for the id and runs `client.<type>.update(input)`,
 * whose input carries the resource's `id` for the body.
 *
 * @param optimistic apply the patch's attributes immediately (rolled back on error). Default off.
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
  UpdateVariables<D, W, T>,
  MutationContext
> {
  const accessor = writesOf(client, type)
  const resource: string | undefined = id
  const optimistic = opts?.optimistic === true
  const base: MutationOptions<
    WaitedWriteResult<D, A, T, 'update', WriteResource<D, A, T, Inc, F, Cnt, 'update'>, Wt>,
    UpdateVariables<D, W, T>,
    MutationContext
  > = {
    mutationFn: (patch) =>
      ((resource === undefined ? accessor.update : accessor.id(resource).update) as LooseWrite)(
        patch,
        callOptions(opts, patch),
      ) as Promise<
        WaitedWriteResult<D, A, T, 'update', WriteResource<D, A, T, Inc, F, Cnt, 'update'>, Wt>
      >,
    onSuccess: (data) => {
      if (!isAccepted(data)) {
        normalize(queryClient, data, descriptor)
      }
    },
  }
  if (!optimistic) {
    return base
  }
  // Optimistic: pre-apply the patch's attributes through the normalized patch (snapshotting the
  // touched queries first) on `onMutate`, and restore that snapshot on `onError`.
  base.onMutate = (patch) => {
    const input = patch as Record<string, unknown>
    // A singleton's input names the resource the patch lands on.
    const target = resource ?? input['id']
    return {
      snapshot:
        typeof target === 'string'
          ? applyOptimisticPatch(
              queryClient,
              type,
              target,
              attributesFromPatch(descriptor, type, input),
              descriptor,
            )
          : { restore() {} },
    }
  }
  base.onError = (_error, _patch, context) => {
    context?.snapshot.restore()
  }
  return base
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
 * The delete mutation (`DELETE /{type}/{id}`): `mutationFn` runs `client.<type>.id(id).delete()`
 * (resolves the `meta` of the meta-only `200` the delete declares, else `void`), with the request
 * `meta` a delete declaring it takes. On settle the type's list subtree AND that resource's reads
 * are invalidated (a delete changes collection membership and orphans the resource's `get`).
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
  return {
    mutationFn: () => remove(callOptions(opts as { meta?: unknown } | undefined, undefined)),
    onSettled: async () => {
      await invalidateLists(queryClient, type)
      await invalidateResource(queryClient, type, id)
    },
  }
}

// ── Relationship mutations ──────────────────────────────────────────────────────────────────

/** Options for a relationship mutation: opt into an optimistic membership/linkage patch (default off). */
export interface RelationshipMutationOpts<V = never> {
  /**
   * Apply the membership change to the parent's cached related/relationship reads immediately
   * (by key prefix — every page variant), snapshotting for automatic rollback on error. The factory
   * still invalidates the relation subtree on settle so the server reconciles. Default off (a plain
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
 * Coerce a linkage ref (`{type,id}` / `{type,lid}` / a resource view, optionally `$pivot`) to a
 * membership ref for the optimistic array patch. The whole ref is preserved (so a hydrated member
 * carrying attributes yields a rich optimistic row), requiring only a string `type`+`id`. A ref
 * addressed only by `lid` (an atomic handle) has no cache identity, so it is dropped from the
 * optimistic view (it still writes on the wire).
 */
function toMembershipRef(ref: LinkageRef<string>): MembershipRef | undefined {
  const r = ref as { type?: unknown; id?: unknown }
  if (typeof r.type !== 'string' || typeof r.id !== 'string') {
    return undefined
  }
  return { ...(ref as Record<string, unknown>), type: r.type, id: r.id }
}

/** The membership refs (cache-addressable) of a to-many mutation's variables. */
const membershipRefs = (refs: readonly LinkageRef<string>[]): MembershipRef[] =>
  refs.map(toMembershipRef).filter((r): r is MembershipRef => r !== undefined)

/**
 * Wire the optimistic membership lifecycle onto a to-many relationship mutation: `onMutate` applies
 * `transform` to the parent's cached related/relationship arrays (snapshotting), `onError` rolls
 * back, `onSettled` invalidates the relation subtree (kept from the base). When not optimistic, the
 * base (invalidate-on-settle only) is returned untouched.
 */
function withMembershipOptimism<TVars extends readonly LinkageRef<string>[]>(
  queryClient: QueryClient,
  type: string,
  id: string | undefined,
  rel: string,
  base: MutationOptions<unknown, TVars, MutationContext>,
  transform: (current: readonly MembershipRef[], vars: TVars) => readonly MembershipRef[],
  optimistic: boolean,
): MutationOptions<unknown, TVars, MutationContext> {
  if (!optimistic) {
    return base
  }
  return {
    ...base,
    onMutate: (vars) => ({
      snapshot: applyOptimisticMembership(queryClient, type, id, rel, (current) =>
        transform(current, vars),
      ),
    }),
    onError: (_error, _vars, context) => {
      context?.snapshot.restore()
    },
  }
}

/**
 * A to-one relationship `set` (`PATCH …/relationships/{rel}` with a single ref or `null`):
 * `mutationFn` runs `client.<type>.id(id).rel(rel).set(ref)`. A `set` changes which resource the
 * to-one points at — linkage, not collection membership and not a node attribute — so on settle
 * we invalidate the PARENT's relations subtree (its `fetchRelationship`/`fetchRelated`/included
 * reads refetch). The mutation response (linkage) is also normalized on success. When optimistic,
 * `onMutate` swaps the parent's cached relationship/related reads to the new single value (or `null`)
 * and rolls back on error.
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
): MutationOptions<unknown, LinkageRef<string> | null, MutationContext> {
  const base: MutationOptions<unknown, LinkageRef<string> | null, MutationContext> = {
    mutationFn: (ref) =>
      relationWrites(client, type, id, rel).set(ref, callOptions(opts, ref) as LooseMetaOpts),
    onSuccess: (data) => {
      normalize(queryClient, data, descriptor)
    },
    onSettled: () => invalidateParentRelations(queryClient, type, id, rel),
  }
  if (!isOptimistic(opts)) {
    return base
  }
  return {
    ...base,
    onMutate: (ref) => {
      const next = ref === null ? undefined : toMembershipRef(ref)
      return {
        snapshot: applyOptimisticToOne(queryClient, type, id, rel, ref === null ? null : next),
      }
    },
    onError: (_error, _ref, context) => {
      context?.snapshot.restore()
    },
  }
}

/**
 * A to-many relationship `replace` (`PATCH …/relationships/{rel}` with the full new set):
 * `mutationFn` runs `client.<type>.id(id).rel(rel).replace(refs)`. A full replacement resets the
 * relation's membership, so on settle the parent's relations subtree is invalidated. The
 * mutation response (the new linkage) is normalized on success. When optimistic, the cached
 * membership is swapped to `refs` and rolled back on error.
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
): MutationOptions<unknown, readonly LinkageRef<string>[], MutationContext> {
  const base: MutationOptions<unknown, readonly LinkageRef<string>[], MutationContext> = {
    mutationFn: (refs) =>
      relationWrites(client, type, id, rel).replace(refs, callOptions(opts, refs) as LooseMetaOpts),
    onSuccess: (data) => {
      normalize(queryClient, data, descriptor)
    },
    onSettled: () => invalidateParentRelations(queryClient, type, id, rel),
  }
  // Replace: the optimistic set IS the new refs (order preserved), regardless of the current members.
  return withMembershipOptimism(
    queryClient,
    type,
    id,
    rel,
    base,
    (_current, refs) => membershipRefs(refs),
    isOptimistic(opts),
  )
}

/**
 * A to-many relationship `add` (`POST …/relationships/{rel}`): `mutationFn` runs
 * `client.<type>.id(id).rel(rel).add(refs)`. Adding changes the relation's membership, so on
 * settle the parent's relations subtree is invalidated (a patch can't insert linkage members).
 * When optimistic, the added refs are appended to the cached membership (deduplicated by `type:id`)
 * and rolled back on error.
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
): MutationOptions<unknown, readonly LinkageRef<string>[], MutationContext> {
  const base: MutationOptions<unknown, readonly LinkageRef<string>[], MutationContext> = {
    mutationFn: (refs) =>
      relationWrites(client, type, id, rel).add(refs, callOptions(opts, refs) as LooseMetaOpts),
    onSettled: () => invalidateParentRelations(queryClient, type, id, rel),
  }
  return withMembershipOptimism(
    queryClient,
    type,
    id,
    rel,
    base,
    (current, refs) => {
      const added = membershipRefs(refs)
      // Append the added refs, skipping any already present (an add is idempotent on membership).
      const kept = current.filter((m) => !added.some((a) => sameRef(a, m)))
      return [...kept, ...added]
    },
    isOptimistic(opts),
  )
}

/**
 * A to-many relationship `remove` (`DELETE …/relationships/{rel}`): `mutationFn` runs
 * `client.<type>.id(id).rel(rel).remove(refs)`. Removing changes the relation's membership, so on
 * settle the parent's relations subtree is invalidated. When optimistic, the removed refs are
 * dropped from the cached membership and rolled back on error.
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
): MutationOptions<unknown, readonly LinkageRef<string>[], MutationContext> {
  const base: MutationOptions<unknown, readonly LinkageRef<string>[], MutationContext> = {
    mutationFn: (refs) =>
      relationWrites(client, type, id, rel).remove(refs, callOptions(opts, refs) as LooseMetaOpts),
    onSettled: () => invalidateParentRelations(queryClient, type, id, rel),
  }
  return withMembershipOptimism(
    queryClient,
    type,
    id,
    rel,
    base,
    (current, refs) => {
      const removed = membershipRefs(refs)
      return current.filter((m) => !removed.some((r) => sameRef(r, m)))
    },
    isOptimistic(opts),
  )
}

// ── Atomic (a thin passthrough) ─────────────────────────────────────────────────────────────

/**
 * A thin atomic-batch mutation (`POST /operations`): `mutationFn` forwards the `build` callback to
 * `client.atomic(build)`, preserving the client's per-op `const`-tuple result inference (the
 * variables ARE the build callback). On success the materialised results are run through
 * {@link normalize} so any updated resource patches across the cache.
 *
 * INVALIDATION is the caller's responsibility for atomic: a batch can mix creates/updates/deletes
 * across many types, and the recorded ops aren't enumerable after the build runs, so the binding
 * can't know which list subtrees changed membership. Updates self-heal via the success
 * normalization; for a batch that creates/deletes, add an `onSettled` that invalidates the
 * affected `operationKey(type, 'fetchMany')` subtrees (or `queryClient.invalidateQueries()` for a
 * blanket refetch). Kept deliberately minimal — atomic is an escape hatch, not a normalized path.
 */
export function atomicMutationOptions<D extends ApiDescriptor, A, W>(
  queryClient: QueryClient,
  client: WriteClient<D, A, W>,
  descriptor: D,
): MutationOptions<
  AtomicResult[],
  <const Ops>(
    tx: AtomicRecorder<D, W>,
  ) => Ops extends readonly AtomicHandle[] ? AtomicResults<D, A, Ops> : Ops
> {
  return {
    mutationFn: (build) =>
      // The client's `atomic` carries the precise per-op return type; the binding's loose
      // `AtomicResult[]` result is the common supertype (a caller wanting the positional tuple
      // calls `client.atomic` directly — the binding's value is the cache normalization).
      (client as unknown as { atomic: (b: unknown) => Promise<AtomicResult[]> }).atomic(build),
    onSuccess: (data) => {
      normalize(queryClient, data, descriptor)
    },
  }
}

/**
 * Split an update patch into just its ATTRIBUTE keys (for an optimistic node patch): a key is an
 * attribute iff the descriptor declares it under `attributes` for the type. Relation slots and
 * any unknown key are dropped — an optimistic patch only touches a node's shared attributes (the
 * same split {@link normalize}'s real patch honours), never linkage.
 */
function attributesFromPatch(
  descriptor: ApiDescriptor,
  type: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const attributes = descriptor[type]?.attributes ?? {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (key in attributes) {
      out[key] = value
    }
  }
  return out
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
  ): MutationOptions<unknown, readonly LinkageRef<string>[], MutationContext>
  remove(
    opts?: RelationshipMutationOpts<readonly LinkageRef<string>[]>,
  ): MutationOptions<unknown, readonly LinkageRef<string>[], MutationContext>
  replace(
    opts?: RelationshipMutationOpts<readonly LinkageRef<string>[]>,
  ): MutationOptions<unknown, readonly LinkageRef<string>[], MutationContext>
  set(
    opts?: RelationshipMutationOpts<LinkageRef<string> | null>,
  ): MutationOptions<unknown, LinkageRef<string> | null, MutationContext>
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
    UpdateInput<D, W, T>,
    MutationContext
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
    SingletonUpdateInput<D, W, T>,
    MutationContext
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
