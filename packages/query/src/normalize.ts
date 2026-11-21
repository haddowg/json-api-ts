/**
 * Strategy-2 normalization: bespoke, dep-free `type:id` write-through patching (ADR 0003).
 *
 * TanStack Query is not a normalized cache — it keeps each result denormalized under its
 * query key. JSON:API's guarantee that every resource carries `type`+`id` lets us normalize
 * with zero configuration: on every successful response we walk the materialised graph
 * (primary `data` + every hydrated/included nested resource), collect each resource's fresh
 * attributes by `type:id`, and PATCH every cached query that contains that `type:id` IN PLACE
 * — "edit once, updates everywhere".
 *
 * A patch replaces a node's ATTRIBUTES (the descriptor distinguishes attributes from
 * relations), merging an attribute its read narrowed to some keys (`$nestedFieldset`) into the cached
 * value instead, while PRESERVING the materialised object's edge-local `$pivot`/`$edge`, its
 * `$`-accessors, and its identity-by-`type:id`. The same Track in two playlists carries
 * different per-edge pivot data, so we never merge one edge's data onto another — only the
 * shared node's attributes change, and those live as own enumerable props that we overwrite
 * key-by-key, leaving the non-enumerable per-edge getters untouched.
 *
 * The nodes are patched in place, but each touched query's data is then republished under a new
 * root reference that reads through to the same graph, so an observer comparing `data` by
 * reference, as React Query's tracked mode does, sees the change and re-renders. An infinite
 * query's `InfiniteData` is walked page by page, and republished as a new `{ pages, pageParams }`
 * whose touched pages are republished roots and whose untouched pages keep their identity.
 *
 * This only covers UPDATES to existing resources (a node patch). Creates/deletes change
 * collection membership, which is not a node patch — those invalidate the relevant list/
 * relationship queries instead (see ./mutate.ts).
 */
import { isMaterialised, type ApiDescriptor, type NestedFieldset } from '@haddowg/json-api-client'
import type { Query, QueryClient } from '@tanstack/query-core'
import { stampOf, stampUnknown, UNKNOWN_STAMP } from './freshness'
import { keyHasPrefix, parentRelationReadKeys, type QueryKey, scopeOf } from './keys'

/** A `type:id` cache key for a resource. */
type ResourceKey = string

const resourceKey = (type: string, id: string): ResourceKey => `${type}:${id}`

/** The materialised value each republished root reads through to. */
const roots = new WeakMap<object, object>()

/** The materialised value behind `value`, seeing through a republished root. */
const targetOf = (value: object): object => roots.get(value) ?? value

/** TanStack's cached data for an infinite query: its pages and the params that read them. */
interface InfiniteValue {
  pages: unknown[]
  pageParams: unknown[]
}

/**
 * Whether `value` is an infinite query's `InfiniteData` (`{ pages, pageParams }`, both arrays)
 * rather than a materialised read result, which a resource or an augmented array always is.
 * @internal
 */
export function isInfiniteValue(value: unknown): value is InfiniteValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { pages?: unknown }).pages) &&
    Array.isArray((value as { pageParams?: unknown }).pageParams) &&
    identity(value as MaterialisedResource) === undefined
  )
}

/**
 * The read results a query's data holds: an infinite query's pages, or the data itself. Each is
 * walked, patched and republished on its own.
 */
function partsOf(data: unknown): readonly unknown[] {
  return isInfiniteValue(data) ? data.pages : [data]
}

/** A new root reference for `value` that reads through to the same materialised value. */
function reroot(value: object): object {
  const target = targetOf(value)
  const root = new Proxy(target, {})
  roots.set(root, target)
  return root
}

/**
 * Publish a query's patched data again under a new root reference. The root is a transparent
 * proxy of the materialised value, so its accessors, its array-ness and the graph below it are the
 * same objects, and a later patch or rollback of those objects shows through it. An infinite
 * query's data is rebuilt as a new `{ ...data, pages }` in which each page among `touched` is
 * republished that way and every other page keeps its identity. The state is set directly rather
 * than through `setQueryData`, whose structural sharing would hand the old root back because
 * nothing differs by value, and which would clear the query's `isInvalidated` and re-run
 * normalisation as a fresh success.
 */
function republish(query: Query, touched: readonly unknown[]): void {
  const data = query.state.data
  if (typeof data !== 'object' || data === null) {
    return
  }
  if (!isInfiniteValue(data)) {
    query.setState({ data: reroot(data) })
    return
  }
  const changed = new Set(
    touched.flatMap((part) => (typeof part === 'object' && part !== null ? [targetOf(part)] : [])),
  )
  const pages = data.pages.map((page) =>
    typeof page === 'object' && page !== null && changed.has(targetOf(page)) ? reroot(page) : page,
  )
  query.setState({ data: { ...data, pages } })
}

/**
 * Whether cached query data is a materialised client result, seeing through a republished root.
 * Infinite-query data (`{ pages, pageParams }`) is materialised when every page is.
 * @internal
 */
export function isMaterialisedData(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) {
    return false
  }
  if (isMaterialised(roots.get(data) ?? data)) {
    return true
  }
  const pages = (data as { pages?: unknown }).pages
  return (
    Array.isArray(pages) &&
    Array.isArray((data as { pageParams?: unknown }).pageParams) &&
    pages.length > 0 &&
    pages.every((page) =>
      isMaterialised(typeof page === 'object' && page !== null ? (roots.get(page) ?? page) : page),
    )
  )
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The raw JSON:API resource object a materialised resource exposes via its non-enumerable
 * `$raw` accessor — the authoritative split of attributes (which a patch replaces) from
 * relationships (which a patch leaves alone).
 */
interface RawResource {
  type?: unknown
  id?: unknown
  attributes?: Record<string, unknown>
}

/**
 * A materialised resource object: own enumerable `type`/`id`/attributes/relations plus a
 * non-enumerable `$raw` accessor. We treat both the primary data and every nested hydrated
 * member as one of these (a bare identifier view — `{type,id}` with no `$raw.attributes` —
 * carries no attributes to patch, so it is harmlessly skipped).
 */
interface MaterialisedResource {
  type: unknown
  id: unknown
  readonly $raw?: RawResource
  readonly $nestedFieldset?: NestedFieldset
}

/**
 * One attribute's value as the server sent it: the value, the stamp of the request that read it
 * (see ./freshness.ts), and the paths its read narrowed it to (`undefined` for the whole value).
 */
interface ServerValue {
  value: unknown
  stamp: number
  paths: readonly string[] | undefined
}

/** A candidate for an attribute's newest server value: whether the response being normalised carried it. */
interface Candidate extends ServerValue {
  incoming: boolean
}

/** The newest server value of each attribute a response carries, by `type:id` then attribute. */
type Fresh = Map<ResourceKey, Map<string, Candidate>>

/**
 * What a cached node holds from the server: the stamp of the response it was materialised from,
 * and each attribute a normalisation has written onto it since, with that write's stamp. Kept per
 * node (each per-edge view and each canonical node), keyed by the materialised object behind it.
 * An optimistic patch writes no record, so a prediction is never mistaken for a server value.
 */
interface NodeRecord {
  born: number
  written: Map<string, ServerValue>
}

const records = new WeakMap<object, NodeRecord>()

/** The record of `node`, created (as of unknown age) when it has none. */
function recordOf(node: object): NodeRecord {
  const target = targetOf(node)
  let record = records.get(target)
  if (record === undefined) {
    record = { born: UNKNOWN_STAMP, written: new Map() }
    records.set(target, record)
  }
  return record
}

/** Record that `node` was materialised from a response stamped `stamp`, unless it already was. */
function recordBirth(node: object, stamp: number): void {
  const target = targetOf(node)
  if (!records.has(target)) {
    records.set(target, { born: stamp, written: new Map() })
  }
}

/** The paths `node`'s own read narrowed attribute `k` to, when it narrowed it. */
const narrowedPaths = (node: MaterialisedResource, k: string): readonly string[] | undefined =>
  node.$nestedFieldset?.[k]

/**
 * The server value of each attribute `node` holds: what a normalisation last wrote, else what it
 * was materialised with (its `$raw.attributes`, which no patch changes), stamped with its birth.
 */
function serverValues(node: MaterialisedResource): Map<string, ServerValue> {
  const record = records.get(targetOf(node))
  const values = new Map(record?.written)
  const raw = attributesOf(node)
  if (raw !== undefined) {
    const born = record?.born ?? UNKNOWN_STAMP
    for (const [k, value] of Object.entries(raw)) {
      if (!values.has(k)) {
        values.set(k, { value, stamp: born, paths: narrowedPaths(node, k) })
      }
    }
  }
  return values
}

/** The stamp of the server value `node` holds for attribute `k`, or `undefined` when it holds none. */
function heldStamp(node: MaterialisedResource, k: string): number | undefined {
  const record = records.get(targetOf(node))
  const written = record?.written.get(k)
  if (written !== undefined) {
    return written.stamp
  }
  const raw = attributesOf(node)
  return raw !== undefined && Object.hasOwn(raw, k) ? (record?.born ?? UNKNOWN_STAMP) : undefined
}

/** A materialised resource's `type`+`id`, when it is a real resource (string type + id). */
function identity(node: MaterialisedResource): { type: string; id: string } | undefined {
  const { type, id } = node
  if (typeof type === 'string' && typeof id === 'string') {
    return { type, id }
  }
  return undefined
}

/**
 * The attributes a node was materialised with, read from its `$raw.attributes` (the wire split of
 * attributes from relations). Returns `undefined` when the node carries no `$raw` or no
 * attributes block (a bare identifier view, or an attribute-less resource). Never falls back to
 * enumerating own props, which would conflate relation slots with attributes.
 */
function attributesOf(node: MaterialisedResource): Record<string, unknown> | undefined {
  const attrs = node.$raw?.attributes
  return isObject(attrs) ? attrs : undefined
}

/**
 * Walk a materialised value (a single resource, an augmented array, a to-one/to-many relation
 * value, an infinite query's `InfiniteData`, whose every page it walks, or `null`/`undefined`)
 * and visit every reachable resource exactly once. Recurses into
 * each resource's own enumerable relation slots so a deeply-included graph is fully indexed.
 * `seen` guards relation cycles (a node memoised by reference) and keeps the walk linear.
 * @internal
 */
export function walkResources(
  value: unknown,
  descriptor: ApiDescriptor,
  visit: (node: MaterialisedResource) => void,
  seen: Set<object> = new Set(),
): void {
  if (value === null || value === undefined) {
    return
  }
  if (Array.isArray(value)) {
    for (const member of value) {
      walkResources(member, descriptor, visit, seen)
    }
    return
  }
  if (!isObject(value)) {
    return
  }
  if (seen.has(value)) {
    return
  }
  seen.add(value)

  const node = value as unknown as MaterialisedResource
  const ident = identity(node)
  if (ident === undefined) {
    // An infinite query's data: every page is a read result of its own.
    if (isInfiniteValue(value)) {
      for (const page of value.pages) {
        walkResources(page, descriptor, visit, seen)
      }
    }
    return
  }
  visit(node)

  // Recurse into declared relation slots only — every other own enumerable prop is an
  // attribute (a scalar/array/plain object), never a materialised resource to index.
  const relations = descriptor[ident.type]?.relations
  if (relations === undefined) {
    return
  }
  for (const name of Object.keys(relations)) {
    const slot = (value as Record<string, unknown>)[name]
    if (slot !== undefined) {
      walkResources(slot, descriptor, visit, seen)
    }
  }
}

/**
 * Patch one materialised node IN PLACE from `attributes`: overwrite each attribute key on the
 * target's own enumerable props (relations and `type`/`id` are left untouched), and shallow-set
 * any new keys. The non-enumerable `$`-accessors and the per-edge `$pivot`/`$edge` getters are
 * defined separately (closing over the original wire member), so they survive unchanged — a
 * per-edge view keeps its own pivot while its shared attributes update.
 *
 * `$raw` is intentionally NOT mutated: it is the immutable original wire object (the escape
 * hatch). Only the flattened, own-enumerable attribute props — the values consumers read —
 * are patched. Returns whether any value actually changed, so an idempotent re-application
 * (e.g. installNormalization re-running after a factory's own `onSuccess`) reports no change and
 * is not written back / re-notified.
 */
function patchNode(
  target: Record<string, unknown>,
  attributes: Record<string, unknown>,
  narrowed?: NestedFieldset,
): boolean {
  let changed = false
  for (const [k, v] of Object.entries(attributes)) {
    const paths = narrowed?.[k]
    if (paths !== undefined) {
      changed = mergeKeys(target, k, v, paths) || changed
      continue
    }
    if (!(k in target) || target[k] !== v) {
      target[k] = v
      changed = true
    }
  }
  return changed
}

/**
 * Merge an attribute a read narrowed to some of its keys into the cached value: the keys it carries
 * replace the cached ones and every other cached key stays. A key the read narrowed in turn, by a
 * path such as `geo.lat`, merges into the cached object the same way, and a list it narrowed item
 * by item, by a path such as `*.sku`, merges each item into the cached item at the same index. A
 * cached value that isn't an object, a cached list of another length, or a node that doesn't hold
 * the attribute, is left alone, since part of a value can't stand for all of it. A `null` fresh
 * value is the whole value and replaces it.
 */
function mergeKeys(
  target: Record<string, unknown>,
  k: string,
  v: unknown,
  paths: readonly string[],
): boolean {
  if (v === null) {
    if (target[k] === null) {
      return false
    }
    target[k] = null
    return true
  }
  const cached = target[k]
  const merged = mergedSelection(cached, v, paths)
  if (merged === cached) {
    return false
  }
  target[k] = merged
  return true
}

/** The paths below `key` among `paths`: `lat` for `geo.lat` under `geo`. */
const pathsBelow = (paths: readonly string[], key: string): string[] =>
  paths.flatMap((path) => (path.startsWith(`${key}.`) ? [path.slice(key.length + 1)] : []))

/**
 * `cached` with what `fresh` carries of the `paths` merged in, or `cached` itself when nothing
 * changes or the two can't be merged. A list the paths select whole, as `*`, replaces the cached
 * one. A list they narrow item by item merges each fresh item into the cached item at its index,
 * and only when both lists have the same length: a list of another length has gained or lost
 * items since it was cached, so no index pairs one item with its fresh part.
 */
function mergedSelection(cached: unknown, fresh: unknown, paths: readonly string[]): unknown {
  if (Array.isArray(fresh)) {
    if (paths.includes('*')) {
      return fresh
    }
    if (!Array.isArray(cached) || cached.length !== fresh.length) {
      return cached
    }
    const inner = pathsBelow(paths, '*')
    let out: unknown[] = cached
    fresh.forEach((item, index) => {
      const next = item === null ? null : mergedSelection(cached[index], item, inner)
      if (next === cached[index]) {
        return
      }
      if (out === cached) {
        out = [...cached]
      }
      out[index] = next
    })
    return out
  }
  if (!isObject(cached) || !isObject(fresh)) {
    return cached
  }
  return mergedValue(cached, fresh, paths)
}

/**
 * `cached` with the keys of `fresh` the `paths` select merged in, or `cached` itself when nothing
 * changes. A key a path selects whole replaces the cached one, and a key it narrows merges into a
 * cached object or list, keeping what the path didn't select. A key `fresh` carries that no path
 * selects names the variant of a union value, which renders whatever the selection: when the cached
 * value doesn't hold the same variant, part of one variant can't stand for another, so `cached`
 * stays.
 */
function mergedValue(
  cached: Record<string, unknown>,
  fresh: Record<string, unknown>,
  paths: readonly string[],
): Record<string, unknown> {
  const heads = new Set(paths.map((path) => path.split('.')[0]))
  for (const [key, value] of Object.entries(fresh)) {
    if (!heads.has(key) && cached[key] !== value) {
      return cached
    }
  }
  let out = cached
  for (const [key, value] of Object.entries(fresh)) {
    const inner = pathsBelow(paths, key)
    let next = value
    if (inner.length > 0 && !paths.includes(key) && value !== null) {
      next = mergedSelection(cached[key], value, inner)
      if (next === cached[key]) {
        continue
      }
    } else if (key in cached && cached[key] === next) {
      continue
    }
    if (out === cached) {
      out = { ...cached }
    }
    out[key] = next
  }
  return out
}

/** Make `candidate` the attribute's newest value when it is newer, or as new and `tieWins`. */
function consider(
  fresh: Fresh,
  key: ResourceKey,
  k: string,
  candidate: Candidate,
  tieWins: boolean,
): void {
  const attributes = fresh.get(key) ?? new Map<string, Candidate>()
  fresh.set(key, attributes)
  const current = attributes.get(k)
  if (
    current === undefined ||
    candidate.stamp > current.stamp ||
    (tieWins && candidate.stamp === current.stamp)
  ) {
    attributes.set(k, candidate)
  }
}

/**
 * Index the server value of every attribute of every resource in `result` by `type:id`, each with
 * the stamp of the response that read it: the result's own (an infinite query's pages each have
 * theirs), or, for an attribute a newer response already wrote onto one of its nodes, that
 * response's. Each node of the result is recorded as born at its result's stamp.
 */
function collectIncoming(result: unknown, descriptor: ApiDescriptor): Fresh {
  const fresh: Fresh = new Map()
  for (const part of partsOf(result)) {
    if (typeof part !== 'object' || part === null) {
      continue
    }
    const stamp = stampOf(targetOf(part))
    walkResources(part, descriptor, (node) => {
      const ident = identity(node)
      if (ident === undefined) {
        return
      }
      recordBirth(node, stamp)
      const key = resourceKey(ident.type, ident.id)
      for (const [k, value] of serverValues(node)) {
        // A later occurrence wins a tie: for one response, the copies are the same wire object.
        consider(fresh, key, k, { ...value, incoming: true }, true)
      }
    })
  }
  return fresh
}

/**
 * Raise each attribute in `fresh` to the newest server value any cached copy of its resource holds,
 * so a response arriving after a newer one takes the newer values rather than spreading its own.
 */
function raiseToNewest(queries: readonly Query[], fresh: Fresh, descriptor: ApiDescriptor): void {
  for (const query of queries) {
    walkResources(query.state.data, descriptor, (node) => {
      const ident = identity(node)
      if (ident === undefined) {
        return
      }
      const key = resourceKey(ident.type, ident.id)
      const attributes = fresh.get(key)
      if (attributes === undefined) {
        return
      }
      for (const [k, value] of serverValues(node)) {
        if (attributes.has(k)) {
          consider(fresh, key, k, { ...value, incoming: false }, false)
        }
      }
    })
  }
}

/**
 * Write one attribute's newest server value onto a node and record it, merging a value its read
 * narrowed into the cached one. Returns whether the node's value changed.
 */
function writeServerValue(node: MaterialisedResource, k: string, fresh: ServerValue): boolean {
  const target = node as unknown as Record<string, unknown>
  let changed: boolean
  if (fresh.paths !== undefined) {
    changed = mergeKeys(target, k, fresh.value, fresh.paths)
  } else {
    changed = !(k in target) || target[k] !== fresh.value
    if (changed) {
      target[k] = fresh.value
    }
  }
  if (k in target) {
    recordOf(node).written.set(k, { value: target[k], stamp: fresh.stamp, paths: fresh.paths })
  }
  return changed
}

/**
 * Patch every materialised node in `cached` whose `type:id` appears in `fresh`, in place, returning
 * whether any VALUE actually changed. Each attribute is written only onto a node holding an older
 * server value of it, or none, or one as old when the response being normalised carried it: a
 * node whose value came from a request started later keeps it. We mutate the cached objects
 * directly (preserving their identity/accessors) rather than rebuilding them, so writing the same
 * reference back triggers TanStack's subscribers without a structural-sharing diff fighting the
 * per-edge views. A node already holding the values is a no-op (reports unchanged), so a redundant
 * re-application doesn't write back or re-notify.
 */
function patchCached(cached: unknown, fresh: Fresh, descriptor: ApiDescriptor): boolean {
  let changed = false
  walkResources(cached, descriptor, (node) => {
    const ident = identity(node)
    if (ident === undefined) {
      return
    }
    const attributes = fresh.get(resourceKey(ident.type, ident.id))
    if (attributes === undefined) {
      return
    }
    for (const [k, value] of attributes) {
      const held = heldStamp(node, k)
      if (held !== undefined && (held > value.stamp || (held === value.stamp && !value.incoming))) {
        continue
      }
      if (writeServerValue(node, k, value)) {
        changed = true
      }
    }
  })
  return changed
}

/**
 * Write-through patch (the heart of Strategy 2). Given a freshly-resolved materialised
 * `result`, index its resources by `type:id` and patch every cached query that holds any of
 * those `type:id`s in place, so a single response updates the same resource everywhere it
 * is cached ("edit once, updates everywhere").
 *
 * Newer data wins, whatever order responses arrive in. A result is stamped with its request's
 * start (see ./freshness.ts), and each cached node records the stamp of each attribute value it
 * holds. An attribute is patched only where the cached value is no newer than the result's; where
 * a cached copy holds a newer value, that value is written over the result's own nodes instead, so
 * every copy ends with the newest value. The unit is the attribute: a sparse read carrying only
 * some attributes still updates those a newer read didn't carry, and an attribute a read narrowed
 * to some of its keys is stamped as a whole.
 *
 * Edge-local `$pivot`/`$edge` and a node's identity are preserved (only own-enumerable
 * attribute props are overwritten). Pass `result` from an option factory's `onSuccess` (or use
 * {@link installNormalization} to subscribe to every query/mutation success automatically). A
 * result no factory stamped is stamped when it is first normalised, so it keeps arrival order.
 *
 * `result` is the materialised value the client produced for this response (a resource, a
 * `Collection`, a related collection, or linkage). The same reference may also be the cached
 * entry for the query that produced it — we mutate it too, which keeps every surface holding that
 * resource consistent.
 *
 * CONTRACT: one descriptor per scope of a QueryClient. The patch matches a cached node purely by
 * `type:id` and rewrites it with `descriptor`'s attribute split, so it patches only the queries
 * whose key carries `scope` (an unscoped call, only unscoped keys): two servers whose `users` differ
 * share a QueryClient in two scopes without cross-contaminating. `installNormalization` enforces
 * one descriptor per scope for the auto path.
 */
export function normalize(
  queryClient: QueryClient,
  result: unknown,
  descriptor: ApiDescriptor,
  scope?: string,
): void {
  // An infinite query's earlier pages are indexed again each time a page is added. Their nodes'
  // records carry any newer value written since, so indexing them again never spreads stale data.
  const fresh = collectIncoming(result, descriptor)
  if (fresh.size === 0) {
    return
  }
  const queries = queriesIn(queryClient, scope)
  raiseToNewest(queries, fresh, descriptor)
  patchAll(queries, fresh, descriptor)
}

/**
 * Record cached data that arrived without a request stamp, hydrated from a server render or
 * restored from storage, as the oldest possible, so any read made in this process replaces it.
 * @internal
 */
export function stampHydrated(data: unknown): void {
  for (const part of partsOf(data)) {
    if (typeof part === 'object' && part !== null) {
      stampUnknown(targetOf(part))
    }
  }
}

/** The cached queries in `scope`: those whose key carries it, or every unscoped one. */
function queriesIn(queryClient: QueryClient, scope: string | undefined): Query[] {
  return queryClient
    .getQueryCache()
    .getAll()
    .filter((query) => scopeOf(query.queryKey) === scope)
}

/**
 * Patch the cached `queries` with the newest server values in `fresh`. We republish only the
 * queries that {@link patchCached} actually mutated, under a new root (see {@link republish}), so
 * their observers notify. Untouched queries keep their data reference, and every query keeps its
 * `isInvalidated` flag, so a patch never undoes the invalidation a create or delete made.
 */
function patchAll(queries: readonly Query[], fresh: Fresh, descriptor: ApiDescriptor): void {
  for (const query of queries) {
    const data = query.state.data
    if (data === undefined || data === null) {
      continue
    }
    const touched = partsOf(data).filter((part) => patchCached(part, fresh, descriptor))
    if (touched.length > 0) {
      republish(query, touched)
    }
  }
}

// ── Optimistic patching (write-through, with rollback) — ./mutate.ts ─────────────────────────

/**
 * A captured snapshot of the prior state of every node an optimistic patch touched, with a
 * `restore()` that puts each one back. The snapshot records, per affected cached node, the exact
 * prior value of every attribute key the patch overwrote (and which keys were newly added), so a
 * rollback is precise — it never disturbs keys the patch didn't touch, and it restores in place
 * (preserving identity + the per-edge `$pivot`/`$edge`, exactly as the forward patch does).
 */
export interface Snapshot {
  /** Undo the optimistic patch — restore every touched node to its pre-patch attributes. */
  restore(): void
}

/** One recorded node edit: the target object + the prior values to put back (undefined = was absent). */
interface NodeEdit {
  target: Record<string, unknown>
  /** Prior value per overwritten key; a key absent here that the patch added is recorded in `added`. */
  prior: Map<string, unknown>
  /** Keys the patch newly added (absent before) — restored by deletion. */
  added: Set<string>
  /**
   * The value THIS patch wrote, per key. Restore is compare-and-swap against it: a key is reverted
   * only if its current value is still the one we wrote, so an earlier patch rolling back can't stomp
   * a later concurrent optimistic patch's value on the same key (the later patch's own restore owns it).
   */
  wrote: Record<string, unknown>
}

/**
 * Apply an OPTIMISTIC attribute patch to a single `type:id` across every cached query and return a
 * {@link Snapshot} to roll it back. Mirrors the success path ({@link normalize}) — same in-place
 * attribute overwrite, same edge preservation — but for one known resource whose fresh attributes
 * the caller predicts (an update patch's attribute keys), and it captures the prior state first so
 * an error can restore it. Used by the update / relationship-set mutation factories' `onMutate`.
 */
export function applyOptimisticPatch(
  queryClient: QueryClient,
  type: string,
  id: string,
  attributes: Record<string, unknown>,
  descriptor: ApiDescriptor,
  scope?: string,
): Snapshot {
  const key = resourceKey(type, id)
  const edits: NodeEdit[] = []
  const touchedQueries: { query: Query; parts: readonly unknown[] }[] = []

  // Walk the cache explicitly (not `setQueriesData({}, ...)`) so we only write back queries that
  // actually hold this `type:id` — preserving untouched queries' identity and `isInvalidated`
  // flags, exactly as the success path ({@link patchAll}) does. It records no freshness: a
  // prediction isn't a server value, so the next real response follows the usual rule.
  for (const query of queriesIn(queryClient, scope)) {
    const data = query.state.data
    if (data === undefined || data === null) {
      continue
    }
    const parts = partsOf(data).filter((part) => {
      let touched = false
      walkResources(part, descriptor, (node) => {
        const ident = identity(node)
        if (ident === undefined || resourceKey(ident.type, ident.id) !== key) {
          return
        }
        const target = node as unknown as Record<string, unknown>
        // Capture prior values BEFORE overwriting, so the snapshot is precise.
        const prior = new Map<string, unknown>()
        const added = new Set<string>()
        for (const k of Object.keys(attributes)) {
          if (k in target) {
            prior.set(k, target[k])
          } else {
            added.add(k)
          }
        }
        edits.push({ target, prior, added, wrote: { ...attributes } })
        patchNode(target, attributes)
        touched = true
      })
      return touched
    })
    if (parts.length > 0) {
      republish(query, parts)
      touchedQueries.push({ query, parts })
    }
  }

  return {
    restore() {
      for (const edit of edits) {
        for (const [k, v] of edit.prior) {
          // Compare-and-swap: only revert a key still holding the value WE wrote. If a later
          // concurrent optimistic patch overwrote it, leave that newer value alone — its own
          // restore (or the success patch) owns the key now.
          if (edit.target[k] === edit.wrote[k]) {
            edit.target[k] = v
          }
        }
        for (const k of edit.added) {
          // Likewise: only delete a key we added that no later patch has since re-set.
          if (edit.target[k] === edit.wrote[k]) {
            delete edit.target[k]
          }
        }
      }
      for (const { query, parts } of touchedQueries) {
        republish(query, parts)
      }
    },
  }
}

// ── Optimistic relationship membership (by key prefix, with rollback) — ./mutate.ts ──────────

/**
 * A to-many array member for the optimistic patch: at minimum a linkage identifier (`type`+`id`,
 * optional `$pivot`), but any extra own props are preserved — so a caller who passes a fully
 * hydrated member (a resource view carrying attributes) gets a rich optimistic row, while a bare
 * `{type,id}` identifier is equally valid. Membership identity is by `type:id` alone (`sameRef`).
 */
export interface MembershipRef {
  type: string
  id: string
  $pivot?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * A membership transform over the CURRENT members of a cached related/relationship read: given the
 * present members (each an identifier `{type,id}` or a hydrated resource view — both expose
 * `type`/`id`), return the optimistic next members. The relationship-mutation factories build one
 * per verb (append the added refs, drop the removed ones, or swap in the replacement set).
 */
export type MembershipTransform = (members: readonly MembershipRef[]) => readonly MembershipRef[]

/**
 * Apply an OPTIMISTIC membership change to EVERY cached read of one parent's one relation — both its
 * related-collection (`fetchRelated`) and its relationship-linkage (`fetchRelationship`) reads,
 * matched BY KEY PREFIX so every page/param variant is covered at once (no coupling to the page
 * params a read used — the pain point D35b removes). The to-many read caches an array of members, so
 * the transform runs over that array; the snapshot restores each touched query's PRIOR data
 * wholesale on error. On settle the factory invalidates the relation subtree, so the server
 * reconciles regardless (a degraded optimistic member — an identifier without attributes — is
 * replaced by the real one). A to-one `set` is handled separately (it caches a single value, not an
 * array). `id` is `undefined` for a singleton parent, whose keys carry none.
 */
export function applyOptimisticMembership(
  queryClient: QueryClient,
  type: string,
  id: string | undefined,
  rel: string,
  transform: MembershipTransform,
  scope?: string,
): Snapshot {
  const prefixes = parentRelationReadKeys(type, id, rel, scope)
  const edits: { query: Query; previous: unknown }[] = []

  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey as QueryKey
    if (!prefixes.some((prefix) => keyHasPrefix(key, prefix))) {
      continue
    }
    const data = query.state.data
    if (!Array.isArray(data)) {
      // Only a to-many read caches an array; skip anything else (e.g. an in-flight/empty entry, or
      // an infinite read's pages, whose membership this doesn't edit).
      continue
    }
    edits.push({ query, previous: data })
    // The new members keep the array's `$page`, `$links` and `$next()`, which still describe the
    // page the server sent until the settle refetch reconciles it.
    query.setState({ data: withEnvelope(data, transform(data as readonly MembershipRef[])) })
  }

  return {
    restore() {
      for (const edit of edits) {
        edit.query.setState({ data: edit.previous })
      }
    },
  }
}

/**
 * The `members` as an array carrying `source`'s own non-index properties, the non-enumerable
 * `$`-accessors of an augmented array. They are set directly on the query's state, since
 * `setQueryData`'s structural sharing would rebuild a changed array as a plain one.
 */
function withEnvelope(source: readonly unknown[], members: readonly unknown[]): unknown[] {
  const out = [...members]
  for (const key of Reflect.ownKeys(source)) {
    if (key === 'length' || (typeof key === 'string' && /^\d+$/.test(key))) {
      continue
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor !== undefined) {
      Object.defineProperty(out, key, descriptor)
    }
  }
  return out
}

/** True when two refs address the same resource (`type:id`). Ignores `$pivot`/attributes. */
export function sameRef(a: MembershipRef, b: MembershipRef): boolean {
  return a.type === b.type && a.id === b.id
}

/**
 * Apply an OPTIMISTIC to-one `set` to every cached relationship/related read of one parent's one
 * relation (by key prefix): swap each cached value to `next` (a bare identifier ref, or `null` to
 * clear), snapshotting the prior value for rollback. A to-one read caches a single value (not an
 * array), so a plain replacement is correct; the settle refetch reconciles a bare identifier into
 * the fully-hydrated resource. `undefined` next means the ref carried no cache identity (an
 * lid-only atomic handle) — the cache is left untouched (the wire write still happens). `id` is
 * `undefined` for a singleton parent.
 */
export function applyOptimisticToOne(
  queryClient: QueryClient,
  type: string,
  id: string | undefined,
  rel: string,
  next: MembershipRef | null | undefined,
  scope?: string,
): Snapshot {
  const prefixes = parentRelationReadKeys(type, id, rel, scope)
  const edits: { query: Query; previous: unknown }[] = []
  if (next === undefined) {
    return { restore() {} }
  }

  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey as QueryKey
    if (!prefixes.some((prefix) => keyHasPrefix(key, prefix))) {
      continue
    }
    const data = query.state.data
    // A to-one read caches a single value or null: an array, or an infinite read's pages, would be
    // a to-many, so skip it.
    if (Array.isArray(data) || isInfiniteValue(data)) {
      continue
    }
    edits.push({ query, previous: data })
    query.setState({ data: next })
  }

  return {
    restore() {
      for (const edit of edits) {
        edit.query.setState({ data: edit.previous })
      }
    },
  }
}
