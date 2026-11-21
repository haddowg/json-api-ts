/**
 * Mutation OPTION FACTORIES over the client write surface (docs/tanstack-query.md).
 *
 * Each factory returns a plain `{ mutationKey, mutationFn, meta }` object structurally compatible
 * with `@tanstack/query-core` — the user passes it to their framework's `useMutation` /
 * `injectMutation`, or to a `MutationObserver`/`mutationCache.build(...)`. The binding depends only
 * on `query-core` (framework-agnostic) and preserves the client's full static narrowing on the
 * variables (create/update input), the resolved result and the error.
 *
 * A factory sets no lifecycle callbacks. Its cache upkeep (the optimistic change and its rollback,
 * normalization on success, invalidation on settle) is described as plain data in
 * `meta[JSON_API_PLAN]`, beside the closures it needs on the options under `JSON_API_HOOKS`, and
 * carried out by {@link JsonApiMutationCache}, which the QueryClient must be built with; see
 * ./upkeep.ts for what each verb does. So the `onMutate`/`onError`/`onSuccess`/`onSettled` an app
 * spreads alongside are its own, and never replace the upkeep.
 */
import {
  type ApiDescriptor,
  type AtomicRecorder,
  type AtomicResult,
  type Client,
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
import type { Into, InsertInto, RelationInto } from './draft'
import { stamped } from './freshness'
import type { QueryKey } from './keys'
import { assertUpkeepRuns } from './mutation-cache'
import { scopeApi, type ScopeOption } from './scope'
import type { ReadError, ResourceId } from './read'
import {
  CUSTOM_MUTATION_KEY,
  JSON_API_HOOKS,
  JSON_API_PLAN,
  type JsonApiMutationHooks,
  type JsonApiMutationKey,
  type JsonApiMutationMeta,
  type JsonApiMutationPlan,
  type JsonApiResourceVerb,
  optimismOf,
  optimisticHooks,
  type OptimisticFn,
  type OptimisticOption,
  planKey,
  withoutTempId,
} from './upkeep'
import { scopedKey } from './keys'

/**
 * The error a JSON:API mutation rejects with: a {@link JsonApiError} carrying the client's error
 * codes `C`, a structural guard failure, or any other `Error` (the same union a read's error is).
 */
export type MutationError<C extends string = string> = ReadError<C>

/**
 * A typed TanStack `retry` callback. Mutation options declare it, optional and never set, so
 * TanStack infers the mutation's `error` as `E`; the mutation's configured `retry` still applies.
 */
export type MutationRetry<E = MutationError> = {
  // A method, so its parameters are bivariant: options typed with `E` still fit TanStack's own
  // options typed with a wider error.
  retry(failureCount: number, error: E): boolean
}['retry']

/**
 * A TanStack-compatible mutation-options object: the mutation's key, its async `mutationFn`, the
 * `meta` carrying the plan {@link JsonApiMutationCache} runs the cache upkeep from, and the
 * closures that upkeep needs (an optimistic function, an explicit placement), under a symbol. It
 * sets no lifecycle callbacks, so the app spreads in its own (`retry`, `onSuccess`, …) freely.
 * Structurally assignable to `query-core`'s `MutationOptions` and the framework adapters'
 * `useMutation` / `injectMutation` options, so the binding needn't re-export query-core's option
 * type.
 *
 * Replace `meta` only by merging with this one (`meta: { ...options.meta, mine }`): a mutation whose
 * plan is gone throws rather than skip its upkeep.
 *
 * `TData` is the resolved result, `TVars` the input the caller passes to `mutate(vars)`, and `E`
 * the error it rejects with, which the declared (never set) `retry` carries into what
 * `useMutation`/`injectMutation` infer.
 */
export interface MutationOptions<TData, TVars, E = MutationError> {
  /**
   * `[type, verb, id?, rel?]`, as {@link mutationKeyFor} builds it (`['$atomic']` for a batch,
   * `['$custom']` or the app's own for a custom write), led by a `{ $scope }` segment in a scope.
   */
  mutationKey: JsonApiMutationKey
  mutationFn: (variables: TVars, context: MutationFunctionContext) => Promise<TData>
  meta: JsonApiMutationMeta
  /** Declared to type the mutation's `error`; never set. */
  retry?: MutationRetry<E>
  /** The closures the upkeep reads from the mutation's options. */
  readonly [JSON_API_HOOKS]?: JsonApiMutationHooks
}

/** The options of a plan's mutation, its `mutationFn` refusing to run where the upkeep can't. */
function planned<TData, TVars, E>(
  plan: JsonApiMutationPlan,
  run: (variables: TVars) => Promise<TData>,
  hooks: JsonApiMutationHooks = {},
): MutationOptions<TData, TVars, E> {
  const options: MutationOptions<TData, TVars, E> = {
    mutationKey: planKey(plan),
    mutationFn: (variables, context) => {
      assertUpkeepRuns(context)
      // Stamped with the write's start, so its result patches only data older than it.
      return stamped(() => run(variables))
    },
    meta: { [JSON_API_PLAN]: plan },
  }
  const present = Object.entries(hooks).filter(([, value]) => value !== undefined)
  return present.length === 0
    ? options
    : { ...options, [JSON_API_HOOKS]: Object.fromEntries(present) as JsonApiMutationHooks }
}

/** The plan of a write on `type`, leaving out the members it doesn't have. */
function resourcePlan(
  verb: JsonApiResourceVerb,
  type: string,
  id: string | undefined,
  rel: string | undefined,
  optimistic: OptimisticOption<never, never, never, never> | undefined,
  attachTo?: { readonly type: string; readonly id: string; readonly rel: string },
): JsonApiMutationPlan {
  const optimism = optimismOf(optimistic)
  return {
    verb,
    type,
    ...(id === undefined ? {} : { id }),
    ...(rel === undefined ? {} : { rel }),
    ...(optimism === undefined ? {} : { optimistic: optimism }),
    ...(attachTo === undefined
      ? {}
      : { attachTo: { type: attachTo.type, id: attachTo.id, rel: attachTo.rel } }),
  }
}

/**
 * The key the client carries its error-code union under. The client keeps the symbol private (a
 * type-only member), so it is recovered from the `Client` type.
 */
type ErrorCodesKey = Extract<keyof Client<{}>, symbol>

/** What a client carries of its error codes, which the factories infer to type `error`. */
type ErrorCodes<C extends string> = { readonly [K in ErrorCodesKey]?: C }

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

/**
 * The options a client write is called with: the factory's, with its `meta` built for `variables`
 * and the members only the cache reads (`optimistic`, `attachTo`, `clientId`) left out.
 */
function callOptions<O extends { meta?: unknown }>(
  opts: O | undefined,
  variables: unknown,
): O | undefined {
  if (opts === undefined) {
    return undefined
  }
  const {
    optimistic: _optimistic,
    attachTo: _attachTo,
    clientId: _clientId,
    ...rest
  } = opts as O & { optimistic?: unknown; attachTo?: unknown; clientId?: unknown }
  if (typeof rest.meta !== 'function') {
    return rest as O
  }
  return { ...rest, meta: (rest.meta as (variables: unknown) => unknown)(variables) } as O
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

/** A {@link WriteClient} carrying the error codes `C` it rejects with. */
type CodedWriteClient<D extends ApiDescriptor, A, W, C extends string> = WriteClient<D, A, W> &
  ErrorCodes<C>

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

/** The input of an update taking its resource's id in its variables: `{ id, ...patch }`. */
export type UpdateByIdVariables<D extends ApiDescriptor, W, T extends TypeName<D>> = UpdateInput<
  D,
  W,
  T
> & { readonly id: string }

/** The input of a delete taking its resource's id in its variables: `{ id }`. */
export interface DeleteByIdVariables {
  readonly id: string
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
 * A parent relation a created resource is attached to (design B2): optimistically, placed by the
 * relation's rules (automatically in an unfiltered, unsorted, complete view, else by `into`), and
 * at settle, when the relation's reads are invalidated.
 */
export type AttachTo<D extends ApiDescriptor> = {
  [P in TypeName<D>]: {
    [R in RelationName<D, P>]: {
      readonly type: P
      readonly id: string
      readonly rel: R
      /** Explicit placement for the relation's views automatic placement didn't cover. */
      readonly into?: RelationInto<D, P, R> | undefined
    }
  }[RelationName<D, P>]
}[TypeName<D>]

/**
 * The options a create mutation takes: the write's own, plus how it is optimistic, the parent it
 * attaches to, and the id generator for a type that takes client ids.
 */
export type CreateMutationOpts<
  D extends ApiDescriptor,
  W,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[] = [],
  F extends FieldsMap<D> = FieldsMap<D>,
  Wt = undefined,
  Cnt extends readonly ResourceCountToken<D, T, 'create'>[] = readonly ResourceCountToken<
    D,
    T,
    'create'
  >[],
> = WriteMutationOpts<D, T, Inc, F, Wt, 'create', Cnt, CreateInput<D, W, T>> & {
  /**
   * Insert the new resource before the write: into no list unless `into` places it, and into
   * `attachTo`'s relation. It carries the id the client generated (a type taking client ids), sent
   * with the create, or a temporary id swapped for the server's on success. `true`, a function, or
   * `{ into }`; `false` overrides the mutation cache's default.
   */
  optimistic?: OptimisticOption<D, W, CreateInput<D, W, T>, InsertInto<D, T>> | undefined
  attachTo?: AttachTo<D> | undefined
  /** The id an optimistic create generates for a type taking client ids. `crypto.randomUUID()` by default. */
  clientId?: (() => string) | undefined
}

/** The closures a create's options contribute. */
function createHooks(opts: {
  optimistic?: unknown
  attachTo?: { into?: unknown } | undefined
  clientId?: (() => string) | undefined
}): JsonApiMutationHooks {
  return {
    ...optimisticHooks(opts.optimistic as OptimisticOption<never, never, never, never>),
    attachInto: opts.attachTo?.into as Into<never> | undefined,
    clientId: opts.clientId,
  }
}

/**
 * The create mutation (`POST /{type}`), keyed `[type, 'create']`: `mutationFn` runs
 * `client.<type>.create(input, opts)`. Its upkeep normalizes the fresh resource on success, so any
 * query already holding it reflects it, and invalidates the type's lists on settle (a new member
 * changes collection membership), and `attachTo`'s relation. A create that declares a `202` may
 * resolve to an `Accepted` job instead, which is not normalized, unless `wait` polls it.
 *
 * When optimistic, the new resource is inserted before the write: into the lists `into` places it
 * in (never automatically: only the server knows where it belongs in a filtered, sorted or paged
 * list) and into `attachTo`'s relation.
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
  C extends string = string,
>(
  queryClient: QueryClient,
  client: CodedWriteClient<D, A, W, C>,
  descriptor: D,
  type: T,
  ...[opts]: OptionsArg<
    RequiresRequestMeta<RequestMetaOf<D, T, 'create'>>,
    CreateMutationOpts<D, W, T, Inc, F, Wt, Cnt>
  >
): MutationOptions<
  WaitedWriteResult<D, A, T, 'create', WriteResource<D, A, T, Inc, F, Cnt, 'create'>, Wt>,
  CreateInput<D, W, T>,
  MutationError<C>
> {
  const accessor = writesOf(client, type)
  const options = (opts ?? {}) as CreateMutationOpts<D, W, T, Inc, F, Wt, Cnt>
  return planned(
    resourcePlan(
      'create',
      type,
      undefined,
      undefined,
      options.optimistic as never,
      options.attachTo,
    ),
    (input: CreateInput<D, W, T>) =>
      (accessor.create as LooseWrite)(withoutTempId(input), callOptions(opts, input)) as Promise<
        WaitedWriteResult<D, A, T, 'create', WriteResource<D, A, T, Inc, F, Cnt, 'create'>, Wt>
      >,
    createHooks(options),
  )
}

/**
 * The update mutation (`PATCH /{type}/{id}`), keyed `[type, 'update', id]`: `mutationFn` runs
 * `client.<type>.id(id).update(patch, opts)`. An update only changes a node's attributes/linkage,
 * so its upkeep PATCHES the result across the cache via `normalize` on success (no refetch), and
 * invalidates the reads of each relation the patch changes on settle. When optimistic, the patch is
 * applied through an optimistic draft before the write and rolled back on error: its attributes on
 * every cached copy that holds them, and its relations as a relationship `set` or `replace` would
 * apply them. An update that declares a `202` may resolve to an `Accepted` job, which is not
 * normalized, unless `wait` polls it.
 *
 * A singleton (`PATCH /inbox`) takes `undefined` for the id, is keyed `[type, 'update']`, and runs
 * `client.<type>.update(input)`, whose input carries the resource's `id` for the body.
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
  C extends string = string,
>(
  queryClient: QueryClient,
  client: CodedWriteClient<D, A, W, C>,
  descriptor: D,
  type: T,
  id: ResourceId<D, T>,
  ...[opts]: OptionsArg<
    RequiresRequestMeta<RequestMetaOf<D, T, 'update'>>,
    UpdateMutationOpts<D, T, Inc, F, Wt, Cnt, UpdateVariables<D, W, T>, W>
  >
): MutationOptions<
  WaitedWriteResult<D, A, T, 'update', WriteResource<D, A, T, Inc, F, Cnt, 'update'>, Wt>,
  UpdateVariables<D, W, T>,
  MutationError<C>
> {
  const accessor = writesOf(client, type)
  const resource: string | undefined = id
  const optimistic = opts?.optimistic as OptimisticOption<never, never, never, never> | undefined
  return planned(
    resourcePlan('update', type, resource, undefined, optimistic),
    (patch: UpdateVariables<D, W, T>) =>
      ((resource === undefined ? accessor.update : accessor.id(resource).update) as LooseWrite)(
        patch,
        callOptions(opts, patch),
      ) as Promise<
        WaitedWriteResult<D, A, T, 'update', WriteResource<D, A, T, Inc, F, Cnt, 'update'>, Wt>
      >,
    optimisticHooks(optimistic),
  )
}

/** An update taking its resource's id in its variables, keyed `[type, 'update']`. */
function updateByIdMutationOptions<D extends ApiDescriptor, A, W, T extends TypeName<D>>(
  client: WriteClient<D, A, W>,
  type: T,
  opts: { optimistic?: unknown; meta?: unknown } | undefined,
): MutationOptions<unknown, UpdateByIdVariables<D, W, T>> {
  const accessor = writesOf(client, type)
  const optimistic = opts?.optimistic as OptimisticOption<never, never, never, never> | undefined
  return planned(
    resourcePlan('update', type, undefined, undefined, optimistic),
    (variables: UpdateByIdVariables<D, W, T>) => {
      const { id, ...patch } = variables as { id: string } & Record<string, unknown>
      return (accessor.id(id).update as LooseWrite)(patch, callOptions(opts, variables))
    },
    optimisticHooks(optimistic),
  )
}

/** How a delete is optimistic. */
export interface DeleteMutationOpts<
  D extends ApiDescriptor = ApiDescriptor,
  W = unknown,
  V = void,
> {
  /**
   * Remove the resource from every cached list, relation and slot before the write (`evict`),
   * restored on error. `true` or a function; `false` overrides the mutation cache's default.
   */
  optimistic?: boolean | OptimisticFn<D, W, V> | undefined
}

/**
 * The options of a delete mutation: how it is optimistic and, when its request document declares
 * `meta`, that `meta`, required when a member is. `V` is the delete's variables.
 */
export type DeleteMutationArgs<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  W = unknown,
  V = void,
> = [RequestMetaOf<D, T, 'delete'>] extends [never]
  ? [opts?: DeleteMutationOpts<D, W, V>]
  : OptionsArg<
      RequiresRequestMeta<RequestMetaOf<D, T, 'delete'>>,
      MutationMetaOption<RequestMetaOf<D, T, 'delete'>, V> & DeleteMutationOpts<D, W, V>
    >

/**
 * The delete mutation (`DELETE /{type}/{id}`), keyed `[type, 'delete', id]`: `mutationFn` runs
 * `client.<type>.id(id).delete()` (resolves the `meta` of the meta-only `200` the delete declares,
 * else `void`), with the request `meta` a delete declaring it takes. On success its upkeep removes
 * the resource's own reads (which would otherwise refetch into a 404), and on settle invalidates the
 * type's lists and every other query that held it. When optimistic, the resource is evicted from
 * every cached list, relation and slot before the write and restored on error.
 *
 * @param queryClient Deprecated and ignored: the upkeep runs on the QueryClient the mutation runs
 * on. Kept so existing calls compile; it will be removed in a future major.
 */
export function deleteMutationOptions<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
  C extends string = string,
>(
  queryClient: QueryClient,
  client: CodedWriteClient<D, A, W, C>,
  type: T,
  id: string,
  ...[opts]: DeleteMutationArgs<D, T, W>
): MutationOptions<DeleteResult<D, T>, void, MutationError<C>> {
  const accessor = writesOf(client, type)
  const remove = accessor.id(id).delete as (opts?: unknown) => Promise<DeleteResult<D, T>>
  const optimistic = (opts as DeleteMutationOpts | undefined)?.optimistic as
    | OptimisticOption<never, never, never, never>
    | undefined
  return planned(
    resourcePlan('delete', type, id, undefined, optimistic),
    () => remove(callOptions(opts as { meta?: unknown } | undefined, undefined)),
    optimisticHooks(optimistic),
  )
}

/** A delete taking its resource's id in its variables, keyed `[type, 'delete']`. */
function deleteByIdMutationOptions<D extends ApiDescriptor, A, W, T extends TypeName<D>>(
  client: WriteClient<D, A, W>,
  type: T,
  opts: { optimistic?: unknown; meta?: unknown } | undefined,
): MutationOptions<DeleteResult<D, T>, DeleteByIdVariables> {
  const accessor = writesOf(client, type)
  const optimistic = opts?.optimistic as OptimisticOption<never, never, never, never> | undefined
  return planned(
    resourcePlan('delete', type, undefined, undefined, optimistic),
    (variables: DeleteByIdVariables) =>
      (accessor.id(variables.id).delete as (opts?: unknown) => Promise<DeleteResult<D, T>>)(
        callOptions(opts, variables),
      ),
    optimisticHooks(optimistic),
  )
}

// ── Relationship mutations ──────────────────────────────────────────────────────────────────

/** Options for a relationship mutation: how it is optimistic (default: the mutation cache's), and its request `meta`. */
export interface RelationshipMutationOpts<
  V = never,
  D extends ApiDescriptor = ApiDescriptor,
  T extends TypeName<D> = TypeName<D>,
  R extends RelationName<D, T> = RelationName<D, T>,
> {
  /**
   * Apply the membership change immediately through an optimistic draft, rolled back on error: to
   * the parent's cached related and relationship reads (every page variant, infinite pages too)
   * and to the relation's slot on every cached copy of the parent. A member removed leaves every
   * view. A member added goes, at the end, into each view that is unfiltered, unsorted and
   * complete, and into the others `into` places it in, as an identifier where the view holds
   * identifiers and as the richest cached copy (or the ref itself, when it carries the attributes)
   * where it holds resources; where no copy fits, the parent reports it through `$pending(rel)`
   * instead. The relation is still invalidated on settle so the server reconciles. `true`, a
   * function, or `{ into }`; `false` overrides the mutation cache's default.
   */
  optimistic?: OptimisticOption<D, unknown, V, RelationInto<D, T, R>> | undefined
  /**
   * The top-level `meta` the write sends, for a relation whose write declares it: the object, or a
   * function building it from the call's refs.
   */
  meta?: MutationMeta<Readonly<Record<string, unknown>>, V>
}

/** The plan and closures of a relationship verb. */
function relationshipMutation<V, TData = unknown, E = MutationError>(
  verb: 'add' | 'remove' | 'replace' | 'set',
  type: string,
  id: string | undefined,
  rel: string,
  opts: RelationshipMutationOpts<V, never, never, never> | undefined,
  run: (variables: V) => Promise<TData>,
): MutationOptions<TData, V, E> {
  const optimistic = opts?.optimistic as OptimisticOption<never, never, never, never> | undefined
  return planned(resourcePlan(verb, type, id, rel, optimistic), run, optimisticHooks(optimistic))
}

/**
 * A to-one relationship `set` (`PATCH …/relationships/{rel}` with a single ref or `null`), keyed
 * `[type, 'set', id, rel]`: `mutationFn` runs `client.<type>.id(id).rel(rel).set(ref)`. A `set`
 * changes which resource the to-one points at — linkage, not collection membership and not a node
 * attribute — so its upkeep normalizes the response (linkage) on success and invalidates the
 * PARENT's reads of the relation, and the parent itself, on settle. When optimistic, the parent's
 * cached relationship/related reads and its relation slot on every cached copy swap to the new
 * value (or `null`) before the write, where it fits, and roll back on error.
 *
 * @param queryClient Deprecated and ignored: the upkeep runs on the QueryClient the mutation runs
 * on. Kept so existing calls compile; it will be removed in a future major.
 */
export function setRelationshipMutationOptions<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
  C extends string = string,
>(
  queryClient: QueryClient,
  client: CodedWriteClient<D, A, W, C>,
  descriptor: D,
  type: T,
  id: ResourceId<D, T>,
  rel: R,
  opts?: RelationshipMutationOpts<LinkageRef<string> | null, D, T, R>,
): MutationOptions<unknown, LinkageRef<string> | null, MutationError<C>> {
  return relationshipMutation(
    'set',
    type,
    id,
    rel,
    opts as never,
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
  R extends RelationName<D, T>,
  C extends string = string,
>(
  queryClient: QueryClient,
  client: CodedWriteClient<D, A, W, C>,
  descriptor: D,
  type: T,
  id: ResourceId<D, T>,
  rel: R,
  opts?: RelationshipMutationOpts<readonly LinkageRef<string>[], D, T, R>,
): MutationOptions<unknown, readonly LinkageRef<string>[], MutationError<C>> {
  return relationshipMutation(
    'replace',
    type,
    id,
    rel,
    opts as never,
    (refs: readonly LinkageRef<string>[]) =>
      relationWrites(client, type, id, rel).replace(refs, callOptions(opts, refs) as LooseMetaOpts),
  )
}

/**
 * A to-many relationship `add` (`POST …/relationships/{rel}`), keyed `[type, 'add', id, rel]`:
 * `mutationFn` runs `client.<type>.id(id).rel(rel).add(refs)`. Adding changes the relation's
 * membership, so its upkeep invalidates the parent's reads of the relation on settle (a patch can't
 * insert linkage members). When optimistic, the added refs are placed in the cached membership
 * where they fit (see {@link RelationshipMutationOpts.optimistic}, deduplicated by `type:id`) and
 * rolled back on error.
 *
 * @param queryClient Deprecated and ignored: the upkeep runs on the QueryClient the mutation runs
 * on. Kept so existing calls compile; it will be removed in a future major.
 */
export function addRelationshipMutationOptions<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
  C extends string = string,
>(
  queryClient: QueryClient,
  client: CodedWriteClient<D, A, W, C>,
  type: T,
  id: ResourceId<D, T>,
  rel: R,
  opts?: RelationshipMutationOpts<readonly LinkageRef<string>[], D, T, R>,
): MutationOptions<unknown, readonly LinkageRef<string>[], MutationError<C>> {
  return relationshipMutation(
    'add',
    type,
    id,
    rel,
    opts as never,
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
  R extends RelationName<D, T>,
  C extends string = string,
>(
  queryClient: QueryClient,
  client: CodedWriteClient<D, A, W, C>,
  type: T,
  id: ResourceId<D, T>,
  rel: R,
  opts?: RelationshipMutationOpts<readonly LinkageRef<string>[], D, T, R>,
): MutationOptions<unknown, readonly LinkageRef<string>[], MutationError<C>> {
  return relationshipMutation(
    'remove',
    type,
    id,
    rel,
    opts as never,
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
 * can't know which list subtrees changed membership. For a batch with an optimistic change or one
 * that should invalidate, use {@link jsonApiMutationOptions} with a `mutationFn` calling
 * `client.atomic(...)`.
 *
 * @param queryClient Deprecated and ignored: the upkeep runs on the QueryClient the mutation runs
 * on. Kept so existing calls compile; it will be removed in a future major.
 * @param _descriptor The descriptor, which types the batch's recorder.
 */
export function atomicMutationOptions<D extends ApiDescriptor, A, W, C extends string = string>(
  queryClient: QueryClient,
  client: CodedWriteClient<D, A, W, C>,
  _descriptor: D,
): MutationOptions<AtomicResult[], (tx: AtomicRecorder<D, W>) => unknown, MutationError<C>> {
  return planned({ verb: 'atomic' }, (build) =>
    // The client's `atomic` carries the precise per-op return type; the binding's loose
    // `AtomicResult[]` result is the common supertype (a caller wanting the positional tuple
    // calls `client.atomic` directly — the binding's value is the cache normalization).
    (client as unknown as { atomic: (b: unknown) => Promise<AtomicResult[]> }).atomic(build),
  )
}

// ── Custom writes ───────────────────────────────────────────────────────────────────────────

/** What {@link jsonApiMutationOptions} takes. */
export interface JsonApiMutationConfig<
  TData,
  TVars,
  D extends ApiDescriptor = ApiDescriptor,
  W = unknown,
> {
  /** The write: a custom action, `client.atomic(...)`, or anything resolving a materialised value. */
  mutationFn: (variables: TVars, context: MutationFunctionContext) => Promise<TData>
  /** The mutation's key; `['$custom']` by default. Led by `{ $scope }` in a scope. */
  mutationKey?: readonly string[] | undefined
  /**
   * The change to predict before the write, made through a draft and rolled back on error. A
   * custom write has no built-in change, so `draft.applyDefault()` does nothing.
   */
  optimistic?: OptimisticFn<D, W, TVars> | false | undefined
  /** The queries to invalidate when the write settles, by the last overlapping write to settle. */
  invalidates?: ((variables: TVars) => readonly QueryKey[]) | undefined
  /** The scope the write's server is cached in, when several share the QueryClient. */
  scope?: string | undefined
  /**
   * The descriptor, to type the draft `optimistic` receives. Only its type is used: the upkeep runs
   * with the descriptor installed on the QueryClient for the scope.
   */
  descriptor?: D | undefined
}

/**
 * The options of any write, with the lifecycle of the JSON:API write factories (design B4): its
 * `optimistic` function applied through a draft after the reads it could be overwritten by are
 * cancelled, rolled back on error; its result normalized on success (unless it is an `Accepted`
 * job); and `invalidates`' keys invalidated on settle, by the last overlapping write to settle.
 *
 * ```ts
 * useMutation(
 *   jsonApiMutationOptions({
 *     mutationFn: (albumId: string) => client.albums.id(albumId).actions.publish(),
 *     optimistic: (draft, albumId) => draft.patch('albums', albumId, { status: 'published' }),
 *     invalidates: (albumId) => [resourceKey('albums', albumId)],
 *   }),
 * )
 * ```
 */
export function jsonApiMutationOptions<
  TData,
  TVars,
  D extends ApiDescriptor = ApiDescriptor,
  W = unknown,
>(config: JsonApiMutationConfig<TData, TVars, D, W>): MutationOptions<TData, TVars> {
  const { scope } = config
  const optimistic = typeof config.optimistic === 'function' ? config.optimistic : undefined
  const plan: JsonApiMutationPlan = {
    verb: 'custom',
    ...(config.optimistic === false ? { optimistic: false } : {}),
    ...(scope === undefined ? {} : { scope }),
  }
  const options = planned<TData, TVars, MutationError>(
    plan,
    () => Promise.reject(new Error('unreachable')),
    {
      optimistic: optimistic as JsonApiMutationHooks['optimistic'],
      invalidates: config.invalidates as JsonApiMutationHooks['invalidates'],
    },
  )
  return {
    ...options,
    mutationKey: scopedKey(config.mutationKey ?? CUSTOM_MUTATION_KEY, scope),
    mutationFn: (variables, context) => {
      assertUpkeepRuns(context)
      return stamped(() => config.mutationFn(variables, context))
    },
  }
}

// ── Bound per-type mutation API (sugar over the standalone factories) ────────────────────────

/**
 * Extra options for an `update(...)` mutation: the write `include`/`fields`, the update's
 * `withCount`, `wait` for an update that declares a `202`, plus how it is optimistic: `true`, a
 * function, or `{ into }` placing the members of the relations the patch changes; `false`
 * overrides the mutation cache's default.
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
  W = unknown,
> = WriteMutationOpts<D, T, Inc, F, Wt, 'update', Cnt, V> & {
  optimistic?: OptimisticOption<D, W, V> | undefined
}

/**
 * The relationship-mutation option factories for one relation
 * (`api.<type>.id(id).rel(rel).add(...)`). Refs are typed loosely (`LinkageRef<string>`), parity
 * with the read API; an `into` is typed by the relation. Each accepts an optional
 * {@link RelationshipMutationOpts}.
 */
export interface RelationMutationApi<
  D extends ApiDescriptor = ApiDescriptor,
  T extends TypeName<D> = TypeName<D>,
  R extends RelationName<D, T> = RelationName<D, T>,
  C extends string = string,
> {
  add(
    opts?: RelationshipMutationOpts<readonly LinkageRef<string>[], D, T, R>,
  ): MutationOptions<unknown, readonly LinkageRef<string>[], MutationError<C>>
  remove(
    opts?: RelationshipMutationOpts<readonly LinkageRef<string>[], D, T, R>,
  ): MutationOptions<unknown, readonly LinkageRef<string>[], MutationError<C>>
  replace(
    opts?: RelationshipMutationOpts<readonly LinkageRef<string>[], D, T, R>,
  ): MutationOptions<unknown, readonly LinkageRef<string>[], MutationError<C>>
  set(
    opts?: RelationshipMutationOpts<LinkageRef<string> | null, D, T, R>,
  ): MutationOptions<unknown, LinkageRef<string> | null, MutationError<C>>
}

/** The id-scoped mutation option factories (`api.<type>.id(id).update(...)` etc.). */
export interface HandleMutationApi<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
  C extends string = string,
> {
  update<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Wt extends WaitValue<D, T, 'update'> = undefined,
    const Cnt extends readonly ResourceCountToken<D, T, 'update'>[] = [],
  >(
    ...opts: OptionsArg<
      RequiresRequestMeta<RequestMetaOf<D, T, 'update'>>,
      UpdateMutationOpts<D, T, Inc, F, Wt, Cnt, UpdateInput<D, W, T>, W>
    >
  ): MutationOptions<
    WaitedWriteResult<D, A, T, 'update', WriteResource<D, A, T, Inc, F, Cnt, 'update'>, Wt>,
    UpdateInput<D, W, T>,
    MutationError<C>
  >
  delete(
    ...opts: DeleteMutationArgs<D, T, W>
  ): MutationOptions<DeleteResult<D, T>, void, MutationError<C>>
  rel<R extends RelationName<D, T>>(name: R): RelationMutationApi<D, T, R, C>
}

/** The per-type mutation option factories, with `queryClient`/`client`/`descriptor`/`type` pre-applied. */
export interface TypeMutationApi<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
  C extends string = string,
> {
  create<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Wt extends WaitValue<D, T, 'create'> = undefined,
    const Cnt extends readonly ResourceCountToken<D, T, 'create'>[] = [],
  >(
    ...opts: OptionsArg<
      RequiresRequestMeta<RequestMetaOf<D, T, 'create'>>,
      CreateMutationOpts<D, W, T, Inc, F, Wt, Cnt>
    >
  ): MutationOptions<
    WaitedWriteResult<D, A, T, 'create', WriteResource<D, A, T, Inc, F, Cnt, 'create'>, Wt>,
    CreateInput<D, W, T>,
    MutationError<C>
  >
  /**
   * The update of any resource of the type, taking its id in the variables
   * (`mutate({ id, ...patch })`), so one mutation serves a whole list. Keyed `[type, 'update']`: a
   * filter on one resource's writes matches on the variables instead.
   */
  update<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Wt extends WaitValue<D, T, 'update'> = undefined,
    const Cnt extends readonly ResourceCountToken<D, T, 'update'>[] = [],
  >(
    ...opts: OptionsArg<
      RequiresRequestMeta<RequestMetaOf<D, T, 'update'>>,
      UpdateMutationOpts<D, T, Inc, F, Wt, Cnt, UpdateByIdVariables<D, W, T>, W>
    >
  ): MutationOptions<
    WaitedWriteResult<D, A, T, 'update', WriteResource<D, A, T, Inc, F, Cnt, 'update'>, Wt>,
    UpdateByIdVariables<D, W, T>,
    MutationError<C>
  >
  /**
   * The delete of any resource of the type, taking its id in the variables (`mutate({ id })`).
   * Keyed `[type, 'delete']`.
   */
  delete(
    ...opts: DeleteMutationArgs<D, T, W, DeleteByIdVariables>
  ): MutationOptions<DeleteResult<D, T>, DeleteByIdVariables, MutationError<C>>
  id(id: string): HandleMutationApi<D, A, W, T, C>
}

/**
 * A singleton's mutation option factories (`api.inboxes.update()`), which take no id, as the
 * client's singleton accessor doesn't. The update's variables carry the resource's `id`.
 */
export interface SingletonMutationApi<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
  C extends string = string,
> {
  update<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Wt extends WaitValue<D, T, 'update'> = undefined,
    const Cnt extends readonly ResourceCountToken<D, T, 'update'>[] = [],
  >(
    ...opts: OptionsArg<
      RequiresRequestMeta<RequestMetaOf<D, T, 'update'>>,
      UpdateMutationOpts<D, T, Inc, F, Wt, Cnt, SingletonUpdateInput<D, W, T>, W>
    >
  ): MutationOptions<
    WaitedWriteResult<D, A, T, 'update', WriteResource<D, A, T, Inc, F, Cnt, 'update'>, Wt>,
    SingletonUpdateInput<D, W, T>,
    MutationError<C>
  >
  rel<R extends RelationName<D, T>>(name: R): RelationMutationApi<D, T, R, C>
}

/**
 * The bound mutation API: one {@link TypeMutationApi} per wire type (`api.albums.create()`), or a
 * {@link SingletonMutationApi} for a singleton type.
 */
export type MutationApi<D extends ApiDescriptor, A, W, C extends string = string> = {
  [T in TypeName<D>]: D[T] extends { singleton: true }
    ? SingletonMutationApi<D, A, W, T, C>
    : TypeMutationApi<D, A, W, T, C>
}

/**
 * Bind a client + QueryClient to the per-type mutation option factories:
 * `createMutationApi(queryClient, client, descriptor).albums.id('1').update({ optimistic: true })`
 * returns the same `MutationOptions` as the standalone {@link updateMutationOptions}, with the
 * common arguments pre-applied. A Proxy (descriptor-keyed type validity is enforced by the static
 * `MutationApi` shape) — no per-type allocation until first access.
 *
 * `options.scope` scopes every mutation, for a server sharing the QueryClient with another: its
 * key is led by `{ $scope }`, and its plan carries the scope, so the upkeep runs against the
 * descriptor installed for that scope and invalidates and patches only that scope's queries.
 *
 * @param queryClient Deprecated and ignored: the upkeep runs on the QueryClient the mutation runs
 * on. Kept so existing calls compile; it will be removed in a future major.
 */
export function createMutationApi<D extends ApiDescriptor, A, W, C extends string = string>(
  queryClient: QueryClient,
  client: CodedWriteClient<D, A, W, C>,
  descriptor: D,
  options: ScopeOption = {},
): MutationApi<D, A, W, C> {
  return scopeApi(unscopedMutationApi(queryClient, client, descriptor), options.scope) as never
}

// The bound API's factories, called loosely: the static `MutationApi` shape types every call.
type Loose = (...args: unknown[]) => never

/** The bound mutation API, unscoped. */
function unscopedMutationApi<D extends ApiDescriptor, A, W>(
  queryClient: QueryClient,
  client: WriteClient<D, A, W>,
  descriptor: D,
): MutationApi<D, A, W> {
  const cache = new Map<string, unknown>()
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

/** The relation factories of one parent (`id` `undefined` for a singleton). */
function relationMutationApi<D extends ApiDescriptor, A, W, T extends TypeName<D>>(
  queryClient: QueryClient,
  client: WriteClient<D, A, W>,
  descriptor: D,
  type: T,
  id: ResourceId<D, T>,
  name: RelationName<D, T>,
): RelationMutationApi<D, T> {
  return {
    add: (opts) =>
      (addRelationshipMutationOptions as Loose)(queryClient, client, type, id, name, opts),
    remove: (opts) =>
      (removeRelationshipMutationOptions as Loose)(queryClient, client, type, id, name, opts),
    replace: (opts) =>
      (replaceRelationshipMutationOptions as Loose)(
        queryClient,
        client,
        descriptor,
        type,
        id,
        name,
        opts,
      ),
    set: (opts) =>
      (setRelationshipMutationOptions as Loose)(
        queryClient,
        client,
        descriptor,
        type,
        id,
        name,
        opts,
      ),
  }
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
      (createMutationOptions as Loose)(queryClient, client, descriptor, type, ...opts),
    update: ((opts?: { optimistic?: unknown; meta?: unknown }) =>
      updateByIdMutationOptions(client, type, opts)) as Loose,
    delete: ((opts?: { optimistic?: unknown; meta?: unknown }) =>
      deleteByIdMutationOptions(client, type, opts)) as Loose,
    id: (resource) => {
      // A collection type's id is a string, which the deferred `ResourceId` can't see here.
      const id = resource as ResourceId<D, T>
      return {
        update: (...opts) =>
          (updateMutationOptions as Loose)(queryClient, client, descriptor, type, id, ...opts),
        delete: (...opts) =>
          (deleteMutationOptions as Loose)(queryClient, client, type, resource, ...opts),
        rel: (name) =>
          relationMutationApi(queryClient, client, descriptor, type, id, name) as never,
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
      (updateMutationOptions as Loose)(queryClient, client, descriptor, type, id, ...opts),
    rel: (name) => relationMutationApi(queryClient, client, descriptor, type, id, name) as never,
  }
}
