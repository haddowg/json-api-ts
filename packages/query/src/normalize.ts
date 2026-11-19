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
 * relations), merging an attribute its read narrowed to some keys (`$keySelection`) into the cached
 * value instead, while PRESERVING the materialised object's edge-local `$pivot`/`$edge`, its
 * `$`-accessors, and its identity-by-`type:id`. The same Track in two playlists carries
 * different per-edge pivot data, so we never merge one edge's data onto another — only the
 * shared node's attributes change, and those live as own enumerable props that we overwrite
 * key-by-key, leaving the non-enumerable per-edge getters untouched.
 *
 * The nodes are patched in place, but each touched query's data is then republished under a new
 * root reference that reads through to the same graph, so an observer comparing `data` by
 * reference, as React Query's tracked mode does, sees the change and re-renders.
 *
 * This only covers UPDATES to existing resources (a node patch). Creates/deletes change
 * collection membership, which is not a node patch — those invalidate the relevant list/
 * relationship queries instead (see ./mutate.ts).
 */
import type { ApiDescriptor, KeySelection } from '@haddowg/json-api-client'
import type { Query, QueryClient } from '@tanstack/query-core'
import { keyHasPrefix, parentRelationReadKeys, type QueryKey } from './keys'

/** A `type:id` cache key for a resource. */
type ResourceKey = string

const resourceKey = (type: string, id: string): ResourceKey => `${type}:${id}`

/** The materialised value each republished root reads through to. */
const roots = new WeakMap<object, object>()

/**
 * Publish a query's patched data again under a new root reference. The root is a transparent
 * proxy of the materialised value, so its accessors, its array-ness and the graph below it are the
 * same objects, and a later patch or rollback of those objects shows through it. The state is set
 * directly rather than through `setQueryData`, whose structural sharing would hand the old root
 * back because nothing differs by value, and which would clear the query's `isInvalidated` and
 * re-run normalisation as a fresh success.
 */
function republish(query: Query): void {
  const data = query.state.data
  if (typeof data !== 'object' || data === null) {
    return
  }
  const target = roots.get(data) ?? data
  const root = new Proxy(target, {})
  roots.set(root, target)
  query.setState({ data: root })
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
  readonly $keySelection?: KeySelection
}

/**
 * A resource's freshest attributes, with the attributes its read narrowed to some of their keys,
 * which hold only part of the value.
 */
interface FreshAttributes {
  attributes: Record<string, unknown>
  narrowed: KeySelection | undefined
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
 * The freshest attributes for a node, read from its `$raw.attributes` (the wire split of
 * attributes from relations). Returns `undefined` when the node carries no `$raw` or no
 * attributes block (a bare identifier view, or an attribute-less resource) — nothing to
 * propagate. Never falls back to enumerating own props, which would conflate relation slots
 * with attributes.
 */
function attributesOf(node: MaterialisedResource): Record<string, unknown> | undefined {
  const attrs = node.$raw?.attributes
  return isObject(attrs) ? attrs : undefined
}

/**
 * Walk a materialised value (a single resource, an augmented array, a to-one/to-many relation
 * value, or `null`/`undefined`) and visit every reachable resource exactly once. Recurses into
 * each resource's own enumerable relation slots so a deeply-included graph is fully indexed.
 * `seen` guards relation cycles (a node memoised by reference) and keeps the walk linear.
 */
function walkResources(
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
  narrowed?: KeySelection,
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
 * cached object or list, keeping what the path didn't select.
 */
function mergedValue(
  cached: Record<string, unknown>,
  fresh: Record<string, unknown>,
  paths: readonly string[],
): Record<string, unknown> {
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

/**
 * Index every resource in `result` by `type:id` → its freshest attributes, then return the
 * set of `type:id`s the result carries. The caller patches every cached query holding any of
 * those keys (see {@link normalize}).
 */
function collectAttributes(
  result: unknown,
  descriptor: ApiDescriptor,
): Map<ResourceKey, FreshAttributes> {
  const fresh = new Map<ResourceKey, FreshAttributes>()
  walkResources(result, descriptor, (node) => {
    const ident = identity(node)
    if (ident === undefined) {
      return
    }
    const attributes = attributesOf(node)
    if (attributes !== undefined) {
      // Last write wins: a later occurrence (e.g. the primary resource vs an included copy)
      // overwrites an earlier one. For one response they are the same wire object anyway.
      const narrowed = node.$keySelection
      fresh.set(resourceKey(ident.type, ident.id), {
        attributes,
        narrowed:
          narrowed === undefined || Object.keys(narrowed).length === 0 ? undefined : narrowed,
      })
    }
  })
  return fresh
}

/**
 * Patch every materialised node in `cached` whose `type:id` appears in `fresh`, in place,
 * with the freshest attributes — returning whether any VALUE actually changed. We mutate the
 * cached objects directly (preserving their identity/accessors) rather than rebuilding them, so
 * writing the same reference back triggers TanStack's subscribers without a structural-sharing diff
 * fighting the per-edge views. A node whose attributes already equal `fresh` is a no-op (reports
 * unchanged), so a redundant re-application doesn't write back or re-notify.
 */
function patchCached(
  cached: unknown,
  fresh: Map<ResourceKey, FreshAttributes>,
  descriptor: ApiDescriptor,
): boolean {
  let changed = false
  walkResources(cached, descriptor, (node) => {
    const ident = identity(node)
    if (ident === undefined) {
      return
    }
    const entry = fresh.get(resourceKey(ident.type, ident.id))
    if (
      entry !== undefined &&
      patchNode(node as unknown as Record<string, unknown>, entry.attributes, entry.narrowed)
    ) {
      changed = true
    }
  })
  return changed
}

/**
 * Write-through patch (the heart of Strategy 2). Given a freshly-resolved materialised
 * `result`, index its resources by `type:id` and patch every OTHER cached query that holds any
 * of those `type:id`s in place, so a single response updates the same resource everywhere it
 * is cached ("edit once, updates everywhere").
 *
 * Edge-local `$pivot`/`$edge` and a node's identity are preserved (only own-enumerable
 * attribute props are overwritten). Pass `result` from an option factory's `onSuccess` (or use
 * {@link installNormalization} to subscribe to every query/mutation success automatically).
 *
 * `result` is the materialised value the client produced for this response (a resource, a
 * `Collection`, a related collection, or linkage). The same reference may also be the cached
 * entry for the query that produced it — we mutate it too (idempotently), which is harmless and
 * keeps every surface holding that resource consistent.
 *
 * CONTRACT: a single QueryClient must hold caches for ONE descriptor only. The patch matches a
 * cached node purely by `type:id` and rewrites it with `descriptor`'s attribute split, so two
 * descriptors that share a QueryClient and a `type:id` (e.g. a `default` + an `admin` server whose
 * `users` differ) would cross-contaminate. `installNormalization` enforces this for the auto path;
 * when calling `normalize` standalone, give each typed client/server its own QueryClient.
 */
export function normalize(
  queryClient: QueryClient,
  result: unknown,
  descriptor: ApiDescriptor,
): void {
  const fresh = collectAttributes(result, descriptor)
  if (fresh.size === 0) {
    return
  }
  patchAll(queryClient, fresh, descriptor)
}

/**
 * Patch every cached query with a `type:id -> fresh attributes` map. We walk the query cache
 * explicitly and republish only the queries that {@link patchCached} actually mutated, under a new
 * root (see {@link republish}), so their observers notify. Untouched queries keep their data
 * reference, and every query keeps its `isInvalidated` flag, so a patch never undoes the
 * invalidation a create or delete made.
 */
function patchAll(
  queryClient: QueryClient,
  fresh: Map<ResourceKey, FreshAttributes>,
  descriptor: ApiDescriptor,
): void {
  for (const query of queryClient.getQueryCache().getAll()) {
    const data = query.state.data
    if (data === undefined || data === null) {
      continue
    }
    if (patchCached(data, fresh, descriptor)) {
      republish(query)
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
): Snapshot {
  const key = resourceKey(type, id)
  const edits: NodeEdit[] = []
  const touchedQueries: Query[] = []

  // Walk the cache explicitly (not `setQueriesData({}, ...)`) so we only write back queries that
  // actually hold this `type:id` — preserving untouched queries' identity and `isInvalidated`
  // flags, exactly as the success path ({@link patchAll}) does.
  for (const query of queryClient.getQueryCache().getAll()) {
    const data = query.state.data
    if (data === undefined || data === null) {
      continue
    }
    let touched = false
    walkResources(data, descriptor, (node) => {
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
    if (touched) {
      republish(query)
      touchedQueries.push(query)
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
      for (const query of touchedQueries) {
        republish(query)
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
): Snapshot {
  const prefixes = parentRelationReadKeys(type, id, rel)
  const edits: { query: Query; previous: unknown }[] = []

  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey as QueryKey
    if (!prefixes.some((prefix) => keyHasPrefix(key, prefix))) {
      continue
    }
    const data = query.state.data
    if (!Array.isArray(data)) {
      // Only a to-many read caches an array; skip anything else (e.g. an in-flight/empty entry).
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
): Snapshot {
  const prefixes = parentRelationReadKeys(type, id, rel)
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
    // A to-one read caches a single value or null (an array would be a to-many — skip it).
    if (Array.isArray(data)) {
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
