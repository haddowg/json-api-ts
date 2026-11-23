/**
 * @haddowg/json-api-query — TanStack Query bindings.
 *
 * Surface = query/mutation OPTION factories (not pre-bound hooks), so one binding
 * covers React/Vue/Svelte/Solid via `@tanstack/query-core`. Plus a deterministic
 * query-key factory and the bespoke `type:id` normalization glue (Strategy 2,
 * write-through patching).
 *
 * Shipped (Build 1): the deterministic key factory (`keyFor` + hierarchical prefixes) and
 * the read option factories (collection list, single get, relationship-linkage + related
 * collection) — standalone (`listQueryOptions(client, type, query)`) or bound
 * (`createQueryApi(client).<type>.list(query)`), each yielding `{ queryKey, queryFn }`. The
 * infinite reads (`infiniteListQueryOptions`, `infiniteRelatedQueryOptions`, or bound
 * `.infinite(query)` / `.relatedInfinite(id, rel, query)`) page a collection through its links.
 *
 * Shipped (Build 2): the bespoke `type:id` write-through normalization —
 * `normalize(queryClient, result, descriptor)` indexes every resource in a result and patches
 * every overlapping cached query IN PLACE (preserving edge-local $pivot/$edge), writing back ONLY
 * the queries that actually changed (so untouched queries keep their `isInvalidated` flags), plus
 * `installNormalization(queryClient, descriptor)` to auto-run it on every query/mutation success.
 * A QueryClient holds ONE descriptor per scope (enforced by `installNormalization`): the patch
 * matches by `type:id` alone, so several servers share a QueryClient by giving each a scope, which
 * leads every key it builds with `{ $scope }` and confines its normalisation and upkeep to them.
 *
 * Shipped (Build 3): the mutation OPTION factories over the client write surface — create /
 * update / delete, the relationship mutations (add/remove/replace/set) and atomic, each standalone
 * (`updateMutationOptions(queryClient, client, descriptor, type, id)`) or bound
 * (`createMutationApi(queryClient, client, descriptor).<type>.id(id).update()`). Each returns
 * `{ mutationKey, mutationFn, meta }`: the key is `[type, verb, id?, rel?]` (`mutationKeyFor`), and
 * `meta.jsonApi` holds a plain-data plan of the write's cache upkeep, which `JsonApiMutationCache`
 * (the QueryClient's mutation cache) runs from its awaited hooks. The factories set no lifecycle
 * callbacks, so an app's own `onMutate`/`onSuccess`/`onError`/`onSettled` never replace the upkeep.
 * The upkeep follows the PATCH-vs-INVALIDATE split: an update / relationship set/replace patches via
 * `normalize` on success (no refetch); a create / delete invalidates the type's collection lists
 * (+ the deleted resource's reads); a relationship add/remove/set/replace invalidates only the
 * PARENT's relation reads for that `(id, rel)` — never the type's collection lists. Optimistic
 * updates (`{ optimistic: true }` on `update`) pre-apply the patch's attributes through the
 * normalized patch and roll back on error (compare-and-swap, so a concurrent optimistic patch on
 * the same resource is not stomped by an earlier one's rollback).
 *
 * Optimistic RELATIONSHIP membership (D35b): `{ optimistic: true }` on a relationship
 * `add`/`remove`/`replace`/`set` pre-applies the membership/linkage change to the parent's cached
 * related + relationship reads BY KEY PREFIX — covering every page/param variant at once (no
 * coupling to the params a page read with) — snapshots them, and rolls back on error; the settle
 * invalidation still reconciles against the server. The public key helper `relationReadKeys(type,
 * id, rel)` (both `(parent, relation)` prefixes) lets an app target those caches without
 * reconstructing keys by hand.
 */
export { installNormalization, jsonApiShouldDehydrateQuery, type Teardown } from './install'
export * from './keys'
export * from './mutate'
export { JsonApiMutationCache } from './mutation-cache'
export { type ScopeOption, withScope } from './scope'
export * from './normalize'
export * from './read'
export {
  ATOMIC_MUTATION_KEY,
  JSON_API_PLAN,
  type JsonApiAtomicPlan,
  type JsonApiMutationKey,
  type JsonApiMutationMeta,
  type JsonApiMutationPlan,
  type JsonApiMutationVerb,
  type JsonApiResourcePlan,
  type JsonApiResourceVerb,
  mutationKeyFor,
  type MutationKeyTarget,
} from './upkeep'
