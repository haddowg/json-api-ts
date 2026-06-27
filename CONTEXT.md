# json-api-ts — Context

A TypeScript monorepo that generates a JSON:API-flavored, fully typesafe client from
the OpenAPI 3.1 spec emitted by the `haddowg/json-api-symfony` bundle.

**Source of truth at design time** is that OpenAPI spec. It has been grounded against
the live `music-catalog-symfony` example (56 paths, 175 schemas, default + admin
servers). Key facts the codegen relies on:

- Type identity is machine-readable: every `<Type>Resource`/`<Type>ResourceIdentifier`
  carries `properties.type.const`.
- Relationships are fully derivable from structure (no extension): enumerate
  `<Type>Resource.properties.relationships.properties`; the relationship component's
  `data` gives cardinality (array = to-many; `anyOf [..,null]` = to-one) and related
  type (follow `$ref` → identifier → `type.const`); a nested `anyOf` = polymorphic.
- `?include` paths are handed to us literally and **pre-expanded** as a bounded enum
  per endpoint (`tracks.album`, `tracks.playlists`, …) — so include-driven type
  inference is a union over a finite set, not open recursion.
- Only `x-` extensions present today: `x-enum-varnames`, `x-enum-descriptions`.

## Glossary

- **ResourceMap** — the generated type mapping each JSON:API `type` string → its
  resource shape (attributes, relationships with cardinality + related type, id
  format). The single generated artifact the generic runtime is parameterized by.
- **Resource object** — the runtime value for one resource. Data is flattened: `type`,
  `id`, attributes, and hydrated/identifier relations are own **enumerable** props
  (clean spread/serialize). Envelope is exposed via non-enumerable `$`-accessors.
- **Hydration** — stitching a response's `included` into relationship slots. Included
  relations become nested resource objects; non-included relations are
  `Identifier | undefined` (absent is valid). The static return type is computed from
  the `include` argument.
- **Identifier** — `{ type, id }` resource identifier; the shape a non-included but
  linked relation takes.
- **Augmented array** — a real `T[]` carrying non-enumerable envelope accessors
  (`$page`, `$links`, `$meta`, `$next()/$prev()`). Used for top-level collections,
  related-endpoint collections, **and** hydrated/linkage to-many relationship values.
- **$page** — normalized pagination, discriminated by paginator kind
  (page/offset/cursor), count-free-safe (navigation via link presence; `total`
  optional).
- **$pivot** — per-edge `belongsToMany` pivot data (`meta.pivot` on the member),
  typed, attached to each member of a pivot to-many array; **edge-local** (never on
  the normalized node).
- **Edge** — a relationship instance between two resources; carries its own
  links/meta (and pivot/pagination for a to-many).

## Resolved decisions

### Return model — hydrated graph, type computed from `include`

A read returns a self-contained nested graph built from the response's `included`.
Included relations are hydrated nested resource objects; non-included are
`Identifier | undefined` (absent is valid). The return type is conditional on the
`include` argument. The returned shape is decoupled from the global cache.

### Resource object shape

- Data flattened as own **enumerable** props: `type`, `id`, attributes, and
  hydrated/identifier relations. `{...res}` / `JSON.stringify(res)` are clean.
- Envelope via non-enumerable, `$`-prefixed accessors (collision-proof — `$` is
  forbidden in JSON:API member names; `type`/`id` are spec-reserved so they stay
  plain props):
  - `$meta` (getter) — resource-level meta
  - `$links` (getter) — resource-level links; `$self` (getter) shorthand
  - `$document` (getter) — **shared, by-reference**, trimmed top-level
    `{ jsonapi, meta, links }` (identical identity for every resource from one
    response)
  - `$edge` (getter, on every materialized related value) — the relationship-instance
    envelope for _this_ resource within its parent relationship, distinct from the
    resource's own `$links`/`$meta`. To-one: `{ links:{self,related}, meta }`.
    To-many member: `{ meta:{ served_by, pivot, … } }` (relationship-level links/meta
    live on the array). Removes the need to go via the parent's `$rel` for to-ones.
  - `$pivot` (getter, on pivot to-many members) — typed sugar over `$edge.meta.pivot`
  - `$rel(name)` (fn, on the parent) — narrowed to two residual jobs: **links-only**
    relations (no `data`, so no value/array to carry `$edge`) and uniform
    introspection. Returns `{ data, links, meta }`.
  - `$raw` (getter) — original JSON:API resource object (escape hatch)
  - convention: zero-arg = getters, parameterized = functions

### To-many relationship values are augmented arrays

`playlist.tracks` is a `Track[]` (hydrated) or `Identifier[]` (linkage-only) carrying
`$page/$links/$meta/$next()` directly (relationship-level envelope). Each member also
carries its own `$edge` (identifier-level edge meta) and `$pivot`. To-one edge data
rides the value's `$edge`.

### Materialized related values are per-edge views

A to-one value / to-many member is a distinct wrapper **per membership**: it reads
through to the normalized node for attribute data but carries its own edge-local
`$edge`/`$pivot` (the same Track in two playlists has different pivot). Consequence:
**identity is by `type:id`, never object reference** — `playlist.tracks[0]` is not
reference-equal to the same track fetched standalone.

### Smart (self-navigating) results

Resources and collections hold a non-enumerable transport handle, enabling
`$next()/$prev()`, `$rel().related()`, etc. Data survives serialization; navigation
handles do not (serialize the data, not the handle).

### Write surface — flat input + fluent, id-scoped builder

- **Flat ergonomic input** (the client builds the JSON:API envelope). Create is
  type-implicit (the accessor names the type); relationships supplied as identifiers,
  resource objects (id extracted), `null` (clear to-one), or arrays (to-many). `id` is
  required/optional/forbidden per the spec's per-type policy (`id:false` / in
  `required` / optional).
- **Fluent tree:**
  - type accessor (collection-scoped): `.list(q)`, `.get(id,opts)` shorthand,
    `.create(input)`, `.actions.<name>(input)`.
  - `.id(id)` → resource **handle** (no fetch): `.get(opts)`, `.update(patch)`,
    `.delete()`, `.actions.<name>(input)`, and relationship accessors by name.
  - relationship accessor: to-many `.add/.remove/.replace([…])`; to-one `.set(ref|null)`;
    reads `.get(q)` (linkage) / `.related(q)` (related collection).
- Verb/relationship collision: **plain verbs + codegen collision-detection** — if a type
  has a relation named like a reserved verb (`get`/`update`/`delete`/`actions`/…), that
  type's relations route through `.rel('name')` with a build-time warning; the common
  case stays clean.
- Smart `$`-methods on fetched results (`playlist.tracks.$add(…)`) remain as sugar
  delegating to the fluent path.
- **Pivot writes** ride the member: `.replace([{ ...trackRef, $pivot:{ position:1 } }])`
  (writable pivot fields only; readOnly excluded).
- Create/update **return** the resource (hydrated per an optional `include`/`fields` on
  the write); delete → `void`.

### Atomic — typed transaction builder, type-in-object

`client.atomic(tx => { … })`. Since `tx` isn't type-scoped, the object carries `type`
(the TS discriminant): `tx.create({ type, …fields })`, `tx.update({ type, id, …fields })`,
`tx.delete({type,id} | ref)`. `tx.create(...)` returns a handle that **doubles as a
`lid`-bearing relationship ref**, so just-created resources wire into later ops without
an id. Results typed positionally. Uses the atomic ext media type.

### Pagination — one model, three surfaces

Top-level collection, related-endpoint collection, and to-many relationship arrays all
expose the same `$page` + `$next()/$prev()`. Count-free default → navigate by link
presence; `total` only when the response carries it.

### Codegen contract & packages

- Generated artifact is a **runtime descriptor object with types derived from it** (one
  source): `export const resourceMap = {…} as const; export type Api = ApiFor<typeof
resourceMap>; export const createClient = …`. The descriptor carries what the runtime
  needs — attribute vs relation, cardinality, related type, per-operation paths
  (`uriType`/prefix-aware), paginator kind, attribute formats — plus generated TS
  interfaces for precise attribute types.
- **Output committed into the user's repo** (one file / small dir), à la
  `openapi-typescript`/`graphql-codegen` — reviewable, diffable, versioned. Not a
  published package.
- **One typed client per server** (the spec is per-server; `default`/`admin` differ in
  type-set and path prefix).
- Config `japi.config.ts`: `{ input: url|file, output, server?, validation?, … }`.
- **Value coercion: pass-through by default** — wire dates stay ISO `string`, decimals
  `number` (serializable, no tz surprises); optional coercion hook (e.g. dates → `Date`)
  enabled by the descriptor's attribute formats.
- **Packages:** `@haddowg/json-api-client` (generic runtime, parameterised by the
  descriptor; transport iface + `fetch` impl, de/serialise, materialise, optional
  normalized index) · `@haddowg/json-api-codegen` (CLI: OpenAPI + schemas → descriptor +
  types + bound `createClient`) · `@haddowg/json-api-query` (TanStack option/key
  factories + normalization glue) · `@haddowg/json-api-angular` (later, optional RxJS).

### Cache & normalization (TanStack layer)

- **Core client is framework-agnostic and standalone** (`await client.albums.list()`
  works with no TanStack). `json-api-query` is an **optional** binding that adds caching
  - normalization. Surface = query/mutation **option factories** (not pre-bound hooks),
    so one surface covers React/Vue/Svelte/Solid via `query-core`.
- **Normalization = Strategy 2 (write-through patching), bespoke, dep-free.** TanStack
  keeps denormalized results; on each success we index every resource (`data` +
  `included`) by `type:id → query keys`, and a resource change **patches every cached
  query containing that `type:id` in place** ("edit once, updates everywhere"). Patching
  replaces a node's _attributes_ (codegen knows attributes vs relations) while
  **preserving edge-local `$pivot`/`$edge`**. (Strategy 1 — normalized source of truth +
  denormalize-on-read — is the documented upgrade path, deliberately not built now.)
- **Patch vs invalidate split:** updates to existing resources → silent normalized patch
  (no refetch); creates/deletes change collection membership → **invalidate (or
  optimistically insert/remove from) the relevant list/relationship queries.**
- Deterministic **query-key factory** from `(type, operation, id?, rel?, normalized
params)` — drives cache hits and targeted invalidation.
- Mutations: option factories with **optimistic updates done through the normalized
  patch** (apply expected change immediately, roll back on error).

### Dependency policy (supersedes "zero runtime deps")

Not a hard zero-dep rule. Runtime deps must be **minimal, shallow-dependency-tree, and
either tiny or very actively/well-maintained** — the goal is avoiding npm supply-chain
exposure and bundle bloat, not dogmatic zero. A heavy or deep-tree dep is rejected; a
small well-kept one is acceptable when it earns its place.

### Validation posture — C (zero-ish-dep default + opt-in seam), graceful

Core runtime does only **light structural guards** (is this a JSON:API document? does
`data` carry `type`+`id`?) and otherwise trusts the wire (we own both ends; the
envelope is invariant). Full per-field validation is **opt-in** via a pluggable
`validate?` seam fed by the bundle's JSON Schemas; the validation _engine_ (ajv or
similar) is brought by the user / an optional adapter, never in the core dep tree.
Missing-include is **graceful**: leave the relation as an identifier (+ dev-mode warn),
never throw at the boundary.

### Codegen input sources

The codegen reads from **a URL or a local file** for both inputs:

- the **OpenAPI 3.1 document** → types + the thin endpoint map (always);
- the **JSON Schema bundle** (new bundle endpoint, below) → the opt-in validation seam.

### Transport seam & error model

- **Transport** is a tiny `fetch`-shaped function (not a class):
  `(req:{method,url,headers,body?}) => Promise<{status,headers,body}>`; default is a
  `fetch` adapter. `createClient({ baseUrl, transport?, headers?: ()=>HeadersInit|Promise,
onError?, onResponse? })` — async `headers` provider for per-request bearer auth; a
  _small_ hook pair, not a full interceptor stack. Runtime owns content negotiation
  (`application/vnd.api+json`, atomic `ext` media type). **Retries are out of core** (the
  transport / TanStack handle them).
- Non-2xx → **throw a typed `JsonApiError`** (matches TanStack + `try/catch`): carries
  `status` + `errors: JsonApiErrorObject[]` ({status,code,title,detail,source,meta}).
- **Expressive status matchers:** `hasStatus(n)`, `is4xx()`, `is5xx()`,
  `isBadRequest()`/400, `isUnauthorized()`/401, `isForbidden()`/403, `isNotFound()`/404,
  `isNotAcceptable()`/406, `isConflict()`/409, `isUnsupportedMediaType()`/415,
  `isUnprocessable()` (a.k.a. `isValidationError()`)/422, `isRateLimited()`/429 —
  keyed off the HTTP status.
- **Pointer remapping:** because the client builds the envelope from flat input, each
  error's raw `source.pointer` (`/data/attributes/title`, `/data/relationships/artist/data`,
  `/data/attributes/releaseInfo/label`, `/data/relationships/orderedTracks/data/0/meta/pivot/position`)
  is remapped to the **user's flat path** (`title`, `artist`, `releaseInfo.label`,
  `orderedTracks[0].$pivot.position`). `byPath()` groups errors by user path for forms;
  raw `source.pointer` stays on each error as an escape hatch. Descriptor-aware
  (knows attribute/relation/map/pivot nesting). Query-side errors use `source.parameter`
  (e.g. `filter[x]`) and are left as-is (already user-facing). [atomic pointers carry an
  op-index prefix — remap to `(opIndex, path)`.]

### Toolchain (Vite+'s tools, wired directly — not the alpha `vp` wrapper)

Rationale: Vite+ is ~0.2.x alpha (breaking changes in patch releases); a published
library needs reproducible builds, so use the mature underlying tools directly now and
migrate to `vp` once it's ≥1.0 (trivial — same tools).

- **pnpm** workspaces (PM + monorepo)
- **Turborepo** (cached task runner — `vp run`'s mature stand-in)
- **tsdown** (rolldown-based bundler: dual ESM/CJS + `.d.ts`)
- **Vitest** (test)
- **oxlint** + **oxfmt** (lint/format; both oxc) — `oxfmt` is `0.x` but actively
  maintained by the oxc team; **Biome** is the fallback if it ever bites
- **tsc** (typecheck)
- **release-please** (manifest mode + `node-workspace` plugin), matching
  `json-api`/`json-api-symfony` — one release model across the lineage
- CI: PR check (install → lint/format/typecheck → test → build) + Release
  (release-please → build → `npm publish --provenance`, gating on v4's path-prefixed
  `release_created` outputs)

## Bundle-side enrichment required (running list)

- **Typed `$pivot`** — the bundle must emit pivot field types (cleanest: type the
  linkage identifier's `meta.pivot` as proper OAS; no `x-` extension). Covers read and
  the write linkage meta (`position` is writable).
- **Serve the JSON Schemas over HTTP**, alongside the OpenAPI docs and behind the same
  expose gate / warmer / artifact-store pattern. Reuses the existing
  `JsonSchemaFactory` (today only the `json-api:json-schema:export` CLI). Per server.
  Proposed: an aggregate `GET /schemas.json` (map keyed by type) plus optional
  per-type `GET /schemas/{type}.json`. Validation targets per-type **resource-object**
  schemas (validate each object in `data`/`included` by its `type`; the envelope is
  invariant and not worth validating).
