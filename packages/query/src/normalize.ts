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
import { peekStamp, stampOf, stampResult, stampUnknown, UNKNOWN_STAMP } from './freshness'
import { scopeOf } from './keys'
import { describeQuery, viewShape, type ViewShape, walkShaped } from './view-shape'

/** A `type:id` cache key for a resource. */
type ResourceKey = string

const resourceKey = (type: string, id: string): ResourceKey => `${type}:${id}`

/** The materialised value each republished root reads through to. */
const roots = new WeakMap<object, object>()

/**
 * The materialised value behind `value`, seeing through a republished root.
 * @internal
 */
export const targetOf = (value: object): object => roots.get(value) ?? value

/**
 * The array each membership edit derived a new array from (see {@link withMembers}), keyed by the
 * new array. A derived array is a materialised value's edited copy: it was read from the server as
 * much as its source was.
 */
const derived = new WeakMap<object, object>()

/** The materialised value `value` was published or derived from, through every root and edit. */
function originOf(value: object): object {
  let at = targetOf(value)
  for (let source = derived.get(at); source !== undefined; source = derived.get(at)) {
    at = targetOf(source)
  }
  return at
}

/**
 * Whether `value` is `ancestor`, or was derived from it by membership edits (through any root a
 * patch republished it under). A rollback undoes its edit of a list only while the list still
 * descends from the one it produced: one a read replaced since is the server's, and left alone.
 * @internal
 */
export function descends(value: unknown, ancestor: object): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const goal = targetOf(ancestor)
  let at: object | undefined = targetOf(value)
  while (at !== undefined) {
    if (at === goal) {
      return true
    }
    const source: object | undefined = derived.get(at)
    at = source === undefined ? undefined : targetOf(source)
  }
  return false
}

/**
 * `members` as an array carrying `source`'s envelope (its `$page`, `$links`, `$next()` and other
 * non-index properties), recorded as derived from `source`, and carrying `source`'s freshness stamp
 * when it has one. The array a membership edit publishes in place of `source`.
 * @internal
 */
export function withMembers(source: readonly unknown[], members: readonly unknown[]): unknown[] {
  const out = withEnvelope(source, members)
  const origin = targetOf(source)
  derived.set(out, origin)
  const stamp = peekStamp(origin)
  if (stamp !== undefined) {
    stampResult(out, stamp)
  }
  return out
}

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
/** @internal */
export function partsOf(data: unknown): readonly unknown[] {
  return isInfiniteValue(data) ? data.pages : [data]
}

/**
 * A new root reference for `value` that reads through to the same materialised value.
 * @internal
 */
export function reroot(value: object): object {
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
 * Publish a query's edited data once: `data` is what the query should now hold (its cached data, or
 * an edit of it whose arrays and pages are new), and `changed` the parts (by their materialised
 * value) whose objects were edited in place and so need a new root. A part that is already a new
 * object is published as it is; an infinite query's untouched pages keep their identity. Nothing is
 * set when nothing changed. Like {@link republish}, it sets the state directly, so the query keeps
 * its `isInvalidated` flag and isn't normalised as a fresh success.
 * @internal
 */
export function publishData(query: Query, data: unknown, changed: ReadonlySet<object>): void {
  const isChanged = (part: unknown): part is object =>
    typeof part === 'object' && part !== null && changed.has(targetOf(part))
  if (!isInfiniteValue(data)) {
    if (data !== query.state.data) {
      query.setState({ data })
    } else if (isChanged(data)) {
      query.setState({ data: reroot(data) })
    }
    return
  }
  let touched = data !== query.state.data
  const pages = data.pages.map((page) => {
    if (isChanged(page)) {
      touched = true
      return reroot(page)
    }
    return page
  })
  if (touched) {
    query.setState({ data: { ...data, pages } })
  }
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
  if (isMaterialised(originOf(data))) {
    return true
  }
  const pages = (data as { pages?: unknown }).pages
  return (
    Array.isArray(pages) &&
    Array.isArray((data as { pageParams?: unknown }).pageParams) &&
    pages.length > 0 &&
    pages.every((page) =>
      isMaterialised(typeof page === 'object' && page !== null ? originOf(page) : page),
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

/**
 * Give `view`, a per-edge view a draft built over `source`, the record of what `source` holds from
 * the server, so its values keep their age: they were copied from `source`. A view over a value
 * with no record (a member the caller supplied) holds no server value, and is recorded as of
 * unknown age.
 * @internal
 */
export function adoptRecord(view: object, source: object): void {
  const record = records.get(targetOf(source))
  records.set(targetOf(view), {
    born: record?.born ?? UNKNOWN_STAMP,
    written: new Map(record?.written),
  })
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
 * Whether a patch may write attribute `k` onto `node`, a copy in a slot of `shape`: when the copy
 * already holds the key, or the slot's fieldset selects it for the copy's type. A sparse copy never
 * gains an attribute its view's type says is absent, and an identifier gains none. With no known
 * shape (a query the binding didn't key), only keys the copy holds are written.
 * @internal
 */
export function writable(node: object, k: string, shape: ViewShape | undefined): boolean {
  if (Object.hasOwn(node, k)) {
    return true
  }
  if (shape?.kind !== 'resources') {
    return false
  }
  const type = (node as { type?: unknown }).type
  return typeof type === 'string' && shape.attributes.get(type)?.has(k) === true
}

/**
 * The shape a cached query's data promises at its top level, when its key decodes.
 * @internal
 */
export function shapeOfQuery(query: Query, descriptor: ApiDescriptor): ViewShape | undefined {
  const description = describeQuery(query, descriptor)
  return description === undefined || description.skipped
    ? undefined
    : viewShape(description, descriptor)
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
    changed = !Object.hasOwn(target, k) || target[k] !== fresh.value
    if (changed) {
      target[k] = fresh.value
    }
  }
  if (Object.hasOwn(target, k)) {
    recordOf(node).written.set(k, { value: target[k], stamp: fresh.stamp, paths: fresh.paths })
  }
  return changed
}

/**
 * Patch every materialised node in `cached` whose `type:id` appears in `fresh`, in place, returning
 * whether any VALUE actually changed. An attribute is written only where {@link writable} allows it
 * (a key the copy holds, or one its slot's fieldset selects), and only onto a node holding an older
 * server value of it, or none, or one as old when the response being normalised carried it: a
 * node whose value came from a request started later keeps it. We mutate the cached objects
 * directly (preserving their identity/accessors) rather than rebuilding them, so writing the same
 * reference back triggers TanStack's subscribers without a structural-sharing diff fighting the
 * per-edge views. A node already holding the values is a no-op (reports unchanged), so a redundant
 * re-application doesn't write back or re-notify.
 */
function patchCached(
  cached: unknown,
  fresh: Fresh,
  descriptor: ApiDescriptor,
  shape: ViewShape | undefined,
): boolean {
  let changed = false
  walkShaped(cached, shape, descriptor, (visited, at) => {
    const node = visited as unknown as MaterialisedResource
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
      if (!writable(node, k, at)) {
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

/**
 * The cached queries in `scope`: those whose key carries it, or every unscoped one.
 * @internal
 */
export function queriesIn(queryClient: QueryClient, scope: string | undefined): Query[] {
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
    const shape = shapeOfQuery(query, descriptor)
    const touched = partsOf(data).filter((part) => patchCached(part, fresh, descriptor, shape))
    if (touched.length > 0) {
      republish(query, touched)
    }
  }
}

// ── Optimistic patching (write-through, with rollback) ────────────────────────────────────────

/**
 * Undoes an optimistic change: `restore()` rolls it back, compare-and-swap, so a value written since
 * (by a response, or another optimistic change) is left alone.
 */
export interface Snapshot {
  /** Undo the optimistic change, leaving every value changed since alone. */
  restore(): void
}

export { applyOptimisticPatch } from './draft'

/**
 * A to-many member an optimistic change places: at minimum a linkage identifier (`type`+`id`,
 * optional `$pivot`). A member carrying attributes too can fill a slot that holds resources.
 * Membership identity is by `type:id` alone (`sameRef`).
 */
export interface MembershipRef {
  type: string
  id: string
  $pivot?: Record<string, unknown>
  [key: string]: unknown
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
