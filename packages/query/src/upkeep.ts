/**
 * The cache upkeep a JSON:API mutation needs, described as plain data (a {@link JsonApiMutationPlan}
 * carried in the mutation's `meta`) and carried out by {@link JsonApiMutationCache}'s hooks.
 *
 * The PATCH-vs-INVALIDATE split (ADR 0003):
 *  - an UPDATE (or a relationship set/replace) changes a node's attributes or linkage -> on success
 *    {@link normalize} patches the fresh resource everywhere it is cached, silently (no refetch);
 *  - a write that changes which resources a list or relation holds (a create, a delete, a
 *    relationship verb, an update's relations) -> on settle the queries it may have changed are
 *    invalidated by key prefix, by the last overlapping write to settle.
 *
 * OPTIMISTIC writes (design B2): before the write, its predicted change is applied through an
 * optimistic draft (./draft.ts), by a built-in policy derived from the plan and the mutation's
 * variables alone, so it is deterministic, or by the app's own function. An error rolls the draft
 * back; the settle commits it.
 *
 * Everything here is a function of (plan, variables, result or error, QueryClient, descriptor) and
 * of the closures the mutation's options carry under {@link JSON_API_HOOKS}: the plan holds none, so
 * it survives JSON.
 */
import { type ApiDescriptor, isAccepted } from '@haddowg/json-api-client'
import type { Query, QueryClient } from '@tanstack/query-core'
import {
  keyHasPrefix,
  operationKey,
  parentRelationReadKeys,
  type QueryKey,
  resourceKey,
  scopedKey,
  type ScopeSegment,
} from './keys'
import { type DraftRef, type Into, lifecycleOf, type OptimisticDraft } from './draft'
import { normalizeWith, queriesIn, walkResources } from './normalize'
import { describeQuery } from './view-shape'

/** The `meta` key a JSON:API mutation's {@link JsonApiMutationPlan} rides under. */
export const JSON_API_PLAN = 'jsonApi'

/** A write on one resource type: a resource verb, or a relationship verb on one relation. */
export type JsonApiResourceVerb =
  | 'create'
  | 'update'
  | 'delete'
  | 'add'
  | 'remove'
  | 'replace'
  | 'set'

/** Every verb a JSON:API mutation plan names: an atomic batch's and a custom write's included. */
export type JsonApiMutationVerb = JsonApiResourceVerb | 'atomic' | 'custom'

/** A parent relation a created resource is attached to, optimistically and at settle. */
export interface AttachTarget {
  readonly type: string
  readonly id: string
  readonly rel: string
}

/**
 * A write on one type: its verb, its type, the resource's `id` (absent for a create, for a
 * singleton, whose paths carry none, and for a write taking the id in its variables), the relation
 * for a relationship verb, whether the change is applied optimistically (absent: the mutation
 * cache's default), the parent a create attaches to, and the scope its server's reads are cached
 * in (absent unscoped).
 */
export type JsonApiResourcePlan = {
  readonly verb: JsonApiResourceVerb
  readonly type: string
  readonly id?: string
  readonly rel?: string
  readonly optimistic?: boolean
  readonly attachTo?: AttachTarget
  readonly scope?: string
}

/** An atomic batch: its results are normalized, and nothing is invalidated. */
export type JsonApiAtomicPlan = {
  readonly verb: 'atomic'
  readonly scope?: string
}

/**
 * A custom write ({@link jsonApiMutationOptions}): its result is normalized, its optimistic change
 * is the app's function, and what it invalidates the app's `invalidates`.
 */
export type JsonApiCustomPlan = {
  readonly verb: 'custom'
  readonly optimistic?: boolean
  readonly scope?: string
}

/**
 * The cache upkeep of one JSON:API mutation, as plain, JSON-serialisable data. A mutation factory
 * puts it in the options' `meta` under {@link JSON_API_PLAN}; {@link JsonApiMutationCache} reads it
 * back and runs the upkeep it describes.
 */
export type JsonApiMutationPlan = JsonApiResourcePlan | JsonApiAtomicPlan | JsonApiCustomPlan

/**
 * The `meta` of a JSON:API mutation: its plan, under {@link JSON_API_PLAN}, beside any members of
 * the app's own merged in (`meta: { ...options.meta, mine }`).
 */
export type JsonApiMutationMeta = {
  readonly [JSON_API_PLAN]: JsonApiMutationPlan
  readonly [key: string]: unknown
}

/** The key an atomic batch's mutations carry. `$` can't begin a type name, so it can't collide. */
export const ATOMIC_MUTATION_KEY: readonly ['$atomic'] = ['$atomic']

/** The key a custom write carries unless it names its own. */
export const CUSTOM_MUTATION_KEY: readonly ['$custom'] = ['$custom']

/** A JSON:API mutation's key: `[scope?, type, verb, id?, rel?]`, or `[scope?, '$atomic']`. */
export type JsonApiMutationKey = readonly (string | ScopeSegment)[]

/**
 * What a mutation key names: a write's type and verb, its resource's id, its relation, and the
 * scope it is in.
 */
export interface MutationKeyTarget {
  type: string
  verb: JsonApiResourceVerb
  /** The resource's id, omitted for a create, a singleton and a write taking it in its variables. */
  id?: string | undefined
  /** The relation a relationship verb writes. */
  rel?: string | undefined
  /** The scope the write is in, which leads the key as `{ $scope }`. */
  scope?: string | undefined
}

/**
 * The key of a JSON:API mutation: `[type, verb, id?, rel?]`, the id left out for a create, for a
 * singleton (as a singleton's read keys leave it out) and for a write taking the id in its
 * variables, and led by a `{ $scope }` segment in a scope. Mutation filters match by prefix, so
 * `['albums']` finds every unscoped write on albums, `mutationKeyFor({ type: 'albums', verb:
 * 'update' })` every update of one, and the full key one resource's (or one relation's) writes. A
 * key only ever grows by trailing segments.
 */
export function mutationKeyFor(target: MutationKeyTarget): JsonApiMutationKey {
  const key = [target.type, target.verb]
  if (target.id !== undefined) {
    key.push(target.id)
  }
  if (target.rel !== undefined) {
    key.push(target.rel)
  }
  return scopedKey(key, target.scope)
}

/** The plan a mutation's `meta` carries, when it is a JSON:API mutation's. */
export function planOf(meta: unknown): JsonApiMutationPlan | undefined {
  if (typeof meta !== 'object' || meta === null) {
    return undefined
  }
  const plan = (meta as Record<string, unknown>)[JSON_API_PLAN]
  return typeof plan === 'object' && plan !== null && 'verb' in plan
    ? (plan as JsonApiMutationPlan)
    : undefined
}

/** The key a plan's mutation carries. */
export function planKey(plan: JsonApiMutationPlan): JsonApiMutationKey {
  if (plan.verb === 'atomic') {
    return scopedKey(ATOMIC_MUTATION_KEY, plan.scope)
  }
  if (plan.verb === 'custom') {
    return scopedKey(CUSTOM_MUTATION_KEY, plan.scope)
  }
  return mutationKeyFor(plan)
}

// ── The closures a mutation's options carry ────────────────────────────────────────────────

/**
 * The key a JSON:API mutation's options carry their closures under: its optimistic function, its
 * explicit placement, its invalidation and its id generator. They live on the options, beside
 * `mutationFn`, rather than in the plan, which stays plain data.
 *
 * @internal
 */
export const JSON_API_HOOKS: unique symbol = Symbol.for('@haddowg/json-api-query/hooks') as never

/**
 * The draft an optimistic function receives: an {@link OptimisticDraft} whose `applyDefault()`
 * applies the write's built-in optimistic change, which the function otherwise replaces.
 */
export type MutationDraft<D extends ApiDescriptor = ApiDescriptor, W = unknown> = OptimisticDraft<
  D,
  W
> & {
  /** Apply the write's built-in optimistic change (once, however often it is called). */
  applyDefault(): void
}

/** An optimistic function: the change to predict for `variables`, made through `draft`. */
export type OptimisticFn<D extends ApiDescriptor = ApiDescriptor, W = unknown, V = unknown> = (
  draft: MutationDraft<D, W>,
  variables: V,
) => void

/**
 * How a write is optimistic: `true` for its built-in change, `false` for none (overriding the
 * mutation cache's default), a function predicting the change itself (calling
 * `draft.applyDefault()` to keep the built-in step), or `{ into }`, the built-in change with an
 * explicit placement for the views it adds to.
 */
export type OptimisticOption<
  D extends ApiDescriptor = ApiDescriptor,
  W = unknown,
  V = unknown,
  I = Into<D>,
> = boolean | OptimisticFn<D, W, V> | { readonly into?: I | undefined }

/** The closures a JSON:API mutation's options carry under {@link JSON_API_HOOKS}. @internal */
export interface JsonApiMutationHooks {
  readonly optimistic?: OptimisticFn<never, never, never> | undefined
  /** The placement of the views the write's own adding operations consider. */
  readonly into?: Into | undefined
  /** A create's placement of the views of the relation it attaches to. */
  readonly attachInto?: Into | undefined
  readonly invalidates?: ((variables: never) => readonly QueryKey[]) | undefined
  readonly clientId?: (() => string) | undefined
  /** A create's completion of the attributes only the server sets, from its input. */
  readonly complete?: ((input: never) => unknown) | undefined
}

/** The closures `options` carry, or none. @internal */
export function hooksOf(options: unknown): JsonApiMutationHooks {
  const hooks =
    typeof options === 'object' && options !== null
      ? (options as { [JSON_API_HOOKS]?: unknown })[JSON_API_HOOKS]
      : undefined
  return typeof hooks === 'object' && hooks !== null ? (hooks as JsonApiMutationHooks) : {}
}

/** Whether the `optimistic` option asks for optimism: `undefined` when it leaves it to the cache. */
export function optimismOf(
  option: OptimisticOption<never, never, never, never> | undefined,
): boolean | undefined {
  return option === undefined ? undefined : option !== false
}

/** The closures an `optimistic` option contributes: a create's `complete` too. */
export function optimisticHooks(
  option: OptimisticOption<never, never, never, never> | undefined,
): Pick<JsonApiMutationHooks, 'optimistic' | 'into' | 'complete'> {
  if (typeof option === 'function') {
    return { optimistic: option }
  }
  if (typeof option === 'object' && option !== null) {
    const { into, complete } = option as { into?: unknown; complete?: unknown }
    return {
      ...(into === undefined ? {} : { into: into as Into }),
      ...(typeof complete === 'function'
        ? { complete: complete as JsonApiMutationHooks['complete'] }
        : {}),
    }
  }
  return {}
}

// ── Ids for an optimistic create (D6) ──────────────────────────────────────────────────────

/** What a temporary id begins with. */
export const TEMP_ID_PREFIX = '$tmp:'

/**
 * The member of a create's variables carrying the temporary id of a type that doesn't require a
 * client id (`optional` or `forbidden`).
 */
export const TEMP_ID_MEMBER = '$tempId'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A random UUID, from `crypto.randomUUID()`. */
function uuid(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * The id an optimistic create's row carries, written into the variables so it persists with the
 * mutation. A type whose `clientId` is `required` gets a generated `id`, sent with the create;
 * every other type a temporary `$tempId`, never sent, which the server's id replaces on success.
 * An id the variables already carry is kept, so a resumed mutation never mints a second one, and
 * so is an `id` the caller gave an `optional` type, which is sent as the final id. `undefined` when
 * the variables can't carry one.
 */
export function prepareCreateId(
  plan: JsonApiResourcePlan,
  variables: unknown,
  descriptor: ApiDescriptor,
  hooks: JsonApiMutationHooks,
): string | undefined {
  if (!isRecord(variables)) {
    return undefined
  }
  const policy = descriptor[plan.type]?.clientId
  const own = variables['id']
  if (policy !== undefined && policy !== 'forbidden' && typeof own === 'string') {
    return own
  }
  const member = policy === 'required' ? 'id' : TEMP_ID_MEMBER
  const existing = variables[member]
  if (typeof existing === 'string') {
    return existing
  }
  if (!Object.isExtensible(variables)) {
    return undefined
  }
  const generated = hooks.clientId?.() ?? uuid()
  const id = member === 'id' ? generated : `${TEMP_ID_PREFIX}${generated}`
  variables[member] = id
  return id
}

/** A create's input without its `$tempId`, which is never sent. */
export function withoutTempId<V>(variables: V): V {
  if (!isRecord(variables) || !Object.hasOwn(variables, TEMP_ID_MEMBER)) {
    return variables
  }
  const { [TEMP_ID_MEMBER]: _temp, ...input } = variables
  return input as V
}

/** The temporary id a create's variables carry, if any. */
export function tempIdOf(variables: unknown): string | undefined {
  const id = isRecord(variables) ? variables[TEMP_ID_MEMBER] : undefined
  return typeof id === 'string' ? id : undefined
}

// ── Optimistic (before the write) ──────────────────────────────────────────────────────────

/** The id a write addresses: its plan's, else the one its variables carry. */
export function targetIdOf(plan: JsonApiResourcePlan, variables: unknown): string | undefined {
  if (plan.id !== undefined) {
    return plan.id
  }
  const id = isRecord(variables) ? variables['id'] : undefined
  return typeof id === 'string' ? id : undefined
}

/**
 * Apply the write's optimistic change to `draft`: the app's function when the options carry one
 * (whose `draft.applyDefault()` applies the built-in change), else the built-in change. Run inside
 * one `draft.batch`, so each query it touches is published once. Returns whether the built-in
 * change ran.
 */
export function applyOptimistic(
  plan: JsonApiMutationPlan,
  variables: unknown,
  draft: OptimisticDraft,
  hooks: JsonApiMutationHooks,
  createdId: string | undefined,
): boolean {
  const builtIn = () => applyPolicy(plan, variables, draft, hooks, createdId)
  const custom = hooks.optimistic as OptimisticFn | undefined
  if (custom === undefined) {
    builtIn()
    return true
  }
  let applied = false
  const applyDefault = () => {
    if (!applied) {
      applied = true
      builtIn()
    }
  }
  custom(mutationDraft(draft, applyDefault), variables)
  return applied
}

/** `draft` with `applyDefault`, its methods bound to it. */
function mutationDraft(draft: OptimisticDraft, applyDefault: () => void): MutationDraft {
  return {
    scope: draft.scope,
    patch: (...args) => draft.patch(...args),
    link: (...args) => draft.link(...args),
    attach: (...args) => draft.attach(...args),
    detach: (...args) => draft.detach(...args),
    replaceMembers: (...args) => draft.replaceMembers(...args),
    insert: (...args) => draft.insert(...args),
    evict: (...args) => draft.evict(...args),
    resolve: (...args) => draft.resolve(...args),
    batch: (fn) => draft.batch(fn),
    rollback: () => draft.rollback(),
    commit: () => draft.commit(),
    touchedKeys: () => draft.touchedKeys(),
    deferred: () => draft.deferred(),
    applyDefault,
  }
}

/**
 * The built-in optimistic change (design B2):
 *
 * - `update`: `patch`, attributes and relations alike, on the id the plan or the variables name;
 * - `delete`: `evict`;
 * - `set`: `link` (or clear) the to-one; `add`, `remove`, `replace`: `attach`, `detach`,
 *   `replaceMembers` the to-many;
 * - `create`: `insert` the new resource, placed only by `into` and completed by `complete`, and
 *   `attach` it to `attachTo`.
 */
function applyPolicy(
  plan: JsonApiMutationPlan,
  variables: unknown,
  draft: OptimisticDraft,
  hooks: JsonApiMutationHooks,
  createdId: string | undefined,
): void {
  if (plan.verb === 'atomic' || plan.verb === 'custom') {
    return
  }
  const { type, id, rel } = plan
  switch (plan.verb) {
    case 'update': {
      const target = targetIdOf(plan, variables)
      if (target !== undefined) {
        draft.patch(type, target, (isRecord(variables) ? variables : {}) as never)
      }
      return
    }
    case 'delete': {
      const target = targetIdOf(plan, variables)
      if (target !== undefined) {
        draft.evict(type, target)
      }
      return
    }
    case 'create': {
      if (createdId === undefined || !isRecord(variables)) {
        return
      }
      const input = withoutTempId(variables)
      const resource = { ...input, id: createdId }
      const completion = (hooks.complete as ((input: unknown) => unknown) | undefined)?.(input)
      draft.insert(type, resource as never, hooks.into, {
        complete: isRecord(completion) ? completion : undefined,
      })
      if (plan.attachTo !== undefined) {
        const { type: parent, id: parentId, rel: relation } = plan.attachTo
        draft.attach(parent, parentId, relation, [{ ...resource, type }], {
          into: hooks.attachInto,
        })
      }
      return
    }
    case 'set':
      if (rel !== undefined) {
        draft.link(type, id, rel, variables as DraftRef | null)
      }
      return
    default: {
      if (rel === undefined) {
        return
      }
      const refs = (Array.isArray(variables) ? variables : []) as readonly DraftRef[]
      if (plan.verb === 'add') {
        draft.attach(type, id, rel, refs)
      } else if (plan.verb === 'remove') {
        draft.detach(type, id, rel, refs)
      } else {
        draft.replaceMembers(type, id, rel, refs)
      }
    }
  }
}

/**
 * In development, warn when an optimistic create shows in no cached view: no list took it as a
 * member or a pending entry, and `attachTo`'s relation neither placed nor deferred it. Names the
 * type and why. Silent under `NODE_ENV=production`.
 */
export function warnIfPlacedNowhere(
  plan: JsonApiResourcePlan,
  queryClient: QueryClient,
  descriptor: ApiDescriptor,
  draft: OptimisticDraft,
  hooks: JsonApiMutationHooks,
  createdId: string,
): void {
  if (
    globalThis.process?.env?.NODE_ENV === 'production' ||
    lifecycleOf(draft as never).shows(plan.type, createdId)
  ) {
    return
  }
  const lists = queriesIn(queryClient, plan.scope).filter((query) => {
    const description = describeQuery(query, descriptor)
    return (
      description?.operation === 'fetchMany' &&
      description.type === plan.type &&
      !description.skipped &&
      query.state.data !== undefined
    )
  }).length
  const why =
    hooks.into === undefined
      ? 'no `into` was given, so it goes in no list' +
        (plan.attachTo === undefined ? '' : ", and `attachTo`'s relation has no cached view")
      : lists === 0
        ? `no list of ${plan.type} is cached`
        : `\`into\` placed it in none of the ${lists} cached list${lists === 1 ? '' : 's'} of ${plan.type}`
  console.warn(
    `@haddowg/json-api-query: an optimistic create of ${plan.type} shows in no cached view: ` +
      `${why}. It appears once the write settles and the lists refetch.`,
  )
}

// ── What a write reconciles ──────────────────────────────────────────────────────────────

/** The reads of one parent's relation, and the parent's own reads (whose includes embed it). */
function relationKeys(
  type: string,
  id: string | undefined,
  rel: string,
  scope: string | undefined,
): QueryKey[] {
  const parent =
    id === undefined ? operationKey(type, 'fetchOne', scope) : resourceKey(type, id, scope)
  return [...parentRelationReadKeys(type, id, rel, scope), parent]
}

/** The reads of a resource itself: its `fetchOne`, related and relationship reads. */
export function ownReadKeys(type: string, id: string, scope: string | undefined): QueryKey[] {
  return [
    resourceKey(type, id, scope),
    scopedKey([type, 'fetchRelated', id], scope),
    scopedKey([type, 'fetchRelationship', id], scope),
  ]
}

/** Whether a query is one of `type:id`'s own reads. */
function isOwnRead(query: Query, descriptor: ApiDescriptor, type: string, id: string): boolean {
  const description = describeQuery(query, descriptor)
  return (
    description !== undefined &&
    description.type === type &&
    description.id === id &&
    description.operation !== 'fetchMany'
  )
}

/** Whether a query's data holds `type:id` anywhere. */
function holds(query: Query, descriptor: ApiDescriptor, type: string, id: string): boolean {
  let found = false
  walkResources(query.state.data, descriptor, (node) => {
    found ||= node.type === type && node.id === id
  })
  return found
}

/**
 * The keys a write invalidates when it settles, before any its draft adds (design B1b):
 *
 * - `create`: the type's lists, and `attachTo`'s relation and parent;
 * - `update`: each relation its variables change, and the parent's reads;
 * - `delete`: the type's lists, and every other query holding the resource (its own reads are
 *   removed when the delete succeeds);
 * - a relationship verb: the relation's reads and the parent's;
 * - a custom write: what its `invalidates` returns; an atomic batch: nothing.
 */
export function planKeys(
  plan: JsonApiMutationPlan,
  variables: unknown,
  queryClient: QueryClient,
  descriptor: ApiDescriptor,
  hooks: JsonApiMutationHooks,
): QueryKey[] {
  const { scope } = plan
  switch (plan.verb) {
    case 'atomic':
      return []
    case 'custom': {
      const invalidates = hooks.invalidates as
        | ((variables: unknown) => readonly QueryKey[])
        | undefined
      return (invalidates?.(variables) ?? []).map((key) => scopedKey(key, scope))
    }
    case 'create': {
      const lists: QueryKey[] = [operationKey(plan.type, 'fetchMany', scope)]
      const parent = plan.attachTo
      return parent === undefined
        ? lists
        : [...lists, ...relationKeys(parent.type, parent.id, parent.rel, scope)]
    }
    case 'update': {
      if (!isRecord(variables)) {
        return []
      }
      // A singleton's keys carry no id, though its update's variables name one.
      const singleton = descriptor[plan.type]?.singleton === true
      const id = singleton ? undefined : targetIdOf(plan, variables)
      if (!singleton && id === undefined) {
        return []
      }
      const relations = descriptor[plan.type]?.relations ?? {}
      return Object.keys(variables)
        .filter((key) => key in relations)
        .flatMap((rel) => relationKeys(plan.type, id, rel, scope))
    }
    case 'delete': {
      const id = targetIdOf(plan, variables)
      const keys: QueryKey[] = [operationKey(plan.type, 'fetchMany', scope)]
      if (id === undefined) {
        return keys
      }
      for (const query of queriesIn(queryClient, scope)) {
        if (
          !isOwnRead(query, descriptor, plan.type, id) &&
          holds(query, descriptor, plan.type, id)
        ) {
          keys.push(query.queryKey as QueryKey)
        }
      }
      return keys
    }
    default:
      return plan.rel === undefined ? [] : relationKeys(plan.type, plan.id, plan.rel, scope)
  }
}

/**
 * The cached queries of the scope a fetch is in flight for that an optimistic change could be
 * overwritten by: those under one of `keys`, and those holding a resource the write addresses.
 */
export function fetchingTargets(
  plan: JsonApiMutationPlan,
  variables: unknown,
  queryClient: QueryClient,
  descriptor: ApiDescriptor,
  keys: readonly QueryKey[],
): Query[] {
  const addressed: { type: string; id: string }[] = []
  if (plan.verb !== 'atomic' && plan.verb !== 'custom') {
    const id = targetIdOf(plan, variables)
    if (id !== undefined && plan.verb !== 'create') {
      addressed.push({ type: plan.type, id })
    }
    if (plan.attachTo !== undefined) {
      addressed.push({ type: plan.attachTo.type, id: plan.attachTo.id })
    }
  }
  return queriesIn(queryClient, plan.scope).filter(
    (query) =>
      query.state.fetchStatus === 'fetching' &&
      (keys.some((key) => keyHasPrefix(query.queryKey as QueryKey, key)) ||
        addressed.some(({ type, id }) => holds(query, descriptor, type, id))),
  )
}

// ── On success ───────────────────────────────────────────────────────────────────────────

/**
 * Normalize what the write resolved to, for the verbs whose response is a resource or linkage:
 * a create or update, a relationship set or replace, an atomic batch's results and a custom
 * write's result, unless it resolved to an `Accepted` job. A delete and a relationship add or
 * remove normalize nothing. `wins` names the fields the write's draft predicted, whose value in the
 * response wins over any read that landed while it was pending.
 */
export function normalizeResult(
  plan: JsonApiMutationPlan,
  data: unknown,
  queryClient: QueryClient,
  descriptor: ApiDescriptor,
  wins?: ReadonlySet<string>,
): void {
  switch (plan.verb) {
    case 'create':
    case 'update':
    case 'set':
    case 'replace':
    case 'atomic':
    case 'custom':
      if (!isAccepted(data)) {
        normalizeWith(queryClient, data, descriptor, plan.scope, wins)
      }
      return
    default:
      return
  }
}

/**
 * Swap a create's temporary id for the server's: on every cached copy and deferred member (through
 * the draft), and in the key of every cached query keyed by it, whose data moves to the server id's
 * key. A query keyed by the temporary id is removed unless something still observes it.
 */
export function swapTempId(
  queryClient: QueryClient,
  descriptor: ApiDescriptor,
  plan: JsonApiResourcePlan,
  draft: OptimisticDraft | undefined,
  temp: string,
  id: string,
): void {
  if (draft !== undefined) {
    lifecycleOf(draft as never).swapId(plan.type, temp, id)
  }
  for (const query of queriesIn(queryClient, plan.scope)) {
    const description = describeQuery(query, descriptor)
    if (description?.type !== plan.type || description.id !== temp) {
      continue
    }
    const key = (query.queryKey as readonly unknown[]).map((segment) =>
      segment === temp ? id : segment,
    )
    if (queryClient.getQueryData(key) === undefined && query.state.data !== undefined) {
      queryClient.setQueryData(key, query.state.data, { updatedAt: query.state.dataUpdatedAt })
    }
    if (query.getObserversCount() === 0) {
      queryClient.getQueryCache().remove(query)
    }
  }
}
