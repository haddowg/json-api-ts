/**
 * Mutation OPTION FACTORIES over the client write surface (CONTEXT.md "Mutations: option
 * factories with optimistic updates routed through the normalized patch"; ADR 0003).
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
import type {
  ApiDescriptor,
  AtomicHandle,
  AtomicRecorder,
  AtomicResult,
  AtomicResults,
  Client,
  CreateInput,
  FieldsMap,
  IncludePath,
  LinkageRef,
  ReadResult,
  RelationName,
  TypeName,
  UpdateInput,
  WriteOptions,
} from '@haddowg/json-api-client'
import type { QueryClient } from '@tanstack/query-core'
import { operationKey, relationKey, resourceKey } from './keys'
import { applyOptimisticPatch, normalize, type Snapshot } from './normalize'

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

/** The context an optimistic `onMutate` threads forward: the snapshot to roll back to on error. */
export interface MutationContext {
  snapshot: Snapshot
}

/** A client narrowed to the per-type write methods the mutation factories drive. */
type WriteClient<D extends ApiDescriptor, A, W> = {
  [T in TypeName<D>]: {
    create<const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
      input: CreateInput<D, W, T>,
      opts?: WriteOptions<D, T, Inc, F>,
    ): Promise<ReadResult<D, A, T, Inc, F>>
    id(id: string): {
      update<
        const Inc extends readonly IncludePath<D, T>[] = [],
        const F extends FieldsMap<D> = {},
      >(
        patch: UpdateInput<D, W, T>,
        opts?: WriteOptions<D, T, Inc, F>,
      ): Promise<ReadResult<D, A, T, Inc, F>>
      delete(): Promise<void>
      rel(name: RelationName<D, T>): {
        add(refs: readonly LinkageRef<string>[]): Promise<unknown>
        remove(refs: readonly LinkageRef<string>[]): Promise<unknown>
        replace(refs: readonly LinkageRef<string>[]): Promise<unknown>
        set(ref: LinkageRef<string> | null): Promise<unknown>
      }
    }
  }
}

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
 * that relation's linkage/membership (ADR 0003's TARGETED invalidation). We invalidate exactly:
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
  id: string,
  rel: string,
): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: relationKey(type, 'fetchRelated', id, rel) }),
    queryClient.invalidateQueries({ queryKey: relationKey(type, 'fetchRelationship', id, rel) }),
    queryClient.invalidateQueries({ queryKey: resourceKey(type, id) }),
  ]).then(() => undefined)
}

// ── Create / update / delete ──────────────────────────────────────────────────────────────

/**
 * The create mutation (`POST /{type}`): `mutationFn` runs `client.<type>.create(input, opts)`;
 * on settle the type's list subtree is invalidated (a new member changes collection membership —
 * a patch can't insert it, ADR 0003). The fresh resource is also normalized on success so any
 * query already holding the (server-assigned-id) resource reflects it.
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
>(
  queryClient: QueryClient,
  client: Client<D, A, W>,
  descriptor: D,
  type: T,
  opts?: WriteOptions<D, T, Inc, F>,
): MutationOptions<ReadResult<D, A, T, Inc, F>, CreateInput<D, W, T>> {
  const accessor = (client as unknown as WriteClient<D, A, W>)[type]
  return {
    mutationFn: (input) => accessor.create<Inc, F>(input, opts),
    onSuccess: (data) => {
      normalize(queryClient, data, descriptor)
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
 * queries; `onError` restores the snapshot.
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
>(
  queryClient: QueryClient,
  client: Client<D, A, W>,
  descriptor: D,
  type: T,
  id: string,
  opts?: WriteOptions<D, T, Inc, F> & { optimistic?: boolean },
): MutationOptions<ReadResult<D, A, T, Inc, F>, UpdateInput<D, W, T>, MutationContext> {
  const accessor = (client as unknown as WriteClient<D, A, W>)[type]
  const optimistic = opts?.optimistic === true
  const base: MutationOptions<
    ReadResult<D, A, T, Inc, F>,
    UpdateInput<D, W, T>,
    MutationContext
  > = {
    mutationFn: (patch) => accessor.id(id).update<Inc, F>(patch, opts),
    onSuccess: (data) => {
      normalize(queryClient, data, descriptor)
    },
  }
  if (!optimistic) {
    return base
  }
  // Optimistic: pre-apply the patch's attributes through the normalized patch (snapshotting the
  // touched queries first) on `onMutate`, and restore that snapshot on `onError`.
  base.onMutate = (patch) => ({
    snapshot: applyOptimisticPatch(
      queryClient,
      type,
      id,
      attributesFromPatch(descriptor, type, patch),
      descriptor,
    ),
  })
  base.onError = (_error, _patch, context) => {
    context?.snapshot.restore()
  }
  return base
}

/**
 * The delete mutation (`DELETE /{type}/{id}`): `mutationFn` runs `client.<type>.id(id).delete()`
 * (resolves `void`). On settle the type's list subtree AND that resource's reads are invalidated
 * (a delete changes collection membership and orphans the resource's `get`, ADR 0003).
 */
export function deleteMutationOptions<D extends ApiDescriptor, A, W, T extends TypeName<D>>(
  queryClient: QueryClient,
  client: Client<D, A, W>,
  type: T,
  id: string,
): MutationOptions<void, void> {
  const accessor = (client as unknown as WriteClient<D, A, W>)[type]
  return {
    mutationFn: () => accessor.id(id).delete(),
    onSettled: async () => {
      await invalidateLists(queryClient, type)
      await invalidateResource(queryClient, type, id)
    },
  }
}

// ── Relationship mutations ──────────────────────────────────────────────────────────────────

/**
 * A to-one relationship `set` (`PATCH …/relationships/{rel}` with a single ref or `null`):
 * `mutationFn` runs `client.<type>.id(id).rel(rel).set(ref)`. A `set` changes which resource the
 * to-one points at — linkage, not collection membership and not a node attribute — so on settle
 * we invalidate the PARENT's relations subtree (its `fetchRelationship`/`fetchRelated`/included
 * reads refetch). The mutation response (linkage) is also normalized on success.
 */
export function setRelationshipMutationOptions<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
>(
  queryClient: QueryClient,
  client: Client<D, A, W>,
  descriptor: D,
  type: T,
  id: string,
  rel: RelationName<D, T>,
): MutationOptions<unknown, LinkageRef<string> | null> {
  const accessor = (client as unknown as WriteClient<D, A, W>)[type]
  return {
    mutationFn: (ref) => accessor.id(id).rel(rel).set(ref),
    onSuccess: (data) => {
      normalize(queryClient, data, descriptor)
    },
    onSettled: () => invalidateParentRelations(queryClient, type, id, rel),
  }
}

/**
 * A to-many relationship `replace` (`PATCH …/relationships/{rel}` with the full new set):
 * `mutationFn` runs `client.<type>.id(id).rel(rel).replace(refs)`. A full replacement resets the
 * relation's membership, so on settle the parent's relations subtree is invalidated. The
 * mutation response (the new linkage) is normalized on success.
 */
export function replaceRelationshipMutationOptions<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
>(
  queryClient: QueryClient,
  client: Client<D, A, W>,
  descriptor: D,
  type: T,
  id: string,
  rel: RelationName<D, T>,
): MutationOptions<unknown, readonly LinkageRef<string>[]> {
  const accessor = (client as unknown as WriteClient<D, A, W>)[type]
  return {
    mutationFn: (refs) => accessor.id(id).rel(rel).replace(refs),
    onSuccess: (data) => {
      normalize(queryClient, data, descriptor)
    },
    onSettled: () => invalidateParentRelations(queryClient, type, id, rel),
  }
}

/**
 * A to-many relationship `add` (`POST …/relationships/{rel}`): `mutationFn` runs
 * `client.<type>.id(id).rel(rel).add(refs)`. Adding changes the relation's membership, so on
 * settle the parent's relations subtree is invalidated (a patch can't insert linkage members).
 */
export function addRelationshipMutationOptions<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
>(
  queryClient: QueryClient,
  client: Client<D, A, W>,
  type: T,
  id: string,
  rel: RelationName<D, T>,
): MutationOptions<unknown, readonly LinkageRef<string>[]> {
  const accessor = (client as unknown as WriteClient<D, A, W>)[type]
  return {
    mutationFn: (refs) => accessor.id(id).rel(rel).add(refs),
    onSettled: () => invalidateParentRelations(queryClient, type, id, rel),
  }
}

/**
 * A to-many relationship `remove` (`DELETE …/relationships/{rel}`): `mutationFn` runs
 * `client.<type>.id(id).rel(rel).remove(refs)`. Removing changes the relation's membership, so on
 * settle the parent's relations subtree is invalidated.
 */
export function removeRelationshipMutationOptions<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
>(
  queryClient: QueryClient,
  client: Client<D, A, W>,
  type: T,
  id: string,
  rel: RelationName<D, T>,
): MutationOptions<unknown, readonly LinkageRef<string>[]> {
  const accessor = (client as unknown as WriteClient<D, A, W>)[type]
  return {
    mutationFn: (refs) => accessor.id(id).rel(rel).remove(refs),
    onSettled: () => invalidateParentRelations(queryClient, type, id, rel),
  }
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
  client: Client<D, A, W>,
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

/** Extra options for an `update(...)` mutation: the write `include`/`fields` plus the optimistic toggle. */
export type UpdateMutationOpts<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[] = [],
  F extends FieldsMap<D> = FieldsMap<D>,
> = WriteOptions<D, T, Inc, F> & { optimistic?: boolean }

/**
 * The relationship-mutation option factories for one relation (`api.<type>.id(id).rel(rel).add(...)`).
 * Refs are typed loosely (`LinkageRef<string>`) at the `.rel(name)` boundary — parity with the
 * read API, whose per-relation value is also loose there (the related type isn't recoverable from
 * the relation name alone in the bound surface).
 */
export interface RelationMutationApi {
  add(): MutationOptions<unknown, readonly LinkageRef<string>[]>
  remove(): MutationOptions<unknown, readonly LinkageRef<string>[]>
  replace(): MutationOptions<unknown, readonly LinkageRef<string>[]>
  set(): MutationOptions<unknown, LinkageRef<string> | null>
}

/** The id-scoped mutation option factories (`api.<type>.id(id).update(...)` etc.). */
export interface HandleMutationApi<D extends ApiDescriptor, A, W, T extends TypeName<D>> {
  update<const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
    opts?: UpdateMutationOpts<D, T, Inc, F>,
  ): MutationOptions<ReadResult<D, A, T, Inc, F>, UpdateInput<D, W, T>, MutationContext>
  delete(): MutationOptions<void, void>
  rel(name: RelationName<D, T>): RelationMutationApi
}

/** The per-type mutation option factories, with `queryClient`/`client`/`descriptor`/`type` pre-applied. */
export interface TypeMutationApi<D extends ApiDescriptor, A, W, T extends TypeName<D>> {
  create<const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
    opts?: WriteOptions<D, T, Inc, F>,
  ): MutationOptions<ReadResult<D, A, T, Inc, F>, CreateInput<D, W, T>>
  id(id: string): HandleMutationApi<D, A, W, T>
}

/** The bound mutation API: one {@link TypeMutationApi} per wire type (`api.albums.create()`). */
export type MutationApi<D extends ApiDescriptor, A, W> = {
  [T in TypeName<D>]: TypeMutationApi<D, A, W, T>
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
  client: Client<D, A, W>,
  descriptor: D,
): MutationApi<D, A, W> {
  const cache = new Map<string, TypeMutationApi<D, A, W, TypeName<D>>>()
  return new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      if (typeof prop !== 'string') {
        return undefined
      }
      let api = cache.get(prop)
      if (api === undefined) {
        api = typeMutationApi(queryClient, client, descriptor, prop as TypeName<D>)
        cache.set(prop, api)
      }
      return api
    },
  }) as MutationApi<D, A, W>
}

/** Build one type's bound mutation option factories (delegates to the standalone factories). */
function typeMutationApi<D extends ApiDescriptor, A, W, T extends TypeName<D>>(
  queryClient: QueryClient,
  client: Client<D, A, W>,
  descriptor: D,
  type: T,
): TypeMutationApi<D, A, W, T> {
  return {
    create: (opts) => createMutationOptions(queryClient, client, descriptor, type, opts),
    id: (id) => ({
      update: (opts) => updateMutationOptions(queryClient, client, descriptor, type, id, opts),
      delete: () => deleteMutationOptions(queryClient, client, type, id),
      rel: (name) => ({
        add: () => addRelationshipMutationOptions(queryClient, client, type, id, name),
        remove: () => removeRelationshipMutationOptions(queryClient, client, type, id, name),
        replace: () =>
          replaceRelationshipMutationOptions(queryClient, client, descriptor, type, id, name),
        set: () => setRelationshipMutationOptions(queryClient, client, descriptor, type, id, name),
      }),
    }),
  }
}
