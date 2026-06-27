/**
 * @haddowg/json-api-query — TanStack Query bindings.
 *
 * Surface = query/mutation OPTION factories (not pre-bound hooks), so one binding
 * covers React/Vue/Svelte/Solid via `@tanstack/query-core`. Plus a deterministic
 * query-key factory and the bespoke `type:id` normalization glue (Strategy 2,
 * write-through patching — ADR 0003).
 *
 * TODO (build order):
 *  - queryKeys(type, op, id?, rel?, params): deterministic key factory
 *  - queryOptions / mutationOptions factories over the client's fluent surface
 *  - normalize(response): index resources by type:id and patch overlapping queries
 *    in place, preserving edge-local $pivot/$edge
 *  - patch-vs-invalidate split: updates patch; create/delete invalidate list queries
 *  - optimistic updates routed through the normalized patch
 */
export {}
