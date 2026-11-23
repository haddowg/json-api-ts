/**
 * The cached resources of a QueryClient, indexed by `type:id` (design B1, "the normalised index").
 *
 * Normalisation, member resolution, an optimistic draft's discovery of a resource's cached copies
 * and the upkeep that finds the queries holding a resource all look for one `type:id` across every
 * cached query of a scope. Walking every query's graph for each of those lookups costs the size of
 * the whole cache; this index answers them with the copies themselves.
 *
 * **What it holds.** Per QueryClient and scope, for each cached query: every resource its data
 * reaches (canonical nodes, per-edge views, included members and every page of an infinite query),
 * found by `walkGraph` (./view-shape.ts), each with the shape of the slot it was
 * first reached in, the part (an infinite query's page) it sits in, and its place in walk order.
 * And per `type`, then `id`, the queries holding a copy. A lookup returns copies in the order a walk
 * of the cache would visit them: queries in the cache's order, copies in walk order.
 *
 * **How it stays current.** A query is (re)indexed lazily, at the first lookup after its data
 * changed:
 *
 * - Each lookup compares every cached query of the scope with what was indexed: a query not yet
 *   indexed (added), one whose data no longer reads through to the materialised values indexed (a
 *   refetch, `setQueryData`, a membership edit's new array or page, an infinite query's new page),
 *   or one indexed against another descriptor is indexed again. A republish under a new root that
 *   reads through to the same values keeps its index, so a patch costs no re-walk. The comparison is
 *   by reference, one per query, rather than through the cache's events, so it holds whatever order
 *   the cache's listeners run in. Of an infinite query, only the pages that changed (a page added,
 *   or one a membership edit replaced) are walked again, when no copy such a page gains or loses is
 *   reached by a later page that stayed.
 * - A removed query is dropped from the index on the cache's `removed` event (and by the next
 *   lookup), so a garbage-collected query releases its nodes.
 * - A change this package makes inside a graph in place, without new values at the top (a relation
 *   slot an optimistic draft or an R3 propagation replaces, a temporary id swapped for the
 *   server's), is reported through {@link touchNode} (or {@link renameNode} for an id, which
 *   indexes the query again whole). The next lookup walks again only the member
 *   of the query's list that reaches the node (a segment), when that walk can't change what the
 *   rest of the list reaches: no copy it gains is reached elsewhere in the query, and none it loses
 *   was. Otherwise, and for a query that isn't a list, the query is indexed again whole.
 *
 * **Memory.** The index keeps strong references to the nodes of the queries it indexes, and drops
 * them with the query. Each QueryClient's index lives in a `WeakMap` keyed by the client, so a
 * client and its cache are released together.
 *
 * @internal
 */
import type { ApiDescriptor } from '@haddowg/json-api-client'
import type { Query, QueryClient } from '@tanstack/query-core'
import { identityKey, splitIdentityKey } from './identity'
import { scopeOf } from './keys'
import { partsOf, targetOf } from './normalize'
import {
  describeQuery,
  type QueryDescription,
  relationNames,
  type Seen,
  viewShape,
  type ViewShape,
  type Visitor,
  walkGraph,
} from './view-shape'

/** One copy of a resource in a cached query. */
export interface Visit {
  /** The copy, as a walk of the query's data reaches it. */
  node: Record<string, unknown>
  /** Its `type` and `id` when it was indexed. */
  readonly type: string
  readonly id: string
  /** The shape of the slot it was first reached in, within its part. */
  readonly shape: ViewShape | undefined
  /** The part (an infinite query's page; `0` otherwise) a walk of that part reaches it in. */
  readonly part: number
  /** Its place in walk order, across the query's parts. */
  readonly seq: number
  /** Whether no earlier part reaches it: one walk across every part visits it here. */
  readonly first: boolean
  /** The list member whose walk reached it, when its part is a list. */
  readonly segment: Segment | undefined
  /** The copy whose relation slot `rel` the walk reached it through; none at a part's top. */
  readonly parent: Visit | undefined
  readonly rel: string | undefined
}

/** The walk of one member of a part that is a list: the copies it reaches, and their seq range. */
interface Segment {
  /** The member walked. */
  readonly root: unknown
  readonly part: number
  readonly shape: ViewShape | undefined
  /** The seq range its visits fall in: `[lo, hi)`. */
  readonly lo: number
  readonly hi: number
  visits: readonly Visit[]
}

/** What one cached query's data holds. */
interface QueryIndex {
  readonly query: Query
  readonly descriptor: ApiDescriptor
  /** The data indexed, and the materialised value behind each of its parts. */
  data: unknown
  parts: readonly unknown[]
  /** The visits that sit at a part's top (a single resource's data), refreshed on a republish. */
  readonly tops: readonly Visit[]
  /** Its copies by type, then id, in walk order. Each list is replaced, never edited. */
  readonly byType: Map<string, Map<string, readonly Visit[]>>
  /** Every object the walk reached more than once (its later arrivals stop at the first). */
  readonly shared: Set<object>
  /** Nodes something changed below in place since they were indexed, by materialised value. */
  readonly touched: Set<object>
  /** Indexed again whole at the next lookup. */
  stale: boolean
}

/** A scope's queries and which of them hold each `type:id`. */
interface ScopeIndex {
  readonly queries: Map<Query, QueryIndex>
  readonly holding: Map<string, Map<string, Set<Query>>>
}

/** A QueryClient's index. */
interface ClientIndex {
  readonly scopes: Map<string | undefined, ScopeIndex>
  /** Each query's scope, read once from its key. */
  readonly scopeOf: WeakMap<Query, string | undefined>
}

const clients = new WeakMap<QueryClient, ClientIndex>()

/** The scope of `query`'s key, memoised (a query's key never changes). */
function scopeOfQuery(index: ClientIndex, query: Query): string | undefined {
  if (index.scopeOf.has(query)) {
    return index.scopeOf.get(query)
  }
  const scope = scopeOf(query.queryKey)
  index.scopeOf.set(query, scope)
  return scope
}

function clientIndex(queryClient: QueryClient): ClientIndex {
  let index = clients.get(queryClient)
  if (index === undefined) {
    const created: ClientIndex = { scopes: new Map(), scopeOf: new WeakMap() }
    index = created
    clients.set(queryClient, created)
    queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'removed') {
        const scope = created.scopes.get(scopeOfQuery(created, event.query))
        const indexed = scope?.queries.get(event.query)
        if (scope !== undefined && indexed !== undefined) {
          scope.queries.delete(event.query)
          hold(scope, event.query, indexed.byType, undefined)
        }
      }
    })
  }
  return index
}

function scopeIndex(index: ClientIndex, scope: string | undefined): ScopeIndex {
  let found = index.scopes.get(scope)
  if (found === undefined) {
    found = { queries: new Map(), holding: new Map() }
    index.scopes.set(scope, found)
  }
  return found
}

// ── Descriptions ───────────────────────────────────────────────────────────────────────────

const descriptions = new WeakMap<
  Query,
  { descriptor: ApiDescriptor; description: QueryDescription | undefined }
>()

/**
 * {@link describeQuery} for a cached query, memoised per query and descriptor (a query's key never
 * changes). The description is a deep-frozen copy: it is shared by every later call, and an `into`
 * receives it, so nothing it is handed can change what the next call sees, nor reach back into the
 * query's key or the descriptor it was read from.
 * @internal
 */
export function describeCached(
  query: Query,
  descriptor: ApiDescriptor,
): QueryDescription | undefined {
  const memo = descriptions.get(query)
  if (memo !== undefined && memo.descriptor === descriptor) {
    return memo.description
  }
  const decoded = describeQuery(query, descriptor)
  const description = decoded === undefined ? undefined : frozenCopy(decoded)
  descriptions.set(query, { descriptor, description })
  return description
}

/**
 * A deep copy of `value` with every array and plain object in it frozen. Anything else (a class
 * instance a filter value carries) is kept as it is.
 */
function frozenCopy<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(frozenCopy)) as T
  }
  if (typeof value === 'object' && value !== null) {
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {}
      for (const [k, member] of Object.entries(value)) {
        out[k] = frozenCopy(member)
      }
      return Object.freeze(out) as T
    }
  }
  return value
}

const shapes = new WeakMap<Query, { descriptor: ApiDescriptor; shape: ViewShape | undefined }>()

/**
 * The shape a cached query's data promises at its top level, when its key decodes and isn't a
 * skipped read, memoised per query and descriptor.
 * @internal
 */
export function shapeOfCached(query: Query, descriptor: ApiDescriptor): ViewShape | undefined {
  const memo = shapes.get(query)
  if (memo !== undefined && memo.descriptor === descriptor) {
    return memo.shape
  }
  const description = describeCached(query, descriptor)
  const shape =
    description === undefined || description.skipped
      ? undefined
      : viewShape(description, descriptor)
  shapes.set(query, { descriptor, shape })
  return shape
}

// ── Indexing ───────────────────────────────────────────────────────────────────────────────

/** The parts of a query's data, none when it holds nothing. */
const partsOfData = (data: unknown): readonly unknown[] =>
  data === undefined || data === null ? [] : partsOf(data)

/** The materialised value behind each part of `data`. */
const partTargets = (data: unknown): unknown[] =>
  partsOfData(data).map((part) =>
    typeof part === 'object' && part !== null ? targetOf(part) : part,
  )

/** Whether `data` reads through to the same parts `indexed` was built from. */
function sameParts(indexed: QueryIndex, data: unknown): boolean {
  if (data === indexed.data) {
    return true
  }
  const parts = partTargets(data)
  return (
    parts.length === indexed.parts.length && parts.every((part, at) => part === indexed.parts[at])
  )
}

/**
 * The span of walk order each part's visits take: part `p`'s visits are numbered from `p * PART`,
 * so one part can be indexed again without renumbering the others.
 */
const PART = 2 ** 32

/** Add `visit` to `byType`'s list for its `type:id`, at the end. */
function append(byType: QueryIndex['byType'], visit: Visit): void {
  let ids = byType.get(visit.type)
  if (ids === undefined) {
    ids = new Map()
    byType.set(visit.type, ids)
  }
  const list = ids.get(visit.id) as Visit[] | undefined
  if (list === undefined) {
    ids.set(visit.id, [visit])
  } else {
    list.push(visit)
  }
}

/**
 * Walk part `at` of a query's data, recording every copy it reaches, in walk order. `earlier` tells
 * whether an earlier part reaches a node; every object reached more than once is added to `shared`.
 */
function walkPart(
  part: unknown,
  at: number,
  shape: ViewShape | undefined,
  relations: (type: string) => readonly string[],
  earlier: (node: object) => boolean,
  shared: Set<object>,
): Visit[] {
  const visits: Visit[] = []
  const seen = new Set<object>()
  let seq = at * PART
  const again = (value: object) => {
    shared.add(value)
  }
  const record =
    (segment: Segment | undefined): Visitor<Visit> =>
    (node, type, id, slot, parent, rel) => {
      const first = !earlier(node)
      if (!first) {
        shared.add(node)
      }
      const visit: Visit = {
        node,
        type,
        id,
        shape: slot,
        part: at,
        seq: seq++,
        first,
        segment,
        parent,
        rel,
      }
      if (segment !== undefined) {
        ;(segment.visits as Visit[]).push(visit)
      }
      visits.push(visit)
      return visit
    }
  if (!Array.isArray(part)) {
    walkGraph(part, shape, relations, seen, record(undefined), again)
    return visits
  }
  for (const member of part) {
    const segment: Segment = { root: member, part: at, shape, lo: seq, hi: seq, visits: [] }
    walkGraph(member, shape, relations, seen, record(segment), again)
    // The range ends where the next member's begins.
    ;(segment as { hi: number }).hi = seq
  }
  return visits
}

/** Walk `query`'s data part by part, recording every copy. */
function build(query: Query, descriptor: ApiDescriptor): QueryIndex {
  const data = query.state.data
  const shape = shapeOfCached(query, descriptor)
  const byType: QueryIndex['byType'] = new Map()
  const tops: Visit[] = []
  const shared = new Set<object>()
  const parts = partsOfData(data)
  const reached = new Set<object>()
  const relations = relationNames(descriptor)
  parts.forEach((part, at) => {
    const visits = walkPart(part, at, shape, relations, (node) => reached.has(node), shared)
    for (const visit of visits) {
      if (parts.length > 1) {
        reached.add(visit.node)
      }
      if (visit.node === part) {
        tops.push(visit)
      }
      append(byType, visit)
    }
  })
  return {
    query,
    descriptor,
    data,
    parts: partTargets(data),
    tops,
    byType,
    shared,
    touched: new Set(),
    stale: false,
  }
}

/** Every visit of the object `node` (by identity) in `indexed`. */
const visitsOfObject = (indexed: QueryIndex, node: object): Visit[] => {
  const { type, id } = node as { type?: unknown; id?: unknown }
  if (typeof type !== 'string' || typeof id !== 'string') {
    return []
  }
  return (indexed.byType.get(type)?.get(id) ?? []).filter((visit) => visit.node === node)
}

/**
 * Replace the visits `drop` selects with `added`, in each `type:id` list either touches, returning
 * the `type:id`s whose lists changed.
 */
function replaceVisits(
  indexed: QueryIndex,
  removed: readonly Visit[],
  drop: (visit: Visit) => boolean,
  added: readonly Visit[],
): Set<string> {
  const lists = new Map<string, { type: string; id: string; added: Visit[] }>()
  for (const visit of removed) {
    lists.set(identityKey(visit.type, visit.id), { type: visit.type, id: visit.id, added: [] })
  }
  for (const visit of added) {
    const key = identityKey(visit.type, visit.id)
    const entry = lists.get(key) ?? { type: visit.type, id: visit.id, added: [] }
    lists.set(key, entry)
    entry.added.push(visit)
  }
  for (const { type, id, added: more } of lists.values()) {
    const ids = indexed.byType.get(type) ?? new Map<string, readonly Visit[]>()
    const merged = [...(ids.get(id) ?? []).filter((visit) => !drop(visit)), ...more]
    // oxlint-disable-next-line no-array-sort -- a fresh array
    merged.sort((a, b) => a.seq - b.seq)
    if (merged.length === 0) {
      ids.delete(id)
      if (ids.size === 0) {
        indexed.byType.delete(type)
      }
    } else {
      ids.set(id, merged)
      indexed.byType.set(type, ids)
    }
  }
  return new Set(lists.keys())
}

/**
 * Index again only the parts of an infinite query's data that changed (a page added, or a page a
 * membership edit replaced), when that can't change what the others hold: no copy a changed page
 * gains or loses is reached by a later page that stays. Returns the `type:id`s whose copies
 * changed, or `undefined` when the query must be indexed again whole.
 */
function repart(indexed: QueryIndex, data: unknown): Set<string> | undefined {
  const parts = partsOfData(data)
  const targets = partTargets(data)
  const changed = new Set<number>()
  for (let at = 0; at < Math.max(parts.length, indexed.parts.length); at++) {
    if (at >= parts.length || at >= indexed.parts.length || targets[at] !== indexed.parts[at]) {
      changed.add(at)
    }
  }
  if (changed.size >= parts.length) {
    return undefined
  }
  const old: Visit[] = []
  for (const ids of indexed.byType.values()) {
    for (const list of ids.values()) {
      for (const visit of list) {
        if (changed.has(visit.part)) {
          old.push(visit)
        }
      }
    }
  }
  const shape = shapeOfCached(indexed.query, indexed.descriptor)
  const relations = relationNames(indexed.descriptor)
  // What each changed part reaches now, in part order, each seeing what the parts before it reach.
  const walked = new Map<number, Set<object>>()
  const added: Visit[] = []
  for (const at of [...changed].filter((part) => part < parts.length)) {
    const earlier = (node: object): boolean =>
      visitsOfObject(indexed, node).some((visit) => visit.part < at && !changed.has(visit.part)) ||
      [...walked].some(([part, nodes]) => part < at && nodes.has(node))
    const visits = walkPart(parts[at], at, shape, relations, earlier, indexed.shared)
    walked.set(at, new Set(visits.map((visit) => visit.node)))
    added.push(...visits)
  }
  // A copy a changed page gains or loses that a later page keeps reaching changes that page's.
  const before = new Map<number, Set<object>>()
  for (const visit of old) {
    const nodes = before.get(visit.part) ?? new Set<object>()
    before.set(visit.part, nodes)
    nodes.add(visit.node)
  }
  for (const at of changed) {
    const was = before.get(at) ?? new Set<object>()
    const now = walked.get(at) ?? new Set<object>()
    for (const node of [...was, ...now]) {
      if (was.has(node) === now.has(node)) {
        continue
      }
      if (
        visitsOfObject(indexed, node).some((visit) => visit.part > at && !changed.has(visit.part))
      ) {
        return undefined
      }
    }
  }
  indexed.data = data
  indexed.parts = targets
  return replaceVisits(indexed, old, (visit) => changed.has(visit.part), added)
}

/**
 * Walk again the segment that reaches `target` (a touched node's materialised value), replacing its
 * visits, when that can't change what the rest of the query reaches. Returns the `type:id`s whose
 * copies changed, or `undefined` when the query must be indexed again whole.
 */
function resegment(indexed: QueryIndex, target: object): Set<string> | undefined {
  const { type, id } = target as { type?: unknown; id?: unknown }
  if (typeof type !== 'string' || typeof id !== 'string') {
    return undefined
  }
  const at = (indexed.byType.get(type)?.get(id) ?? []).filter(
    (visit) => targetOf(visit.node) === target,
  )
  if (at.length === 0) {
    // Not reached here any more: whatever changed below it is unreachable too.
    return new Set()
  }
  const segment = at[0]!.segment
  if (segment === undefined || at.some((visit) => visit.segment !== segment)) {
    return undefined
  }
  const relations = relationNames(indexed.descriptor)
  // What the walk had reached before this segment: an earlier visit in the same part.
  const before = (value: object): boolean =>
    visitsOfObject(indexed, value).some(
      (visit) => visit.part === segment.part && visit.seq < segment.lo,
    )
  const local = new Set<object>()
  const seen: Seen = {
    has: (value) => local.has(value) || before(value),
    add: (value) => {
      local.add(value)
    },
  }
  interface Found {
    node: Record<string, unknown>
    type: string
    id: string
    shape: ViewShape | undefined
    from: Found | undefined
    rel: string | undefined
  }
  const found: Found[] = []
  const hits: object[] = []
  walkGraph<Found>(
    segment.root,
    segment.shape,
    relations,
    seen,
    (node, nodeType, nodeId, shape, from, rel) => {
      const entry: Found = { node, type: nodeType, id: nodeId, shape, from, rel }
      found.push(entry)
      return entry
    },
    (value) => {
      hits.push(value)
    },
  )
  const old = new Set<object>(segment.visits.map((visit) => visit.node))
  const now = new Set<object>(found.map((entry) => entry.node))
  for (const node of now) {
    // A copy this segment gains that the query reaches elsewhere changes what the rest reaches.
    if (!old.has(node) && visitsOfObject(indexed, node).length > 0) {
      return undefined
    }
  }
  for (const node of old) {
    // A copy it loses that the walk also reaches elsewhere would be reached there now.
    if (!now.has(node) && indexed.shared.has(node)) {
      return undefined
    }
  }
  const step = found.length === 0 ? 0 : (segment.hi - segment.lo) / found.length
  // Each visit's place must stay distinct from its neighbours' at the magnitude of the range.
  if (found.length > 0 && !(step > Math.max(1e-6, Math.abs(segment.lo) * 1e-12))) {
    return undefined
  }
  const replacement: Segment = { ...segment, visits: [] }
  const firsts = new Map(segment.visits.map((visit) => [visit.node, visit.first]))
  const made = new Map<Found, Visit>()
  const added = found.map((entry, place): Visit => {
    const visit: Visit = {
      node: entry.node,
      type: entry.type,
      id: entry.id,
      shape: entry.shape,
      part: segment.part,
      seq: segment.lo + place * step,
      // A copy it gains is reached nowhere else in the query; one it keeps keeps its standing.
      first: firsts.get(entry.node) ?? true,
      segment: replacement,
      parent: entry.from === undefined ? undefined : made.get(entry.from),
      rel: entry.rel,
    }
    made.set(entry, visit)
    ;(replacement.visits as Visit[]).push(visit)
    return visit
  })
  for (const hit of hits) {
    indexed.shared.add(hit)
  }
  return replaceVisits(indexed, segment.visits, (visit) => visit.segment === segment, added)
}

/** Record in `scope` which `type:id`s `query` holds, given what it held before and holds now. */
function hold(
  scope: ScopeIndex,
  query: Query,
  before: QueryIndex['byType'] | undefined,
  after: QueryIndex['byType'] | undefined,
): void {
  for (const [type, ids] of before ?? []) {
    const kept = after?.get(type)
    const held = scope.holding.get(type)
    for (const id of ids.keys()) {
      if (kept?.has(id) === true) {
        continue
      }
      const queries = held?.get(id)
      queries?.delete(query)
      if (queries?.size === 0) {
        held?.delete(id)
      }
    }
    if (held?.size === 0) {
      scope.holding.delete(type)
    }
  }
  for (const [type, ids] of after ?? []) {
    const had = before?.get(type)
    let held = scope.holding.get(type)
    for (const id of ids.keys()) {
      if (had?.has(id) === true) {
        continue
      }
      if (held === undefined) {
        held = new Map()
        scope.holding.set(type, held)
      }
      const queries = held.get(id)
      if (queries === undefined) {
        held.set(id, new Set([query]))
      } else {
        queries.add(query)
      }
    }
  }
}

/** Bring `scope`'s record of `query` up to date with the `type:id`s whose copies changed. */
function holdKeys(scope: ScopeIndex, indexed: QueryIndex, keys: ReadonlySet<string>): void {
  for (const key of keys) {
    const [type, id] = splitIdentityKey(key)
    const held = indexed.byType.get(type)?.has(id) === true
    let ids = scope.holding.get(type)
    if (held) {
      if (ids === undefined) {
        ids = new Map()
        scope.holding.set(type, ids)
      }
      const queries = ids.get(id) ?? new Set<Query>()
      ids.set(id, queries)
      queries.add(indexed.query)
    } else {
      const queries = ids?.get(id)
      queries?.delete(indexed.query)
      if (queries?.size === 0) {
        ids?.delete(id)
      }
      if (ids?.size === 0) {
        scope.holding.delete(type)
      }
    }
  }
}

/**
 * Report that this package changed what the graph below `node` holds, in place (a relation slot
 * replaced, or the node's own id swapped): every indexed query holding it is brought up to date at
 * the next lookup. Call it before changing the node's `type` or `id`.
 * @internal
 */
export function touchNode(queryClient: QueryClient, node: object): void {
  const { type, id } = node as { type?: unknown; id?: unknown }
  const index = clients.get(queryClient)
  if (index === undefined || typeof type !== 'string' || typeof id !== 'string') {
    return
  }
  const target = targetOf(node)
  for (const scope of index.scopes.values()) {
    for (const query of scope.holding.get(type)?.get(id) ?? []) {
      const indexed = scope.queries.get(query)
      if (
        indexed?.byType
          .get(type)
          ?.get(id)
          ?.some((visit) => targetOf(visit.node) === target)
      ) {
        indexed.touched.add(target)
      }
    }
  }
}

/**
 * Mark every indexed query holding `node` to be indexed again whole: its own `type` or `id` is
 * about to change. Call it before changing them.
 * @internal
 */
export function renameNode(queryClient: QueryClient, node: object): void {
  const { type, id } = node as { type?: unknown; id?: unknown }
  const index = clients.get(queryClient)
  if (index === undefined || typeof type !== 'string' || typeof id !== 'string') {
    return
  }
  const target = targetOf(node)
  for (const scope of index.scopes.values()) {
    for (const query of scope.holding.get(type)?.get(id) ?? []) {
      const indexed = scope.queries.get(query)
      if (
        indexed?.byType
          .get(type)
          ?.get(id)
          ?.some((visit) => targetOf(visit.node) === target)
      ) {
        indexed.stale = true
      }
    }
  }
}

// ── Lookups ────────────────────────────────────────────────────────────────────────────────

/** The index of one scope's cached queries, current as of when it was taken. */
export interface CacheView {
  /** The scope's cached queries, in the cache's order. */
  readonly queries: readonly Query[]
  /** The queries holding a copy of `type:id` (any id of `type` when `id` is `undefined`). */
  holding(type: string, id: string | undefined): ReadonlySet<Query>
  /** `queries` in the cache's order. */
  ordered(queries: Iterable<Query>): Query[]
  /** The copies of `type:id` (any id of `type` when `id` is `undefined`) `query` holds, in walk order. */
  visits(query: Query, type: string, id: string | undefined): readonly Visit[]
  /** Every copy `query` holds, in walk order. */
  copies(query: Query): readonly Visit[]
  /**
   * Whether the index still describes `query`'s data: nothing changed what its graph holds in place
   * since it was indexed.
   */
  current(query: Query): boolean
  /**
   * Bring `query`'s index up to date now, after something changed its graph in place during this
   * view's use.
   */
  refresh(query: Query): void
  /**
   * Every relation slot in `query` holding a member addressing `type:id`, as `[node, rel]`, in the
   * order a walk visits the nodes and, per node, its relations; `undefined` when a member is reached
   * more than once, so the index can't tell every slot holding it.
   */
  slotsHolding(
    query: Query,
    type: string,
    id: string,
  ): [Record<string, unknown>, string][] | undefined
  /** The parts (by index) whose walk reaches the object `node` (by identity) in `query`. */
  partsReaching(query: Query, node: object): number[]
  /** The parts (by index) of `query` holding one of `nodes` (materialised values). */
  partsHolding(query: Query, nodes: ReadonlySet<object>): Set<number>
}

const EMPTY: ReadonlySet<Query> = new Set()

/** Bring `query`'s index in `at` up to date with its data. */
function refresh(at: ScopeIndex, query: Query, descriptor: ApiDescriptor): void {
  const indexed = at.queries.get(query)
  if (
    indexed !== undefined &&
    !indexed.stale &&
    indexed.descriptor === descriptor &&
    !sameParts(indexed, query.state.data)
  ) {
    // Some pages changed: only they are walked, when the others hold what they held.
    const keys = repart(indexed, query.state.data)
    if (keys !== undefined) {
      holdKeys(at, indexed, keys)
    }
  }
  if (
    indexed !== undefined &&
    !indexed.stale &&
    indexed.descriptor === descriptor &&
    sameParts(indexed, query.state.data)
  ) {
    if (indexed.data !== query.state.data) {
      // Republished under a new root: the same values, reached through the new root.
      indexed.data = query.state.data
      const parts = partsOf(query.state.data)
      for (const top of indexed.tops) {
        top.node = parts[top.part] as Record<string, unknown>
      }
    }
    if (indexed.touched.size === 0) {
      return
    }
    const targets = [...indexed.touched]
    indexed.touched.clear()
    const changed = new Set<string>()
    let whole = false
    for (const target of targets) {
      const keys = resegment(indexed, target)
      if (keys === undefined) {
        whole = true
        break
      }
      for (const key of keys) {
        changed.add(key)
      }
    }
    holdKeys(at, indexed, changed)
    if (!whole) {
      return
    }
  }
  const rebuilt = build(query, descriptor)
  at.queries.set(query, rebuilt)
  hold(at, query, indexed?.byType, rebuilt.byType)
}

/**
 * The index of `scope`'s cached queries, brought up to date: every query added, refetched or edited
 * since the last lookup is indexed again, and every removed one dropped.
 * @internal
 */
export function cacheView(
  queryClient: QueryClient,
  scope: string | undefined,
  descriptor: ApiDescriptor,
): CacheView {
  const index = clientIndex(queryClient)
  const at = scopeIndex(index, scope)
  const queries: Query[] = []
  const rank = new Map<Query, number>()
  for (const query of queryClient.getQueryCache().getAll()) {
    if (scopeOfQuery(index, query) !== scope) {
      continue
    }
    rank.set(query, queries.length)
    queries.push(query)
    refresh(at, query, descriptor)
  }
  if (at.queries.size > queries.length) {
    for (const indexed of at.queries.values()) {
      if (!rank.has(indexed.query)) {
        at.queries.delete(indexed.query)
        hold(at, indexed.query, indexed.byType, undefined)
      }
    }
  }

  return {
    queries,
    holding(type, id) {
      const ids = at.holding.get(type)
      if (ids === undefined) {
        return EMPTY
      }
      if (id !== undefined) {
        return ids.get(id) ?? EMPTY
      }
      const out = new Set<Query>()
      for (const held of ids.values()) {
        for (const query of held) {
          out.add(query)
        }
      }
      return out
    },
    ordered(list) {
      // oxlint-disable-next-line no-array-sort -- spread into a fresh array
      return [...list].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
    },
    visits(query, type, id) {
      const ids = at.queries.get(query)?.byType.get(type)
      if (ids === undefined) {
        return []
      }
      if (id !== undefined) {
        return ids.get(id) ?? []
      }
      // oxlint-disable-next-line no-array-sort -- `flat` returns a fresh array
      return [...ids.values()].flat().sort((a, b) => a.seq - b.seq)
    },
    copies(query) {
      const byType = at.queries.get(query)?.byType
      const out = [...(byType?.values() ?? [])].flatMap((ids) => [...ids.values()].flat())
      // oxlint-disable-next-line no-array-sort -- a fresh array
      return out.sort((a, b) => a.seq - b.seq)
    },
    current(query) {
      const indexed = at.queries.get(query)
      return (
        indexed !== undefined &&
        !indexed.stale &&
        indexed.touched.size === 0 &&
        indexed.data === query.state.data
      )
    },
    refresh(query) {
      refresh(at, query, descriptor)
    },
    slotsHolding(query, type, id) {
      const indexed = at.queries.get(query)
      if (indexed === undefined) {
        return undefined
      }
      const members = indexed.byType.get(type)?.get(id) ?? []
      if (members.some((visit) => indexed.shared.has(visit.node))) {
        return undefined
      }
      const relations = relationNames(descriptor)
      const slots = members.flatMap((visit) =>
        visit.parent === undefined || visit.rel === undefined
          ? []
          : [{ parent: visit.parent, rel: visit.rel }],
      )
      // oxlint-disable-next-line no-array-sort -- a fresh array
      slots.sort(
        (a, b) =>
          a.parent.seq - b.parent.seq ||
          relations(a.parent.type).indexOf(a.rel) - relations(b.parent.type).indexOf(b.rel),
      )
      return slots.map(({ parent, rel }) => [parent.node, rel])
    },
    partsReaching(query, node) {
      const indexed = at.queries.get(query)
      return indexed === undefined ? [] : visitsOfObject(indexed, node).map((visit) => visit.part)
    },
    partsHolding(query, nodes) {
      const out = new Set<number>()
      const indexed = at.queries.get(query)
      if (indexed === undefined) {
        return out
      }
      for (const node of nodes) {
        const { type, id } = node as { type?: unknown; id?: unknown }
        if (typeof type !== 'string' || typeof id !== 'string') {
          continue
        }
        for (const visit of indexed.byType.get(type)?.get(id) ?? []) {
          if (targetOf(visit.node) === node) {
            out.add(visit.part)
          }
        }
      }
      return out
    },
  }
}
