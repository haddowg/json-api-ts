/**
 * The cache upkeep a JSON:API mutation needs, described as plain data (a {@link JsonApiMutationPlan}
 * carried in the mutation's `meta`) and carried out by {@link JsonApiMutationCache}'s hooks.
 *
 * The PATCH-vs-INVALIDATE split (ADR 0003):
 *  - an UPDATE (or a relationship set/replace) only changes a node's attributes/linkage, never
 *    collection membership -> on success {@link normalize} patches the fresh resource everywhere it
 *    is cached, silently (no refetch);
 *  - a CREATE or DELETE (or a relationship add/remove/set/replace) changes which resources a list or
 *    relationship holds -> on settle the relevant query subtrees are invalidated by key PREFIX.
 *
 * OPTIMISTIC updates (update and the relationship verbs): before the write, the expected change is
 * applied through the same normalized patch and the touched queries are snapshotted; an error
 * restores the snapshot. The change is derived from the plan and the mutation's variables alone, so
 * it is deterministic.
 *
 * Every function here is a pure function of (plan, variables, result or error, QueryClient,
 * descriptor): the plan holds no closures, so it survives JSON.
 */
import { type ApiDescriptor, isAccepted, type LinkageRef } from '@haddowg/json-api-client'
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

/** Every verb a JSON:API mutation plan names, an atomic batch's included. */
export type JsonApiMutationVerb = JsonApiResourceVerb | 'atomic'

/**
 * A write on one type: its verb, its type, the resource's `id` (absent for a create and for a
 * singleton, whose paths carry none), the relation for a relationship verb, and whether the change
 * is applied optimistically.
 */
export type JsonApiResourcePlan = {
  readonly verb: JsonApiResourceVerb
  readonly type: string
  readonly id?: string
  readonly rel?: string
  readonly optimistic: boolean
}

/** An atomic batch: its results are normalized, and nothing is invalidated. */
export type JsonApiAtomicPlan = {
  readonly verb: 'atomic'
}

/**
 * The cache upkeep of one JSON:API mutation, as plain, JSON-serialisable data. A mutation factory
 * puts it in the options' `meta` under {@link JSON_API_PLAN}; {@link JsonApiMutationCache} reads it
 * back and runs the upkeep it describes.
 */
export type JsonApiMutationPlan = JsonApiResourcePlan | JsonApiAtomicPlan

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

/** What a mutation key names: a write's type and verb, its resource's id, and its relation. */
export interface MutationKeyTarget {
  type: string
  verb: JsonApiResourceVerb
  /** The resource's id, omitted for a create and for a singleton. */
  id?: string | undefined
  /** The relation a relationship verb writes. */
  rel?: string | undefined
}

/**
 * The key of a JSON:API mutation: `[type, verb, id?, rel?]`, the id left out for a create and for a
 * singleton, as a singleton's read keys leave it out. Mutation filters match by prefix, so
 * `['albums']` finds every write on albums, `mutationKeyFor({ type: 'albums', verb: 'update' })`
 * every update of one, and the full key one resource's (or one relation's) writes. A key only
 * ever grows by trailing segments.
 */
export function mutationKeyFor(target: MutationKeyTarget): readonly string[] {
  const key = [target.type, target.verb]
  if (target.id !== undefined) {
    key.push(target.id)
  }
  if (target.rel !== undefined) {
    key.push(target.rel)
  }
  return key
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
export function planKey(plan: JsonApiMutationPlan): readonly string[] {
  return plan.verb === 'atomic' ? ATOMIC_MUTATION_KEY : mutationKeyFor(plan)
}

// ── Optimistic (before the write) ──────────────────────────────────────────────────────────

/**
 * Apply the plan's optimistic change for `variables` and return the snapshot that undoes it, or
 * `undefined` when the plan isn't optimistic.
 */
export function applyOptimistic(
  plan: JsonApiMutationPlan,
  variables: unknown,
  queryClient: QueryClient,
  descriptor: ApiDescriptor,
): Snapshot | undefined {
  if (plan.verb === 'atomic' || !plan.optimistic) {
    return undefined
  }
  const { type, id, rel } = plan
  switch (plan.verb) {
    case 'update': {
      const input = (variables ?? {}) as Record<string, unknown>
      // A singleton's input names the resource the patch lands on.
      const target = id ?? input['id']
      return typeof target === 'string'
        ? applyOptimisticPatch(
            queryClient,
            type,
            target,
            attributesFromPatch(descriptor, type, input),
            descriptor,
          )
        : undefined
    }
    case 'set': {
      if (rel === undefined) {
        return undefined
      }
      const ref = variables as LinkageRef<string> | null
      return applyOptimisticToOne(
        queryClient,
        type,
        id,
        rel,
        ref === null ? null : toMembershipRef(ref),
      )
    }
    case 'replace':
    case 'add':
    case 'remove': {
      if (rel === undefined) {
        return undefined
      }
      const refs = membershipRefs(variables as readonly LinkageRef<string>[])
      const verb = plan.verb
      return applyOptimisticMembership(queryClient, type, id, rel, (current) => {
        if (verb === 'replace') {
          // The optimistic set IS the new refs (order preserved), regardless of the current members.
          return refs
        }
        if (verb === 'add') {
          // Append the added refs, skipping any already present (an add is idempotent on membership).
          const kept = current.filter((m) => !refs.some((a) => sameRef(a, m)))
          return [...kept, ...refs]
        }
        return current.filter((m) => !refs.some((r) => sameRef(r, m)))
      })
    }
    default:
      // create and delete change membership, which no node patch can predict.
      return undefined
  }
}

// ── On success ───────────────────────────────────────────────────────────────────────────

/**
 * Normalize what the write resolved to, for the verbs whose response is a resource or linkage:
 * a create or update (unless it resolved to an `Accepted` job), a relationship set or replace, and
 * an atomic batch's results. A delete and a relationship add or remove normalize nothing.
 */
export function normalizeResult(
  plan: JsonApiMutationPlan,
  data: unknown,
  queryClient: QueryClient,
  descriptor: ApiDescriptor,
): void {
  switch (plan.verb) {
    case 'create':
    case 'update':
      if (!isAccepted(data)) {
        normalize(queryClient, data, descriptor)
      }
      return
    case 'set':
    case 'replace':
    case 'atomic':
      normalize(queryClient, data, descriptor)
      return
    default:
      return
  }
}

// ── On settle (success or error) ──────────────────────────────────────────────────────────

/**
 * Invalidate what the write may have changed, whether it succeeded or failed: a create the type's
 * lists, a delete the type's lists and the resource's own reads, and a relationship verb the
 * parent's reads of that relation and the parent itself. An update and an atomic batch invalidate
 * nothing. The returned promise settles once the invalidation (and any refetch it starts) has.
 */
export function invalidateFor(plan: JsonApiMutationPlan, queryClient: QueryClient): Promise<void> {
  switch (plan.verb) {
    case 'create':
      return invalidateLists(queryClient, plan.type)
    case 'delete':
      return plan.id === undefined
        ? invalidateLists(queryClient, plan.type)
        : invalidateLists(queryClient, plan.type).then(() =>
            invalidateResource(queryClient, plan.type, plan.id as string),
          )
    case 'add':
    case 'remove':
    case 'replace':
    case 'set':
      return plan.rel === undefined
        ? Promise.resolve()
        : invalidateParentRelations(queryClient, plan.type, plan.id, plan.rel)
    default:
      return Promise.resolve()
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

// ── Helpers ───────────────────────────────────────────────────────────────────────────────

/**
 * Coerce a linkage ref (`{type,id}` / `{type,lid}` / a resource view, optionally `$pivot`) to a
 * membership ref for the optimistic patch. The whole ref is preserved (so a hydrated member
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
