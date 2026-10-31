# The TanStack cache is normalised by patching cached results in place by `type:id`

TanStack Query caches per query key, and JSON:API's `type` and `id` on every resource allow normalisation with no configuration, which a generic library such as normy can't assume. So `json-api-query` keeps TanStack's results denormalised, which keeps its devtools, SSR and structural sharing working, indexes every resource by `type:id`, and patches each cached query holding a changed resource in place. A normalised store as the source of truth, denormalised on read, handles overlapping and late queries better but fights TanStack's model and is much more machinery, so it stays the upgrade path.

## Consequences

A patch only updates existing resources, and preserves edge-local `$pivot` and `$edge`. A create or delete changes collection membership, so it invalidates, or optimistically edits, the affected list and relationship queries instead.
