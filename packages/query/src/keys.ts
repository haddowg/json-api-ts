/**
 * The deterministic query-key factory (CONTEXT.md "Cache & normalization (TanStack layer)").
 *
 * A key is a stable, hierarchical readonly tuple `[type, operation, ...id?, ...rel?, params?]`.
 * The hierarchy is the contract the normalization layer + targeted invalidation lean on: a
 * prefix of a key matches every key beneath it (TanStack's `queryKey` matching is prefix-based),
 * so `[type]` invalidates a whole type's subtree, `[type, operation]` an operation's subtree, and
 * `[type, operation, id]` a single resource's reads. Params ride the LAST segment as a normalised
 * object so two semantically-equal queries (keys reordered, equal values) share one key.
 */

/** The read operations a key can address (mirrors the client's per-operation path templates). */
export type ReadOperation = 'fetchMany' | 'fetchOne' | 'fetchRelated' | 'fetchRelationship'

/**
 * A normalised query-parameter value: JSON-ish, with object keys sorted recursively so equal
 * params produce an identical (deeply-equal, stably-ordered) value regardless of authoring order.
 */
export type NormalizedParams =
  | string
  | number
  | boolean
  | null
  | readonly NormalizedParams[]
  | { readonly [key: string]: NormalizedParams }

/** One segment of a query key: the type/operation/id/rel strings, or the trailing params object. */
export type QueryKeyPart = string | { readonly [key: string]: NormalizedParams }

/** A query key: the stable readonly tuple TanStack stores results under. */
export type QueryKey = readonly QueryKeyPart[]

/**
 * Recursively normalise a params value so semantically-equal params serialise identically:
 * object keys are sorted; arrays keep order (order is meaningful in a list — `sort`, `include`);
 * `undefined` members are dropped (an absent param == an unset one). Primitives pass through.
 * Not JSON.stringify — the key stays a structured tuple so TanStack's structural matching and
 * the devtools see real values, not an opaque string.
 */
export function normalizeParams(value: unknown): NormalizedParams {
  if (value === null || value === undefined) {
    return null
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeParams(v))
  }
  if (typeof value === 'object') {
    const out: Record<string, NormalizedParams> = {}
    // `Object.keys` returns a fresh array; sorting it in place is safe (no shared array is
    // mutated) — and `Array#toSorted` is ES2023, outside the ES2022 lib this package targets.
    // oxlint-disable-next-line no-array-sort
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const member = (value as Record<string, unknown>)[key]
      if (member !== undefined) {
        out[key] = normalizeParams(member)
      }
    }
    return out
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  // Anything else (function, symbol, bigint) is not a legitimate query param; coerce to string so
  // the key stays serialisable rather than throwing at the cache boundary.
  return String(value)
}

/** The addressing of a key, before params: type + operation, plus the id/rel an op needs. */
export interface KeyTarget {
  type: string
  operation: ReadOperation
  /** Present for resource-scoped ops (`fetchOne`/`fetchRelated`/`fetchRelationship`). */
  id?: string
  /** Present for relation ops (`fetchRelated`/`fetchRelationship`). */
  rel?: string
}

/**
 * Build a deterministic, hierarchical query key from `(type, operation, id?, rel?, params?)`.
 * The fixed-position prefix (`type`, `operation`, then `id`, then `rel`) makes any ancestor a
 * valid invalidation target; params (when present and non-empty) ride a single trailing
 * normalised object so reorderings collapse to one key. An absent/empty params object adds no
 * trailing segment, so a bare `list()` and `list({})` share a key.
 */
export function keyFor(target: KeyTarget, params?: unknown): QueryKey {
  const parts: QueryKeyPart[] = [target.type, target.operation]
  if (target.id !== undefined) {
    parts.push(target.id)
  }
  if (target.rel !== undefined) {
    parts.push(target.rel)
  }
  if (params !== undefined) {
    const normalized = normalizeParams(params)
    // Only append a params segment when it carries something — an empty object/array adds no
    // distinguishing information, so dropping it unifies `list()` with `list({})`.
    if (!isEmptyNormalized(normalized)) {
      parts.push(normalized as { readonly [key: string]: NormalizedParams })
    }
  }
  return parts
}

/** True when a normalised params value carries no information (an empty object or array, or null). */
function isEmptyNormalized(value: NormalizedParams): boolean {
  if (value === null) {
    return true
  }
  if (Array.isArray(value)) {
    return value.length === 0
  }
  if (typeof value === 'object') {
    return Object.keys(value).length === 0
  }
  return false
}

// ── Hierarchical prefixes (targeted invalidation) ─────────────────────────────────────────

/** The whole-type subtree prefix (`[type]`) — invalidates every operation/read of a type. */
export function typeKey(type: string): readonly [string] {
  return [type]
}

/** An operation subtree prefix (`[type, operation]`) — e.g. every `fetchMany` (list) of a type. */
export function operationKey(type: string, operation: ReadOperation): readonly [string, string] {
  return [type, operation]
}

/**
 * A single-resource subtree prefix (`[type, 'fetchOne', id]`) — matches that resource's reads.
 * Pairs with {@link keyFor} (which places `id` at the same position), so it is a true prefix of
 * every `fetchOne` key for the id regardless of its query params.
 */
export function resourceKey(type: string, id: string): readonly [string, string, string] {
  return [type, 'fetchOne', id]
}

/**
 * A single-relation read prefix (`[type, operation, id, rel]`) for `fetchRelated` /
 * `fetchRelationship` — matches one parent's reads of one relation, regardless of query params.
 * Pairs with {@link keyFor} (which places `id` then `rel` at fixed positions), so it is a true
 * prefix of every related/relationship key for that `(id, rel)`. Used for TARGETED invalidation of
 * a parent's relation after a relationship mutation (never the type's collection lists — ADR 0003).
 */
export function relationKey(
  type: string,
  operation: 'fetchRelated' | 'fetchRelationship',
  id: string,
  rel: string,
): readonly [string, string, string, string] {
  return [type, operation, id, rel]
}
