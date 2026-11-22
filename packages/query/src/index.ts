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
 * related + relationship reads (every page/param variant, infinite pages included) and to the
 * relation's slot on every cached copy of the parent, and rolls back on error; the settle
 * invalidation still reconciles against the server. The public key helper `relationReadKeys(type,
 * id, rel)` (both `(parent, relation)` prefixes) lets an app target those caches without
 * reconstructing keys by hand.
 *
 * Every optimistic change goes through an optimistic draft (`openDraft`): a typed transaction over
 * the normalised cache that places members only where they fit, marks what it touched
 * (`$optimistic`, `$pending(rel)`, an adjusted `$count`), and rolls back compare-and-swap. An
 * optimistic create is completed for the lists it targets, and kept as a pending entry
 * (`list.$pending()`, merged in place by `withPending`) where it still can't fit.
 */
export {
  type DeferredMembers,
  type DraftMember,
  type DraftOptions,
  type DraftParams,
  type DraftQuery,
  type DraftRef,
  type InsertInto,
  type InsertOptions,
  type Into,
  type ListDraftQuery,
  openDraft,
  type OptimisticDraft,
  type Placement,
  type PlaceOptions,
  type RelatedTypeName,
  type RelationDraftQuery,
  type RelationInto,
  type ResourceDraftQuery,
} from './draft'
export { installNormalization, jsonApiShouldDehydrateQuery, type Teardown } from './install'
export {
  infiniteKeyFor,
  INFINITE_SEGMENT,
  isScopeSegment,
  type KeyTarget,
  keyFor,
  keyHasPrefix,
  type NormalizedParams,
  normalizeParams,
  operationKey,
  parentRelationReadKeys,
  type QueryKey,
  type QueryKeyPart,
  type ReadOperation,
  relationKey,
  relationReadKeys,
  resourceKey,
  scopedKey,
  type ScopeSegment,
  scopeOf,
  scopeSegment,
  singletonRelationReadKeys,
  SKIPPED_SEGMENT,
  type SkippedSegment,
  typeKey,
} from './keys'
export {
  addRelationshipMutationOptions,
  atomicMutationOptions,
  createMutationApi,
  createMutationOptions,
  deleteMutationOptions,
  type AttachTo,
  type CreateMutationOpts,
  type CreateCompletion,
  type CreateOptimisticOption,
  type DeleteByIdVariables,
  type DeleteMutationArgs,
  type DeleteMutationOpts,
  type HandleMutationApi,
  jsonApiMutationOptions,
  type JsonApiMutationConfig,
  type MutationApi,
  type MutationError,
  type MutationMeta,
  type MutationMetaOption,
  type MutationRetry,
  type MutationOptions,
  type RelationMutationApi,
  type RelationshipMutationOpts,
  removeRelationshipMutationOptions,
  type ServerOnly,
  replaceRelationshipMutationOptions,
  setRelationshipMutationOptions,
  type SingletonMutationApi,
  type TypeMutationApi,
  updateMutationOptions,
  type UpdateMutationOpts,
  type UpdateByIdVariables,
  type UpdateVariables,
  type WriteMutationOpts,
} from './mutate'
export {
  JsonApiMutationCache,
  type JsonApiMutationCacheConfig,
  type OptimisticDefaults,
} from './mutation-cache'
export { type ScopeOption, withScope } from './scope'
export { type PendingCreateOf, type PendingList, type PendingPages, withPending } from './pending'
export { normalize } from './normalize'
export {
  createQueryApi,
  type FetchOneResult,
  getQueryOptions,
  type InfiniteListQueryApi,
  infiniteListQueryOptions,
  type InfiniteQueryFn,
  type InfiniteQueryFnContext,
  type InfiniteQueryOptions,
  type InfiniteReadOptions,
  infiniteRelatedQueryOptions,
  jsonApiRetry,
  type ListPageParam,
  type ListResult,
  listQueryOptions,
  type PaginatedRelationName,
  type PaginatedTypeName,
  type QueryApi,
  type QueryFnContext,
  type QueryOptions,
  type ReadError,
  type ReadFailure,
  type ReadGuardError,
  type ReadOptions,
  type ReadQueryFn,
  type ReadRetry,
  type RelatedPageParam,
  relatedQueryOptions,
  relationshipQueryOptions,
  type ResourceId,
  type SingletonQueryApi,
  type SkippableInfiniteQueryOptions,
  type SkippableQueryOptions,
  type ToManyRelationName,
  type TypeQueryApi,
  type TypeReadQueryApi,
} from './read'
export {
  ATOMIC_MUTATION_KEY,
  type AttachTarget,
  CUSTOM_MUTATION_KEY,
  JSON_API_PLAN,
  type JsonApiAtomicPlan,
  type JsonApiCustomPlan,
  type JsonApiMutationKey,
  type JsonApiMutationMeta,
  type JsonApiMutationPlan,
  type JsonApiMutationVerb,
  type JsonApiResourcePlan,
  type JsonApiResourceVerb,
  mutationKeyFor,
  type MutationDraft,
  type OptimisticFn,
  type OptimisticOption,
  type MutationKeyTarget,
} from './upkeep'
