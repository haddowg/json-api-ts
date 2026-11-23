/**
 * Reads propagate relationships (design A7 R3, under B1a's fit rules).
 *
 * A read carries each resource's relationships as linkage. Besides patching the attributes it
 * carries (./normalize.ts), a read updates each relation it carries linkage for on the resource's
 * other cached copies in the same scope:
 *
 * - **To-one linkage** replaces the slot's member when it differs. `null` always applies; a slot of
 *   identifiers takes the new target's identifier; a slot of resources takes the target only in the
 *   shape the slot promises, resolved from the copy the read carries, else the richest cached copy.
 * - **Complete to-many linkage** (no `next` or `prev` link, and not narrowed by the read's
 *   `relatedQuery`) replaces the slot's members, keeping each member the slot already holds and
 *   building the others as per-edge views carrying the linkage's meta. A slot of resources is
 *   replaced only when every member fits it.
 * - **Windowed linkage** never stands for the whole list, and changes no membership.
 *
 * A slot that would change but can't be filled is left alone and its query invalidated: an active
 * query refetches, an inactive one goes stale. A links-only slot is left alone (nothing is known of
 * its membership), as is a slot whose view filters the relation's members, which no linkage can
 * fill. The query the read landed in is never invalidated.
 *
 * **Freshness (R1).** Each slot records the stamp of the linkage it holds, alongside the node's
 * attribute records: the read that materialised it, else the read whose linkage was last written
 * into it. A read's linkage is written only into a slot holding no newer linkage; where a cached
 * copy holds newer linkage than the read, that linkage is what propagates (into the read's own
 * copies too, where it fits).
 *
 * **Optimistic drafts (R2).** A slot an open draft owns (the draft edited that relation) isn't
 * changed by a read. The linkage it brings is recorded on the draft's {@link SlotClaim} instead, and
 * a rollback writes it, so the slot shows the newest server membership.
 *
 * **No refetch loops.** A refetched query is newer than the read that invalidated it, so its
 * linkage updates the others and theirs never overwrites it. And a refetch R3 caused writes in
 * place but invalidates nothing, so two views whose server answers keep disagreeing settle after
 * one refetch rather than invalidating each other in turn.
 *
 * @internal
 */
import type { ApiDescriptor } from '@haddowg/json-api-client'
import type { Query, QueryClient } from '@tanstack/query-core'
import { bornOf, partsOf, recordSlot, targetOf, withMembers, writtenSlot } from './normalize'
import { addresses, identityKey, identityOf, isRecord } from './identity'
import { type CacheView, describeCached, touchNode, type Visit } from './cache-index'
import { memberViewFor } from './resolve'
import {
  fits,
  isComplete,
  type QueryDescription,
  slotShape,
  type ViewShape,
  walkShaped,
} from './view-shape'

// ── Linkage ────────────────────────────────────────────────────────────────────────────────

/** One linkage member: its identity and its identifier-level meta (a pivot rides there). */
export interface LinkageMember {
  readonly type: string
  readonly id: string
  readonly meta?: Record<string, unknown>
}

/** A relation's linkage as the server sent it. */
export type SlotLinkage =
  | { readonly kind: 'one'; readonly target: LinkageMember | null }
  | {
      readonly kind: 'many'
      readonly members: readonly LinkageMember[]
      /** Whether the linkage is the whole relation: no `next`/`prev` link, nor a narrowing query. */
      readonly complete: boolean
    }

/** The linkage a relation slot holds from the server, and the stamp of the read it came from. */
export interface ServerSlot {
  readonly stamp: number
  readonly linkage: SlotLinkage
}

/** A linkage member, when `value` is one with a string `type` and `id`. */
function memberOf(value: unknown): LinkageMember | undefined {
  const identity = identityOf(value)
  if (identity === undefined) {
    return undefined
  }
  const meta = (value as Record<string, unknown>)['meta']
  return isRecord(meta) ? { ...identity, meta } : identity
}

/** Whether a relationship's `links` carry a `rel` link. */
function hasLink(links: unknown, rel: string): boolean {
  if (!isRecord(links)) {
    return false
  }
  const link = links[rel]
  return typeof link === 'string' || (isRecord(link) && typeof link['href'] === 'string')
}

/** A relationship object's linkage, or `undefined` when it carries none the cache can use. */
function linkageOf(
  data: unknown,
  links: unknown,
  cardinality: 'one' | 'many',
): SlotLinkage | undefined {
  if (cardinality === 'one') {
    if (data === null) {
      return { kind: 'one', target: null }
    }
    const target = memberOf(data)
    return target === undefined ? undefined : { kind: 'one', target }
  }
  if (!Array.isArray(data)) {
    return undefined
  }
  const members: LinkageMember[] = []
  for (const item of data) {
    const member = memberOf(item)
    if (member === undefined) {
      return undefined
    }
    members.push(member)
  }
  return {
    kind: 'many',
    members,
    complete: !hasLink(links, 'next') && !hasLink(links, 'prev'),
  }
}

/**
 * Whether relation slot `rel` of `node` is links-only: nothing is known of its membership. A to-one
 * is `undefined`; a to-many the response sent no linkage for still materialises as an empty array,
 * which its `$rel()` tells apart.
 * @internal
 */
export function linksOnly(node: Record<string, unknown>, rel: string, slot: unknown): boolean {
  if (slot === undefined) {
    return true
  }
  if (!Array.isArray(slot)) {
    return false
  }
  const view = relationshipOf(node, rel)
  return isRecord(view) && !('data' in view)
}

/** The raw relationship object `node`'s `$rel(rel)` exposes, when it has the accessor. */
function relationshipOf(node: Record<string, unknown>, rel: string): unknown {
  const $rel = node['$rel']
  return typeof $rel === 'function'
    ? ($rel as (name: string) => unknown).call(node, rel)
    : undefined
}

/**
 * The server linkage relation slot `rel` of `node` holds: what a read last wrote there, else what
 * the node was materialised with (its `$rel(rel)`), stamped with its birth. `undefined` when it
 * holds none (links-only, or not rendered).
 */
function heldSlot(
  node: Record<string, unknown>,
  rel: string,
  cardinality: 'one' | 'many',
): ServerSlot | undefined {
  const written = writtenSlot(node, rel)
  if (written !== undefined) {
    return written
  }
  const view = relationshipOf(node, rel)
  if (!isRecord(view) || !('data' in view)) {
    return undefined
  }
  const linkage = linkageOf(view['data'], view['links'], cardinality)
  return linkage === undefined ? undefined : { stamp: bornOf(node), linkage }
}

/** Whether a linkage tells the whole relation: a to-one always, a to-many when complete. */
const whole = (linkage: SlotLinkage): boolean => linkage.kind === 'one' || linkage.complete

/** Whether a view's `relatedQuery` narrows relation `rel`'s members by a filter or a sort. */
function narrowed(
  description: QueryDescription | undefined,
  rel: string,
): 'filter' | 'sort' | undefined {
  const entry = description?.params.relatedQuery?.[rel]
  if (entry === undefined) {
    return undefined
  }
  if (entry.filter !== undefined && Object.keys(entry.filter).length > 0) {
    return 'filter'
  }
  return entry.sort !== undefined && entry.sort.length > 0 ? 'sort' : undefined
}

// ── Claims: the relations an open optimistic draft owns (design A7 R2) ─────────────────────

/** The newest server value a read brought for one slot a draft owns, recorded for a rollback. */
export interface SlotServerValue {
  readonly node: Record<string, unknown>
  readonly query: Query
  readonly slot: ServerSlot
  /** Whether the linkage fills the slot; when it doesn't, a rollback invalidates the query. */
  readonly fits: boolean
  /** The slot's value under that linkage, when it fits. */
  readonly value: unknown
}

/**
 * One relation of one resource an open optimistic draft edited. While it stands, a read's linkage
 * for the relation changes none of its slots: it is recorded here, by the slot's node, for a
 * rollback to show.
 * @internal
 */
export interface SlotClaim {
  readonly owner: object
  readonly scope: string | undefined
  readonly type: string
  /** `undefined` for a singleton addressed by type alone. */
  readonly id: string | undefined
  readonly rel: string
  seq: number
  readonly server: Map<object, SlotServerValue>
}

const slotClaims = new WeakMap<QueryClient, Set<SlotClaim>>()

let slotSeq = 0

/**
 * Add `claim` as the latest owner of its relation.
 * @internal
 */
export function addSlotClaim(queryClient: QueryClient, claim: SlotClaim): void {
  const claims = slotClaims.get(queryClient) ?? new Set<SlotClaim>()
  slotClaims.set(queryClient, claims)
  slotSeq += 1
  claim.seq = slotSeq
  claims.add(claim)
}

/**
 * Remove `claim`.
 * @internal
 */
export function removeSlotClaim(queryClient: QueryClient, claim: SlotClaim): void {
  slotClaims.get(queryClient)?.delete(claim)
}

/**
 * The latest claim on relation `rel` of `type:id` in `scope`: one naming the id, or one a singleton
 * made by type alone.
 * @internal
 */
export function topSlotClaim(
  queryClient: QueryClient,
  scope: string | undefined,
  type: string,
  id: string | undefined,
  rel: string,
): SlotClaim | undefined {
  let top: SlotClaim | undefined
  for (const claim of slotClaims.get(queryClient) ?? []) {
    if (
      claim.scope === scope &&
      claim.type === type &&
      claim.rel === rel &&
      (claim.id === undefined || id === undefined || claim.id === id) &&
      (top === undefined || claim.seq > top.seq)
    ) {
      top = claim
    }
  }
  return top
}

/**
 * Record `value` as the newest server value of its slot on `claim`, unless one as new is recorded.
 * @internal
 */
export function recordOnClaim(claim: SlotClaim, value: SlotServerValue): void {
  const target = targetOf(value.node)
  const held = claim.server.get(target)
  if (held === undefined || held.slot.stamp <= value.slot.stamp) {
    claim.server.set(target, value)
  }
}

// ── Propagation ────────────────────────────────────────────────────────────────────────────

/** The newest linkage of one relation of one resource, and the copy that carried it. */
interface Incoming extends ServerSlot {
  readonly rel: string
  readonly cardinality: 'one' | 'many'
  /** Whether the read being normalised carried it (it wins a tie), rather than a cached copy. */
  readonly incoming: boolean
  /** The node carrying the linkage, whose slot holds the copies it came with. */
  readonly copy: Record<string, unknown>
}

/** The newest linkage per relation, by `type:id` then relation. */
type Linkages = Map<string, Map<string, Incoming>>

function consider(
  linkages: Linkages,
  key: string,
  rel: string,
  candidate: Incoming,
  tieWins: boolean,
): void {
  const relations = linkages.get(key) ?? new Map<string, Incoming>()
  linkages.set(key, relations)
  const current = relations.get(rel)
  if (
    current === undefined ||
    candidate.stamp > current.stamp ||
    (tieWins && candidate.stamp === current.stamp)
  ) {
    relations.set(rel, candidate)
  }
}

type Readable = readonly (readonly [string, 'one' | 'many'])[]

const readable = new WeakMap<ApiDescriptor, Map<string, Readable>>()

/** The readable relations of `type` with their cardinality, memoised per descriptor. */
function relationsOf(descriptor: ApiDescriptor, type: string): Readable {
  let types = readable.get(descriptor)
  if (types === undefined) {
    types = new Map()
    readable.set(descriptor, types)
  }
  let list = types.get(type)
  if (list === undefined) {
    list = Object.entries(descriptor[type]?.relations ?? {}).flatMap(([name, relation]) =>
      relation.writeOnly === true ? [] : [[name, relation.cardinality] as const],
    )
    types.set(type, list)
  }
  return list
}

/** Queries R3 invalidated whose next success is the refetch it caused: those invalidate nothing. */
const induced = new WeakMap<Query, true>()

/**
 * Propagate the relationships `result` carries to every other cached copy of their resources in
 * the scope (`view`, its index), as the module comment describes. `landed` is the query the read
 * landed in, when known; a query whose data is `result` counts as that query too. Returns, per
 * query, the parts (by materialised value) whose slots changed in place, for the caller to
 * republish, and invalidates the queries whose slot would change but can't be filled.
 * @internal
 */
export function propagateRelationships(
  queryClient: QueryClient,
  result: unknown,
  descriptor: ApiDescriptor,
  scope: string | undefined,
  view: CacheView,
  landed: Query | undefined,
): Map<Query, Set<object>> {
  const { queries } = view
  const changed = new Map<Query, Set<object>>()
  const source = typeof result === 'object' && result !== null ? targetOf(result) : undefined
  const isSource = (query: Query): boolean =>
    query === landed ||
    (source !== undefined &&
      typeof query.state.data === 'object' &&
      query.state.data !== null &&
      targetOf(query.state.data) === source)
  const sourceQuery = landed ?? queries.find(isSource)
  const sourceDescription =
    sourceQuery === undefined ? undefined : describeCached(sourceQuery, descriptor)

  // 1. The linkage the read carries, the newest per relation.
  const linkages: Linkages = new Map()
  const identities = new Map<string, { type: string; id: string }>()
  for (const part of partsOf(result)) {
    if (typeof part !== 'object' || part === null) {
      continue
    }
    walkShaped(part, undefined, descriptor, (node) => {
      const { type, id } = node
      if (typeof type !== 'string' || typeof id !== 'string') {
        return
      }
      for (const [rel, cardinality] of relationsOf(descriptor, type)) {
        const held = heldSlot(node, rel, cardinality)
        // Windowed linkage, or linkage the read's `relatedQuery` narrowed, isn't the whole list.
        if (held === undefined || !whole(held.linkage) || narrowed(sourceDescription, rel)) {
          continue
        }
        identities.set(identityKey(type, id), { type, id })
        // A later occurrence wins a tie: for one response, the copies are the same wire object.
        consider(
          linkages,
          identityKey(type, id),
          rel,
          { ...held, rel, cardinality, incoming: true, copy: node },
          true,
        )
      }
    })
  }
  if (linkages.size === 0) {
    return changed
  }

  // 2. Raised to the newest linkage any cached copy holds, so an older read spreads nothing stale.
  // The copies are the index's, in the order a walk of the cache visits them.
  const holding = new Set<Query>()
  for (const [key, relations] of linkages) {
    const { type, id } = identities.get(key)!
    for (const query of view.ordered(view.holding(type, id))) {
      holding.add(query)
      for (const visit of view.visits(query, type, id)) {
        if (!visit.first) {
          continue
        }
        const node = visit.node
        for (const [rel, current] of relations) {
          const held = heldSlot(node, rel, current.cardinality)
          if (held !== undefined && whole(held.linkage) && held.stamp > current.stamp) {
            relations.set(rel, { ...current, ...held, incoming: false, copy: node })
          }
        }
      }
    }
  }

  // 3. Each cached copy's slot takes the newest linkage, in place where it fits. Only a query
  // holding a copy can change. Its copies are the index's, in walk order: once a slot changes, the
  // index is brought up to date and the walk goes on from that copy, so the copies a slot gains
  // are relinked too and those it loses aren't.
  const invalid = new Set<Query>()
  const context: BuildContext = { queryClient, descriptor, scope }
  for (const query of view.ordered(holding)) {
    const data = query.state.data
    if (data === undefined || data === null) {
      continue
    }
    const description = describeCached(query, descriptor)
    const parts = partsOf(data)
    /** Relink one copy reached in `part`; returns whether a slot changed. */
    const relinkCopy = (
      node: Record<string, unknown>,
      at: ViewShape | undefined,
      part: unknown,
    ) => {
      const { type, id } = node
      const relations = linkages.get(identityKey(String(type), String(id)))
      if (relations === undefined || typeof type !== 'string' || typeof id !== 'string') {
        return false
      }
      let relinked = false
      for (const [rel, next] of relations) {
        const outcome = relink(context, query, description, node, at, rel, next)
        if (outcome === 'changed' && typeof part === 'object' && part !== null) {
          relinked = true
          const touched = changed.get(query) ?? new Set<object>()
          touched.add(targetOf(part))
          changed.set(query, touched)
        } else if (outcome === 'unfit' && !isSource(query)) {
          invalid.add(query)
        }
      }
      return relinked
    }
    // The copies already relinked, and the place in walk order the next one comes after.
    const done = new Set<object>()
    let after = -Infinity
    for (;;) {
      if (!view.current(query)) {
        view.refresh(query)
      }
      const copies: Visit[] = []
      for (const key of linkages.keys()) {
        const { type, id } = identities.get(key)!
        for (const visit of view.visits(query, type, id)) {
          if (visit.first && visit.seq > after && !done.has(visit.node)) {
            copies.push(visit)
          }
        }
      }
      // oxlint-disable-next-line no-array-sort -- this pass's own list
      copies.sort((a, b) => a.seq - b.seq)
      let relinked: Record<string, unknown> | undefined
      for (const visit of copies) {
        done.add(visit.node)
        if (relinkCopy(visit.node, visit.shape, parts[visit.part])) {
          relinked = visit.node
          break
        }
      }
      if (relinked === undefined) {
        break
      }
      // A slot changed: what the walk reaches after this copy is read from the index brought up
      // to date. What it reached before is unchanged, and already relinked.
      view.refresh(query)
      const at = view
        .visits(query, String(relinked['type']), String(relinked['id']))
        .find((visit) => visit.node === relinked && visit.first)
      if (at === undefined) {
        break
      }
      after = at.seq
    }
  }

  // A refetch R3 caused writes in place but invalidates nothing, so views can't ping-pong.
  const quiet = landed !== undefined && induced.has(landed)
  if (landed !== undefined) {
    induced.delete(landed)
  }
  if (!quiet) {
    for (const query of invalid) {
      invalidate(queryClient, query)
    }
  }
  return changed
}

/**
 * Invalidate `query` for R3: an active query refetches, an inactive one goes stale. Its next
 * success is the refetch this caused.
 * @internal
 */
export function invalidate(queryClient: QueryClient, query: Query): void {
  induced.set(query, true)
  void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true })
}

/** What building a slot's value needs. */
interface BuildContext {
  readonly queryClient: QueryClient
  readonly descriptor: ApiDescriptor
  readonly scope: string | undefined
}

/**
 * Bring relation slot `rel` of `node` (a copy in `query`, in a slot of shape `at`) up to `next`:
 * `'changed'` when its value was replaced, `'unfit'` when it would change but can't be filled, else
 * `'kept'`.
 */
function relink(
  context: BuildContext,
  query: Query,
  description: QueryDescription | undefined,
  node: Record<string, unknown>,
  at: ViewShape | undefined,
  rel: string,
  next: Incoming,
): 'changed' | 'unfit' | 'kept' {
  const slot = node[rel]
  if (linksOnly(node, rel, slot)) {
    return 'kept'
  }
  const held = heldSlot(node, rel, next.cardinality)
  if (
    held !== undefined &&
    (held.stamp > next.stamp || (held.stamp === next.stamp && !next.incoming))
  ) {
    return 'kept'
  }
  const type = node['type'] as string
  const id = node['id'] as string
  const shape = at === undefined ? undefined : slotShape(at, type, rel)
  const server: ServerSlot = { stamp: next.stamp, linkage: next.linkage }

  // A slot an open draft owns keeps its prediction; the draft records the server value (R2).
  const claim = topSlotClaim(context.queryClient, context.scope, type, id, rel)
  if (claim !== undefined) {
    const built = holds(slot, next.linkage) ? { value: slot } : build(context, shape, slot, next)
    recordOnClaim(claim, {
      node,
      query,
      slot: server,
      fits: built !== undefined,
      value: built?.value,
    })
    return 'kept'
  }

  // A view filtering the relation's members holds a subset no linkage tells; a sorted one an order.
  if (next.linkage.kind === 'many') {
    const narrowing = narrowed(description, rel)
    if (narrowing !== undefined) {
      return narrowing === 'sort' && !sameSet(slot, next.linkage) ? 'unfit' : 'kept'
    }
  }

  if (holds(slot, next.linkage)) {
    recordSlot(node, rel, server)
    return 'kept'
  }
  const built = build(context, shape, slot, next)
  if (built === undefined) {
    return 'unfit'
  }
  node[rel] = built.value
  touchNode(context.queryClient, node)
  recordSlot(node, rel, server)
  return 'changed'
}

/** The identifier-level meta a cached member carries for its edge. */
function edgeMeta(member: unknown): Record<string, unknown> | undefined {
  const edge = (member as { $edge?: { meta?: unknown } } | null | undefined)?.$edge
  return isRecord(edge?.meta) ? edge.meta : undefined
}

const sameMeta = (a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Whether a slot's value already holds `linkage`: the same members, in order, with the same meta. */
function holds(slot: unknown, linkage: SlotLinkage): boolean {
  if (linkage.kind === 'one') {
    return linkage.target === null ? slot === null : addresses(slot, linkage.target)
  }
  return (
    Array.isArray(slot) &&
    slot.length === linkage.members.length &&
    linkage.members.every(
      (member, index) =>
        addresses(slot[index], member) && sameMeta(edgeMeta(slot[index]), member.meta),
    )
  )
}

/** Whether a to-many slot holds exactly `linkage`'s members, in any order. */
function sameSet(slot: unknown, linkage: SlotLinkage & { kind: 'many' }): boolean {
  return (
    Array.isArray(slot) &&
    slot.length === linkage.members.length &&
    linkage.members.every((member) => slot.some((held) => addresses(held, member)))
  )
}

/**
 * The value a slot of `shape` takes for `next`'s linkage, or `undefined` when a member can't fill
 * it: `null`, an identifier view, or a per-edge view of the fitting copy (the read's own, else the
 * one the slot holds, else the richest cached), and for a to-many an array carrying the slot's
 * envelope (the read's, when the slot's says more pages follow) of those members.
 */
function build(
  context: BuildContext,
  shape: ViewShape | undefined,
  slot: unknown,
  next: Incoming,
): { value: unknown } | undefined {
  if (shape === undefined) {
    return undefined
  }
  const carried = next.copy[next.rel]
  if (next.linkage.kind === 'one') {
    const target = next.linkage.target
    if (target === null) {
      return { value: null }
    }
    const value = memberView(context, shape, target, [carried])
    return value === undefined ? undefined : { value }
  }
  if (!Array.isArray(slot)) {
    return undefined
  }
  const members: unknown[] = []
  for (const member of next.linkage.members) {
    const kept = slot.find((held) => addresses(held, member))
    if (
      kept !== undefined &&
      sameMeta(edgeMeta(kept), member.meta) &&
      fits(kept, shape, context.descriptor)
    ) {
      members.push(kept)
      continue
    }
    const fromRead = Array.isArray(carried)
      ? carried.find((held: unknown) => addresses(held, member))
      : undefined
    const value = memberView(context, shape, member, [fromRead, kept])
    if (value === undefined) {
      return undefined
    }
    members.push(value)
  }
  const envelope = isComplete(slot) || !Array.isArray(carried) ? slot : (carried as unknown[])
  return { value: withMembers(envelope, members) }
}

/**
 * `member` as it enters a slot of `shape`: an identifier view carrying its meta, or a per-edge view
 * over the first fitting copy among `candidates` and the cache, keeping only what the shape
 * selects; `undefined` when no copy fits.
 */
function memberView(
  context: BuildContext,
  shape: ViewShape,
  member: LinkageMember,
  candidates: readonly unknown[],
): object | undefined {
  const edge = {
    type: member.type,
    id: member.id,
    ...(member.meta === undefined ? {} : { meta: member.meta }),
  }
  return memberViewFor(context.queryClient, edge, shape, context.descriptor, context.scope, () =>
    candidates.filter((candidate) => candidate !== undefined),
  )
}
