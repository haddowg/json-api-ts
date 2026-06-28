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
 * relations) while PRESERVING the materialised object's edge-local `$pivot`/`$edge`, its
 * `$`-accessors, and its identity-by-`type:id`. The same Track in two playlists carries
 * different per-edge pivot data, so we never merge one edge's data onto another — only the
 * shared node's attributes change, and those live as own enumerable props that we overwrite
 * key-by-key, leaving the non-enumerable per-edge getters untouched.
 *
 * This only covers UPDATES to existing resources (a node patch). Creates/deletes change
 * collection membership, which is not a node patch — those invalidate the relevant list/
 * relationship queries instead (see ./mutate.ts).
 */
import type { ApiDescriptor } from '@haddowg/json-api-client'
import type { QueryClient } from '@tanstack/query-core'

/** A `type:id` cache key for a resource. */
type ResourceKey = string

const resourceKey = (type: string, id: string): ResourceKey => `${type}:${id}`

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
function patchNode(target: Record<string, unknown>, attributes: Record<string, unknown>): boolean {
  let changed = false
  for (const [k, v] of Object.entries(attributes)) {
    if (!(k in target) || target[k] !== v) {
      target[k] = v
      changed = true
    }
  }
  return changed
}

/**
 * Index every resource in `result` by `type:id` → its freshest attributes, then return the
 * set of `type:id`s the result carries. The caller patches every cached query holding any of
 * those keys (see {@link normalize}).
 */
function collectAttributes(
  result: unknown,
  descriptor: ApiDescriptor,
): Map<ResourceKey, Record<string, unknown>> {
  const fresh = new Map<ResourceKey, Record<string, unknown>>()
  walkResources(result, descriptor, (node) => {
    const ident = identity(node)
    if (ident === undefined) {
      return
    }
    const attributes = attributesOf(node)
    if (attributes !== undefined) {
      // Last write wins: a later occurrence (e.g. the primary resource vs an included copy)
      // overwrites an earlier one. For one response they are the same wire object anyway.
      fresh.set(resourceKey(ident.type, ident.id), attributes)
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
  fresh: Map<ResourceKey, Record<string, unknown>>,
  descriptor: ApiDescriptor,
): boolean {
  let changed = false
  walkResources(cached, descriptor, (node) => {
    const ident = identity(node)
    if (ident === undefined) {
      return
    }
    const attributes = fresh.get(resourceKey(ident.type, ident.id))
    if (
      attributes !== undefined &&
      patchNode(node as unknown as Record<string, unknown>, attributes)
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
 * explicitly and only `setQueryData` back the queries that {@link patchCached} actually mutated —
 * NOT a blanket `setQueriesData({}, ...)`. The blanket form writes data back to every cached
 * query, and TanStack's `setQueryData` unconditionally clears `isInvalidated` on the written
 * query: a normalize pass over one type would silently un-invalidate untouched queries of other
 * types, undoing the create/delete membership invalidation (ADR 0003). Gating the write on the
 * `changed` flag keeps touched queries' in-place identity (so their observers notify) while
 * leaving untouched queries — and their `isInvalidated` flags — completely alone.
 */
function patchAll(
  queryClient: QueryClient,
  fresh: Map<ResourceKey, Record<string, unknown>>,
  descriptor: ApiDescriptor,
): void {
  for (const query of queryClient.getQueryCache().getAll()) {
    const data = query.state.data
    if (data === undefined || data === null) {
      continue
    }
    if (patchCached(data, fresh, descriptor)) {
      // Write the same (mutated-in-place) reference back so this query's observers see the change;
      // only touched queries are written, so untouched queries' isInvalidated flags survive.
      queryClient.setQueryData(query.queryKey, data)
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
      queryClient.setQueryData(query.queryKey, data)
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
    },
  }
}
