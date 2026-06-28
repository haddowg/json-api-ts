/**
 * @haddowg/json-api-query — TanStack Query bindings.
 *
 * Surface = query/mutation OPTION factories (not pre-bound hooks), so one binding
 * covers React/Vue/Svelte/Solid via `@tanstack/query-core`. Plus a deterministic
 * query-key factory and the bespoke `type:id` normalization glue (Strategy 2,
 * write-through patching — ADR 0003).
 *
 * Shipped (Build 1): the deterministic key factory (`keyFor` + hierarchical prefixes) and
 * the read option factories (collection list, single get, relationship-linkage + related
 * collection) — standalone (`listQueryOptions(client, type, query)`) or bound
 * (`createQueryApi(client).<type>.list(query)`), each yielding `{ queryKey, queryFn }`.
 *
 * Shipped (Build 2): the bespoke `type:id` write-through normalization (ADR 0003) —
 * `normalize(queryClient, result, descriptor)` indexes every resource in a result and patches
 * every overlapping cached query IN PLACE (preserving edge-local $pivot/$edge), writing back ONLY
 * the queries that actually changed (so untouched queries keep their `isInvalidated` flags), plus
 * `installNormalization(queryClient, descriptor)` to auto-run it on every query/mutation success.
 * A QueryClient holds ONE descriptor (enforced by `installNormalization`): the patch matches by
 * `type:id` alone, so two descriptors sharing a QueryClient would cross-contaminate attributes —
 * give each typed client/server its own QueryClient.
 *
 * Shipped (Build 3): the mutation OPTION factories over the client write surface — create /
 * update / delete, the relationship mutations (add/remove/replace/set), each standalone
 * (`updateMutationOptions(queryClient, client, descriptor, type, id)`) or bound
 * (`createMutationApi(queryClient, client, descriptor).<type>.id(id).update()`). They wire the
 * PATCH-vs-INVALIDATE split (ADR 0003): an update / relationship set/replace patches via
 * `normalize` on success (no refetch); a create / delete invalidates the type's collection lists
 * (+ the deleted resource's reads); a relationship add/remove/set/replace invalidates only the
 * PARENT's relation reads for that `(id, rel)` — never the type's collection lists. Optimistic
 * updates (`{ optimistic: true }` on `update`) pre-apply the patch's attributes through the
 * normalized patch and roll back on error (compare-and-swap, so a concurrent optimistic patch on
 * the same resource is not stomped by an earlier one's rollback).
 */
export * from './install'
export * from './keys'
export * from './mutate'
export * from './normalize'
export * from './read'
