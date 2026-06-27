# 0003 — Cache normalization is bespoke, dep-free, `type:id` write-through patching (Strategy 2)

- **Status:** Accepted
- **Date:** 2026-06-27

TanStack Query is not a normalized cache — it stores results per query-key. JSON:API's
guarantee that every resource carries `type`+`id` lets us normalize with **zero
configuration** (the concrete reason to be JSON:API-specific rather than use a generic
library like normy). We keep TanStack's results denormalized (so its devtools, SSR, and
structural sharing all just work) and, on every successful response, index each resource
(`data` + `included`) by `type:id → query keys`; when a resource changes we **patch
every cached query that contains that `type:id` in place** — "edit once, updates
everywhere". Patching replaces a node's _attributes_ (the descriptor knows attributes vs
relations) while **preserving edge-local `$pivot`/`$edge`**.

This is Strategy 2 (write-through patching). The alternative, Strategy 1 (a normalized
store as the source of truth with denormalize-on-read), is more powerful for overlaps
and late queries but fights TanStack's model and is materially more machinery; it is the
documented upgrade path, deliberately not built now.

Consequence: node-patching only covers **updates to existing resources**. A create or
delete changes collection membership, which is not a node patch, so those **invalidate
(or optimistically insert/remove from) the relevant list/relationship queries** instead.
The `json-api-client` core remains framework-agnostic and usable standalone; all of this
lives in the optional `json-api-query` binding.
