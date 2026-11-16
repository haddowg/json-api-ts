# The TanStack cache is normalised by patching cached results in place by `type:id`

TanStack Query caches per query key, and JSON:API's `type` and `id` on every resource allow normalisation with no configuration, which a generic library such as normy can't assume. So `json-api-query` keeps TanStack's results denormalised, which keeps its devtools, SSR and structural sharing working, indexes every resource by `type:id`, and patches each cached query holding a changed resource in place. A normalised store as the source of truth, denormalised on read, handles overlapping and late queries better but fights TanStack's model and is much more machinery, so it stays the upgrade path.

## Consequences

A patch only updates existing resources, and preserves edge-local `$pivot` and `$edge`. The nodes change in place, but a touched query is published again under a new root reference, a transparent proxy over the same value, set on the query's state directly. React Query's observers compare `data` by reference, so writing the same root back would leave components showing the old values, and `setQueryData` would collapse a copy back to the old root through structural sharing, clear `isInvalidated` and re-run normalisation as a fresh success. A create or delete changes collection membership, so it invalidates, or optimistically edits, the affected list and relationship queries instead.
