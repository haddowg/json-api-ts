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
import { type CacheView, cacheView, type Visit } from './cache-index'
import { identityKey, identityOf, isRecord } from './identity'
import { peekStamp, stampNow, stampOf, stampResult, stampUnknown, UNKNOWN_STAMP } from './freshness'
import { scopeOf } from './keys'
import { propagateRelationships, type ServerSlot } from './relationships'
import { type ViewShape, walkShaped } from './view-shape'

/** A `type:id` cache key for a resource ({@link identityKey}). */
type ResourceKey = string

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
 * `value` behind any root, then every array it was derived from by membership edits, nearest first.
 * @internal
 */
export function lineageOf(value: object): object[] {
  const out: object[] = []
  for (let at: object | undefined = targetOf(value); at !== undefined && !out.includes(at); ) {
    out.push(at)
    const source: object | undefined = derived.get(at)
    at = source === undefined ? undefined : targetOf(source)
  }
  return out
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

/** TanStack's cached data for an infinite query: its pages and the params that read them. @internal */
export interface InfiniteValue {
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
    identityOf(value) === undefined
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
 * Publish a query's edited data once: `data` is what the query should now hold (its cached data, or
 * an edit of it whose arrays and pages are new), and `changed` the parts (by their materialised
 * value) whose objects were edited in place and so need a new root (see {@link reroot}), through
 * which a later patch or rollback of the same objects shows. A part that is already a new object is
 * published as it is; an infinite query's untouched pages keep their identity. Nothing is set when
 * nothing changed. The state is set directly rather than through `setQueryData`, whose structural
 * sharing would hand the old root back because nothing differs by value, and which would clear the
 * query's `isInvalidated` and re-run normalisation as a fresh success.
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
  return (
    isInfiniteValue(data) &&
    data.pages.length > 0 &&
    data.pages.every((page) =>
      isMaterialised(typeof page === 'object' && page !== null ? originOf(page) : page),
    )
  )
}

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

/** The newest server value of each attribute of one resource a response carries. */
interface FreshResource {
  readonly type: string
  readonly id: string
  readonly attributes: Map<string, Candidate>
}

/** The newest server value of each attribute a response carries, by `type:id` then attribute. */
type Fresh = Map<ResourceKey, FreshResource>

/**
 * What a cached node holds from the server: the stamp of the response it was materialised from,
 * each attribute a normalisation has written onto it since, with that write's stamp, and each
 * relation slot a read's linkage has replaced since (design A7 R3), with that read's stamp and
 * linkage. Kept per node (each per-edge view and each canonical node), keyed by the materialised
 * object behind it. An optimistic change writes no record, so a prediction is never mistaken for a
 * server value.
 */
interface NodeRecord {
  born: number
  written: Map<string, ServerValue>
  slots: Map<string, ServerSlot>
}

const records = new WeakMap<object, NodeRecord>()

/** The record of `node`, created (as of unknown age) when it has none. */
function recordOf(node: object): NodeRecord {
  const target = targetOf(node)
  let record = records.get(target)
  if (record === undefined) {
    record = { born: UNKNOWN_STAMP, written: new Map(), slots: new Map() }
    records.set(target, record)
  }
  return record
}

/**
 * The stamp of the response `node` was materialised from, or {@link UNKNOWN_STAMP} when none is
 * recorded.
 * @internal
 */
export const bornOf = (node: object): number => records.get(targetOf(node))?.born ?? UNKNOWN_STAMP

/**
 * The linkage a read last wrote into relation slot `rel` of `node`, with that read's stamp, when one
 * has (design A7 R3).
 * @internal
 */
export const writtenSlot = (node: object, rel: string): ServerSlot | undefined =>
  records.get(targetOf(node))?.slots.get(rel)

/**
 * Record that relation slot `rel` of `node` holds the server linkage `slot` describes.
 * @internal
 */
export function recordSlot(node: object, rel: string, slot: ServerSlot): void {
  recordOf(node).slots.set(rel, slot)
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
    slots: new Map(record?.slots),
  })
}

/** Record that `node` was materialised from a response stamped `stamp`, unless it already was. */
function recordBirth(node: object, stamp: number): void {
  const target = targetOf(node)
  if (!records.has(target)) {
    records.set(target, { born: stamp, written: new Map(), slots: new Map() })
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

/** The server value `node` holds for attribute `k` (see {@link serverValues}), when it holds one. */
function heldValue(node: MaterialisedResource, k: string): ServerValue | undefined {
  const record = records.get(targetOf(node))
  const written = record?.written.get(k)
  if (written !== undefined) {
    return written
  }
  const raw = attributesOf(node)
  // Enumerable, as `serverValues` reads the raw attributes through `Object.entries`.
  return raw !== undefined && Object.prototype.propertyIsEnumerable.call(raw, k)
    ? { value: raw[k], stamp: record?.born ?? UNKNOWN_STAMP, paths: narrowedPaths(node, k) }
    : undefined
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

/**
 * The attributes a node was materialised with, read from its `$raw.attributes` (the wire split of
 * attributes from relations). Returns `undefined` when the node carries no `$raw` or no
 * attributes block (a bare identifier view, or an attribute-less resource). Never falls back to
 * enumerating own props, which would conflate relation slots with attributes.
 */
function attributesOf(node: MaterialisedResource): Record<string, unknown> | undefined {
  const attrs = node.$raw?.attributes
  return isRecord(attrs) ? attrs : undefined
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
  if (!isRecord(cached) || !isRecord(fresh)) {
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
  ident: { readonly type: string; readonly id: string },
  k: string,
  candidate: Candidate,
  tieWins: boolean,
): void {
  let resource = fresh.get(key)
  if (resource === undefined) {
    resource = { type: ident.type, id: ident.id, attributes: new Map() }
    fresh.set(key, resource)
  }
  const current = resource.attributes.get(k)
  if (
    current === undefined ||
    candidate.stamp > current.stamp ||
    (tieWins && candidate.stamp === current.stamp)
  ) {
    resource.attributes.set(k, candidate)
  }
}

/**
 * Index the server value of every attribute of every resource in `result` by `type:id`, each with
 * the stamp of the response that read it: the result's own (an infinite query's pages each have
 * theirs), or, for an attribute a newer response already wrote onto one of its nodes, that
 * response's. Each node of the result is recorded as born at its result's stamp. Also returns the
 * nodes visited, by materialised value.
 */
function collectIncoming(
  result: unknown,
  descriptor: ApiDescriptor,
): { fresh: Fresh; nodes: Set<object> } {
  const fresh: Fresh = new Map()
  const nodes = new Set<object>()
  for (const part of partsOf(result)) {
    if (typeof part !== 'object' || part === null) {
      continue
    }
    const stamp = stampOf(targetOf(part))
    walkShaped(part, undefined, descriptor, (visited) => {
      const node = visited as unknown as MaterialisedResource
      const ident = identityOf(node)
      if (ident === undefined) {
        return
      }
      recordBirth(node, stamp)
      nodes.add(targetOf(node))
      const key = identityKey(ident.type, ident.id)
      for (const [k, value] of serverValues(node)) {
        // A later occurrence wins a tie: for one response, the copies are the same wire object.
        consider(fresh, key, ident, k, { ...value, incoming: true }, true)
      }
    })
  }
  return { fresh, nodes }
}

/**
 * Raise each attribute in `fresh` to the newest server value any cached copy of its resource holds,
 * so a response arriving after a newer one takes the newer values rather than spreading its own.
 * The copies are the index's, in the order a walk of the cache visits them. A copy among
 * `incoming`, the response's own nodes, holds nothing newer than `fresh` already took from it.
 */
function raiseToNewest(
  view: CacheView,
  fresh: Fresh,
  incoming: ReadonlySet<object>,
  wins: ReadonlySet<string> | undefined,
): void {
  for (const [key, resource] of fresh) {
    const { type, id, attributes } = resource
    const won =
      wins === undefined
        ? undefined
        : new Set([...attributes.keys()].filter((k) => wins.has(fieldKey(type, id, k))))
    for (const query of view.ordered(view.holding(type, id))) {
      for (const visit of view.visits(query, type, id)) {
        if (!visit.first || incoming.has(targetOf(visit.node))) {
          continue
        }
        const node = visit.node as unknown as MaterialisedResource
        for (const [k, current] of attributes) {
          const value = heldValue(node, k)
          if (value === undefined) {
            continue
          }
          if (won?.has(k) === true) {
            // A write's own response wins over every value cached meanwhile: it keeps its value and
            // takes the newest stamp, so no older read landing later replaces it.
            if (current.incoming && value.stamp > current.stamp) {
              current.stamp = value.stamp
            }
            continue
          }
          consider(fresh, key, resource, k, { ...value, incoming: false }, false)
        }
      }
    }
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
 * Patch the copies `visits` (one part's, in walk order) of the resources in `fresh`, in place,
 * returning whether any VALUE actually changed. An attribute is written only where {@link writable}
 * allows it (a key the copy holds, or one its slot's fieldset selects), and only onto a node holding
 * an older server value of it, or none, or one as old when the response being normalised carried
 * it: a node whose value came from a request started later keeps it. We mutate the cached objects
 * directly (preserving their identity/accessors) rather than rebuilding them, so writing the same
 * reference back triggers TanStack's subscribers without a structural-sharing diff fighting the
 * per-edge views. A node already holding the values is a no-op (reports unchanged), so a redundant
 * re-application doesn't write back or re-notify.
 */
function patchVisits(visits: readonly Visit[], fresh: Fresh, at: PatchContext): boolean {
  let changed = false
  for (const { node: visited, shape: slot } of visits) {
    const node = visited as unknown as MaterialisedResource
    const ident = identityOf(node)
    if (ident === undefined) {
      continue
    }
    const attributes = fresh.get(identityKey(ident.type, ident.id))?.attributes
    if (attributes === undefined) {
      continue
    }
    const claimOf = claimsOn(at.queryClient, at.scope, ident.type, ident.id)
    for (const [k, value] of attributes) {
      const held = heldStamp(node, k)
      const stale =
        held !== undefined && (held > value.stamp || (held === value.stamp && !value.incoming))
      const claim = claimOf?.(k)
      if (claim !== undefined) {
        // An open draft owns the field (R2): the server value is recorded, for a rollback to
        // restore, and the node keeps showing the prediction.
        if (!stale) {
          recordServerValue(node, k, value)
        }
        if (writable(node, k, slot) && showClaim(visited, k, claim, at.query)) {
          changed = true
        }
        continue
      }
      if (stale || !writable(node, k, slot)) {
        continue
      }
      if (writeServerValue(node, k, value)) {
        changed = true
      }
    }
  }
  return changed
}

/** Where a patch runs: the QueryClient, the scope and the query being patched. */
interface PatchContext {
  readonly queryClient: QueryClient
  readonly scope: string | undefined
  readonly query: Query
}

/**
 * Write-through patch (the heart of Strategy 2). Given a freshly-resolved materialised
 * `result`, index its resources by `type:id` and patch every cached query that holds any of
 * those `type:id`s in place, so a single response updates the same resource everywhere it
 * is cached ("edit once, updates everywhere").
 *
 * Newer data wins, whatever order responses arrive in. A client result carries its request's
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
 * result no request stamped is stamped when it is first normalised, so it keeps arrival order.
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
  normalizeRead(queryClient, result, descriptor, scope, undefined)
}

/**
 * {@link normalize} for a read's result, `landed` being the query it landed in when known: the
 * attributes are patched as for any response, and the relationships it carries are propagated to
 * the other cached copies of their resources (design A7 R3, see ./relationships.ts), never
 * invalidating `landed` itself.
 * @internal
 */
export function normalizeRead(
  queryClient: QueryClient,
  result: unknown,
  descriptor: ApiDescriptor,
  scope: string | undefined,
  landed: Query | undefined,
): void {
  run(queryClient, result, descriptor, scope, undefined, landed ?? null)
}

/**
 * {@link normalize}, with the fields (each a {@link fieldKey}) whose value in `result` wins over every
 * cached value whatever its stamp: a write's response, for the fields its draft predicted.
 * @internal
 */
export function normalizeWith(
  queryClient: QueryClient,
  result: unknown,
  descriptor: ApiDescriptor,
  scope: string | undefined,
  wins: ReadonlySet<string> | undefined,
): void {
  run(queryClient, result, descriptor, scope, wins, undefined)
}

/**
 * Normalise `result`: patch its attributes everywhere, and, for a read (`read` is the query it
 * landed in, `null` when unknown, `undefined` for a write's response), propagate its relationships.
 */
function run(
  queryClient: QueryClient,
  result: unknown,
  descriptor: ApiDescriptor,
  scope: string | undefined,
  wins: ReadonlySet<string> | undefined,
  read: Query | null | undefined,
): void {
  // An infinite query's earlier pages are indexed again each time a page is added. Their nodes'
  // records carry any newer value written since, so indexing them again never spreads stale data.
  const { fresh, nodes } = collectIncoming(result, descriptor)
  // Relationships first, so a member a slot gains is patched with the newest attributes below.
  const relinked =
    read === undefined
      ? new Map<Query, Set<object>>()
      : propagateRelationships(
          queryClient,
          result,
          descriptor,
          scope,
          cacheView(queryClient, scope, descriptor),
          read ?? undefined,
        )
  if (fresh.size === 0 && relinked.size === 0) {
    return
  }
  // Taken again: the relationships propagated may have changed what a query holds.
  const view = cacheView(queryClient, scope, descriptor)
  if (fresh.size > 0) {
    raiseToNewest(view, fresh, nodes, wins)
  }
  patchAll(queryClient, scope, view, fresh, relinked)
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
 * Record data the app wrote itself (`setQueryData`) as current now, whatever request produced it:
 * the app asserts it is current when it writes it.
 * @internal
 */
export function stampWritten(data: unknown): void {
  for (const part of partsOf(data)) {
    if (typeof part === 'object' && part !== null) {
      stampNow(targetOf(part))
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
 * Patch the cached queries holding a resource in `fresh` with its newest server values. We
 * republish only the queries that {@link patchVisits} actually mutated, or whose relation slots a
 * read relinked (`relinked`, by query, the parts holding them), under a new root (see
 * {@link publishData}), so their observers notify once. Untouched queries keep their data reference,
 * and every query keeps its `isInvalidated` flag, so a patch never undoes the invalidation a create
 * or delete made.
 */
function patchAll(
  queryClient: QueryClient,
  scope: string | undefined,
  view: CacheView,
  fresh: Fresh,
  relinked: ReadonlyMap<Query, ReadonlySet<object>>,
): void {
  // The copies to patch, by query, then by part.
  const copies = new Map<Query, Map<number, Visit[]>>()
  for (const { type, id } of fresh.values()) {
    for (const query of view.holding(type, id)) {
      const parts = copies.get(query) ?? new Map<number, Visit[]>()
      copies.set(query, parts)
      for (const visit of view.visits(query, type, id)) {
        const list = parts.get(visit.part) ?? []
        parts.set(visit.part, list)
        list.push(visit)
      }
    }
  }
  for (const query of view.ordered(new Set([...copies.keys(), ...relinked.keys()]))) {
    const data = query.state.data
    if (data === undefined || data === null) {
      continue
    }
    const at: PatchContext = { queryClient, scope, query }
    const slots = relinked.get(query)
    const parts = copies.get(query)
    const touched = partsOf(data).filter((part, index) => {
      const visits = parts?.get(index)
      // oxlint-disable-next-line no-array-sort -- each part's list is this pass's own
      const patched = visits !== undefined && patchVisits(visits.sort(bySeq), fresh, at)
      return (
        patched ||
        (typeof part === 'object' && part !== null && slots?.has(targetOf(part)) === true)
      )
    })
    if (touched.length > 0) {
      publishData(query, data, new Set(touched.map((part) => targetOf(part as object))))
    }
  }
}

const bySeq = (a: Visit, b: Visit): number => a.seq - b.seq

// ── Claims: the fields an open optimistic draft predicts (design A7 R2) ────────────────────

/** A node showing a claim's prediction, and what it showed before the claim reached it. */
export interface ClaimedNode {
  readonly node: Record<string, unknown>
  readonly query: Query
  readonly had: boolean
  readonly prior: unknown
}

/**
 * One attribute of one resource an open optimistic draft predicts. While it stands, a
 * normalisation landing on the attribute records the server value it brings, for a rollback to
 * restore, and leaves the prediction showing on every copy it reaches, a copy just read included.
 * @internal
 */
export interface FieldClaim {
  readonly owner: object
  readonly scope: string | undefined
  readonly type: string
  /** `undefined` for a singleton addressed by type alone. */
  readonly id: string | undefined
  readonly key: string
  value: unknown
  /** The order claims were made in, the latest highest. */
  seq: number
  /** Every node showing the prediction, by its materialised value. */
  readonly nodes: Map<object, ClaimedNode>
  /** Told when a normalisation shows the prediction on a node the draft hadn't written. */
  readonly adopt: (node: object, query: Query) => void
}

/** A resource's claims, by attribute, each list oldest first. */
type ClaimsByKey = Map<string, FieldClaim[]>

/**
 * The claims of each QueryClient, by scope, type, then id (`undefined` for a singleton's claims by
 * type alone). Emptied maps are removed, so a client with no claim has no scopes.
 */
const claimRegistry = new WeakMap<
  QueryClient,
  Map<string | undefined, Map<string, Map<string | undefined, ClaimsByKey>>>
>()

let claimSeq = 0

/**
 * The key a field is named by in {@link normalizeWith}'s `wins`.
 * @internal
 */
export const fieldKey = (type: string, id: string, attribute: string): string =>
  JSON.stringify([type, id, attribute])

/**
 * Add `claim` as the latest prediction of its field.
 * @internal
 */
export function addClaim(queryClient: QueryClient, claim: FieldClaim): void {
  const scopes = claimRegistry.get(queryClient) ?? new Map()
  claimRegistry.set(queryClient, scopes)
  const types = scopes.get(claim.scope) ?? new Map()
  scopes.set(claim.scope, types)
  const ids = types.get(claim.type) ?? new Map()
  types.set(claim.type, ids)
  const keys: ClaimsByKey = ids.get(claim.id) ?? new Map()
  ids.set(claim.id, keys)
  const list = (keys.get(claim.key) ?? []).filter((other) => other !== claim)
  claimSeq += 1
  claim.seq = claimSeq
  list.push(claim)
  keys.set(claim.key, list)
}

/**
 * Remove `claim`, and with `below` every older claim of the same field: a write its server confirmed
 * supersedes the predictions made before it.
 * @internal
 */
export function removeClaim(queryClient: QueryClient, claim: FieldClaim, below = false): void {
  const scopes = claimRegistry.get(queryClient)
  const types = scopes?.get(claim.scope)
  const ids = types?.get(claim.type)
  const keys = ids?.get(claim.id)
  const list = keys?.get(claim.key)
  if (
    scopes === undefined ||
    types === undefined ||
    ids === undefined ||
    keys === undefined ||
    list === undefined
  ) {
    return
  }
  const kept = list.filter((other) => other !== claim && !(below && other.seq < claim.seq))
  if (kept.length > 0) {
    keys.set(claim.key, kept)
    return
  }
  keys.delete(claim.key)
  if (keys.size === 0) {
    ids.delete(claim.id)
  }
  if (ids.size === 0) {
    types.delete(claim.type)
  }
  if (types.size === 0) {
    scopes.delete(claim.scope)
  }
}

/**
 * The latest claim on each attribute of `type:id` in `scope`, as a lookup by attribute: one naming
 * the id, or one a singleton made by type alone. `undefined` when the resource has no claim.
 */
function claimsOn(
  queryClient: QueryClient,
  scope: string | undefined,
  type: string,
  id: string | undefined,
): ((key: string) => FieldClaim | undefined) | undefined {
  const ids = claimRegistry.get(queryClient)?.get(scope)?.get(type)
  const named = ids?.get(id)
  const byType = id === undefined ? undefined : ids?.get(undefined)
  if (named === undefined && byType === undefined) {
    return undefined
  }
  return (key) => {
    const a = named?.get(key)?.at(-1)
    const b = byType?.get(key)?.at(-1)
    return b !== undefined && (a === undefined || b.seq > a.seq) ? b : a
  }
}

/**
 * The latest claim on attribute `key` of `type:id` in `scope`: one naming the id, or one a singleton
 * made by type alone.
 * @internal
 */
export function topClaim(
  queryClient: QueryClient,
  scope: string | undefined,
  type: string,
  id: string | undefined,
  key: string,
): FieldClaim | undefined {
  return claimsOn(queryClient, scope, type, id)?.(key)
}

/**
 * Show `claim`'s prediction on `node`, recording the node; returns whether its value changed.
 * @internal
 */
export function showClaim(
  node: Record<string, unknown>,
  k: string,
  claim: FieldClaim,
  query: Query,
): boolean {
  const target = targetOf(node)
  const had = Object.hasOwn(node, k)
  if (!claim.nodes.has(target)) {
    claim.nodes.set(target, { node, query, had, prior: node[k] })
    claim.adopt(node, query)
  }
  if (had && node[k] === claim.value) {
    return false
  }
  node[k] = claim.value
  return true
}

/**
 * Record a server value of attribute `k` for `node` without showing it, merging a value its read
 * narrowed into the server value the node already records.
 */
function recordServerValue(node: MaterialisedResource, k: string, fresh: ServerValue): void {
  let value = fresh.value
  if (fresh.paths !== undefined && value !== null) {
    const base = serverValueOf(node, k)
    if (base === undefined) {
      return
    }
    value = mergedSelection(base.value, value, fresh.paths)
  }
  recordOf(node).written.set(k, { value, stamp: fresh.stamp, paths: fresh.paths })
}

/**
 * The newest server value `node` records for attribute `k`, whatever it shows: what a normalisation
 * last wrote or recorded, else what it was materialised with. `undefined` when it holds none.
 * @internal
 */
export function serverValueOf(node: object, k: string): { value: unknown } | undefined {
  const record = records.get(targetOf(node))
  const written = record?.written.get(k)
  if (written !== undefined) {
    return { value: written.value }
  }
  const raw = attributesOf(node as MaterialisedResource)
  return raw !== undefined && Object.hasOwn(raw, k) ? { value: raw[k] } : undefined
}

// ── Optimistic patching (write-through, with rollback) ────────────────────────────────────────

/**
 * Undoes an optimistic change: `restore()` rolls it back, compare-and-swap, so a value written since
 * (by a response, or another optimistic change) is left alone.
 *
 * @internal
 */
export interface Snapshot {
  /** Undo the optimistic change, leaving every value changed since alone. */
  restore(): void
}

/** @internal */
export { applyOptimisticPatch } from './draft'

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
