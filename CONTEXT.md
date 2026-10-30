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
  type (follow `$ref` → identifier → `type.const`); a nested `anyOf` = polymorphic, even
  with one member (contract 16).
- `?include` paths are handed to us literally and **pre-expanded** as a bounded enum
  per endpoint (`tracks.album`, `tracks.playlists`, …) — so include-driven type
  inference is a union over a finite set, not open recursion.
- `x-` extensions present today: `x-enum-varnames`, `x-enum-descriptions`, and
  `x-profile` (on a parameter — advertises the required profile a client must negotiate,
  e.g. the Countable profile carried by a `withCount` param).

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
- **Action media types** (generator contract 10, ADR 0010): an action answering in raw media
  types beside or instead of JSON:API carries `rawOutput` in the descriptor, and its method takes
  `{ accept }`, typed as the media types it declares. JSON:API stays the default whenever the
  action declares it; an action answering only in raw media types defaults to the first. The
  result is typed per media type: `string` for text, `Blob` for binary (`ArrayBuffer` with
  `responseType: 'arrayBuffer'`), the schema's generated type for JSON. An action listing several
  request media types (generator contract 11) carries `inputMedia` and takes `{ contentType }`,
  with the body typed by the picked type; a declared wildcard such as `image/*` takes any `image/…`.
  A multipart or URL-encoded body whose schema lists `properties` is also typed as a plain field
  object, which the client encodes into `FormData` or `URLSearchParams`. Array items go out as
  repeated `name[]` entries, the form PHP servers read as a list, matching the PHP client. A
  ready `FormData` or `URLSearchParams` is still taken as is. Errors stay
  `JsonApiError` whatever was asked for. An author's summary and description become the action's
  JSDoc; the projector's stand-in prose for an undescribed action is left out.
- **Operation examples** (generator contract 12, ADR 0011): an action's JSDoc carries an
  `@example` of its request body, else its first success response, as the pretty-printed wire
  document; one over 80 lines is named but not shown. Every operation's examples go to an opt-in
  sibling module (`--examples`, `<output>.examples.gen.ts`) exporting `examples: ApiExamples`,
  keyed type → `operations` (the `operationId` without the type) or `actions` (by name) →
  `request` / `responses[status]` → media type. They stay out of `resourceMap`, which every app
  ships to the browser.
- **Error detail examples** (generator contract 13): every core error code's component carries a
  `detail` example, which becomes an `@example` on its `ErrorCodes` key. Contract 13 is on every
  document, since the error components are shared by all of them.
- **Declared links** (generator contract 14, ADR 0012): a type's named links in its
  `<Type>ResourceLinks` become a `<Type>Links` interface extending the loose `ResourceLinks`, each
  link optional; a link object types `href`, its static members as literals and its `meta` like
  attributes, a bare link is a `string`. The generated `Links` map is `createClient`'s sixth type
  argument, folded into the attributes argument under a `$declaredLinks` key (`WithLinks<A, L>`) so
  `$links` is typed and the query and Angular bindings need no change.
- **Multi-method actions and action safety** (generator contract 15, ADR 0013): an action
  answering to several methods has one operation id per method. The preferred method (`POST`,
  else the first advertised) keeps the action's name, and each other method is keyed
  `<name><Method>`, or `<name>-<method>` when the name uses dashes (underscores likewise). A
  document whose methods share one id still gives only the preferred one. An action's `x-safety`
  becomes optional `readOnly`, `destructive` and `idempotent` on its `ActionDescriptor`, absent
  when undeclared, and a sentence in its JSDoc.
- **Operation scopes and one-type polymorphic relations** (generator contract 16, ADR 0016):
  the scopes an operation's `security` lists under an `oauth2` scheme go into the descriptor as
  optional string lists: `ResourceDescriptor.scopes` keyed like the examples module
  (`fetchOne`, `fetchRelated.<rel>`), `ActionDescriptor.scopes` and `AtomicDescriptor.scopes`,
  each absent when none is needed, and a sentence in the JSDoc. A relation whose linkage is an
  `anyOf` union, even of one member, carries `polymorphic: true`; `isPolymorphic()` reads it and
  falls back to more than one type for an older descriptor.
- **Actions that answer with a URL** (generator contract 17, ADR 0018): a `200` location
  document, an `allOf` of `LocationDocument` fixing `links.location.type`, marks the action
  `location: { mediaType }`, with `output: 'location'` when that is all it answers with. Its
  method returns an `ActionLocation`, `{ url, type, expiresAt? }`, read from `links.location`,
  and never follows the URL. `expiresAt` stays an ISO string, as every date does. An action
  whose `200` is a `oneOf` of its own document and a location document returns either, told
  apart by the document's shape at runtime and by `isActionLocation()` in the caller. An action
  documenting only a `303` is unchanged: the transport follows it.
- **Shared links components** (generator contract 18): the document has one links component
  per context instead of one per type and relation. A type with declared or action links keeps
  `<Type>ResourceLinks` as an `allOf` of the shared `ResourceLinks` and its named links, which
  the codegen reads; the others point at `ResourceLinks` and have no typed links. Link schemas
  carry no examples, so a declared link's JSDoc has none either.
- **Every `POST` sends the JSON:API `Content-Type`**, bodyless included, because core 1.11
  answers `415` without it. `PATCH`, `PUT` and `DELETE` send it only with a body.

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
  factories + normalization glue) · `@haddowg/json-api-angular` (signal-based Angular
  bindings over an `HttpClient` transport; see below) · `@haddowg/json-api-mcp` (MCP tools
  built at runtime from the document and descriptor; see below).

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
  patch** (apply expected change immediately, roll back on error). An `update` patches a
  node's attributes; a relationship `add`/`remove`/`replace`/`set` (opt in with
  `optimistic: true`) patches the parent's cached related/relationship reads **by key
  prefix** — every page variant at once, snapshot + auto-rollback — via the public
  `relationReadKeys(type, id, rel)` helper (both `(parent, relation)` prefixes), so apps
  never reconstruct keys by hand or couple to the page params a read used.

### Angular bindings (signals, not RxJS)

ADR 0006. `@haddowg/json-api-angular` is signal-based. RxJS stays at the edges
(`toObservable()` on a signal, `from()` on a client call).

- **`httpClientTransport(http)`** is the default transport there, so app interceptors run.
  A non-2xx response resolves for the client to map to `JsonApiError`; only a status-0
  failure rejects. Aborting `req.signal` unsubscribes, which cancels the request.
- **DI:** `provideJsonApiClient(createClient, options, token?)` → `EnvironmentProviders`;
  one token per server (`createJsonApiClientToken<T>()`); `injectJsonApiClient(token?)`.
  The default client is typed by augmenting the package's `Register` interface.
- **Reads:** `jsonApiResource()` wraps Angular's `resource()` (params `undefined` = idle;
  the loader gets client + params + abort signal). It is the only module that imports
  `resource()`, which is experimental before Angular 22. `nextPage`/`prevPage` read `page`
  params off a collection's links; `loadAll` walks `next` links.
- **Writes:** `jsonApiMutation()` → `{ mutate, isPending, error, value, reset }`.
- **No shared cache:** callers `reload()` what a write affects. A later cache would be
  TanStack's Angular adapter or a small signal store keyed by `type:id`.

### MCP tools (definitions and a handler, not a server)

ADRs 0014, 0015, 0020 and 0021. `@haddowg/json-api-mcp` builds one MCP tool per collection, resource,
related and custom action operation. It returns tool definitions and a call handler; the host
owns the MCP server. It's generic: scopes are opaque, and vendor extensions such as
`x-feature` reach the host's hooks untouched.

- **Generated model:** a build-time generator (`@haddowg/json-api-mcp/generate` and the
  `json-api-mcp` CLI, ESM only) reads the OpenAPI document, builds the descriptor with the
  codegen and writes one JSON model: the tools, each tool's call plan, the descriptor the
  client calls through, the document's contract and content hash. The host commits it and
  checks it with `--check`. The runtime entry takes the parsed model, is dual ESM and
  CommonJS, loads only the client, and throws on a model format or contract it can't read.
- **Names** come from the `operationId`: `<type>_list`, `_get`, `_create`, `_update`,
  `_delete`, `<type>_<relation>_list|get`, `<type>_<action>`, plus `_<method>` for an action
  with several methods. A kebab-case type becomes `snake_case`. A name over 64 characters,
  with a character outside letters, digits, `_` and `-`, or shared fails the build
  (`ToolNameError`).
- **Inputs are portable:** valid under OpenAI's strict function calling and Anthropic's strict
  tool use. Every property is required and the API's optional ones are nullable, so `null`
  means "not given"; an update's `clear` names the fields to null. No `oneOf`/`if`/`then`.
- **Outputs** (ADR 0021) are a JSON:API-like envelope: `{ data, meta? }` for one resource (get,
  create, update, to-one related, an action returning one), `{ data, links, meta? }` for a
  collection with only the pagination links, `{ data: null, meta? }` for a delete and `{ meta }`
  for a meta-only action. Resources flatten to `{ id, type, ...attributes, relation: id | ids,
links? }`, the related resource in place of the id when included. `pageLink` is followed only
  on the tool's own base URL and path. A list on an endpoint that counts itself under the
  Countable profile takes `withCount`, sent as `withCount=_self_`.
- **Resource links** (ADR 0020): a flattened resource keeps the links its type names, declared
  and action links, under `links`, each `{ href, type?, title?, meta? }` with a bare URL
  normalised to `{ href }`. `self`, `related` and `describedby` are dropped, as is resource
  meta. The generator fails on a type that names links and has a field called `links`.
- **Per caller:** `forRequest({ grantedScopes, context })` filters by the operation's
  `security` through `scopeMatcher`, then `capabilities`, then `includeOperation`;
  `decorateTool`, `requestInit` and `mapError` are the other hooks. They're public API.
- **Credential schemes** (ADR 0017): the scope filter counts a security requirement only when
  every scheme it names is one the MCP caller authenticates with. The model records the
  document's `oauth2` schemes as `credentialSchemes` (format 2), and the host's
  `credentialSchemes` option overrides them. A requirement naming another scheme, such as a
  session cookie, is ignored; an operation with security but no requirement left is dropped,
  and an empty or `{}` alternative stays public. With no `oauth2` scheme every requirement
  counts, as before. A format 1 model is read with the schemes it lists scopes under.
- **Safety:** an action's declared `readOnly`, `destructive` and `idempotent` become its
  annotations, read from its descriptor entry and its `x-safety`, the latter winning. Every
  method of a multi-method action is its own tool, suffixed with the method, and calls the
  descriptor entry at its path and method. CRUD hints come from the kind; a delete is
  destructive and idempotent.
- **Polymorphic relations:** a relation `isPolymorphic()` takes and returns `{ type, id }`,
  even over one type, so adding a second type doesn't change a tool's input. Every other
  relation takes a bare id. Each operation carries the descriptor's `scopes` for its hooks,
  read at load time.
- **URLs:** an action that answers with a URL returns `{ data: { url, type, expiresAt? } }` as
  structured content, and its `outputSchema` describes it, or an `anyOf` of it and the action's
  usual envelope when it answers with either. The tool never fetches the URL.
- **Include depth** (ADR 0019): the generator caps `include` at a depth, 1 by default,
  `null` (`--include-depth all`) for every declared path. A tool's `include` is an enum of the
  declared paths within it, absent when there are none, and its `$defs` cover only the types
  those paths reach. The runtime refuses any other path before calling the API and flattens a
  related resource deeper than the cap to its id.
- **Model format 3:** records `includeDepth`, stores an operation's own `security` once and the
  document's at the top level, and drops `scopes`, which the runtime reads from the descriptor.
  Hooks see the operation object with its `security` as before. Formats 1 and 2 still load,
  with no include cap.
- **Model format 4:** records `resourceLinks`, each type's named links, and output schemas for
  the envelope. A format 1 to 3 model still loads and gets the 1.2 result shapes its schemas
  describe: `{ item }`, `{ items, links, meta }`, a bare resource, meta or URL, and a delete as
  text.
- **Contract:** reads 13 to 18 and throws outside it. Contract 18 only moves the links
  components, and no tool schema copies them.

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
  `(req:{method,url,headers,body?,rawBody?,responseType?,signal?}) => Promise<{status,headers,body,binary?}>`;
  default is a `fetch` adapter. `body` stays a string; only a custom action's non-JSON:API
  traffic uses `rawBody` and `responseType`/`binary` (ADR 0010). `createClient({ baseUrl, transport?, headers?: ()=>HeadersInit|Promise,
onError?, onResponse? })` — async `headers` provider for per-request bearer auth; a
  _small_ hook pair, not a full interceptor stack. Runtime owns content negotiation
  (`application/vnd.api+json`, atomic `ext` media type). **Retries are out of core** (the
  transport / TanStack handle them).
- Non-2xx → **throw a typed `JsonApiError`** (matches TanStack + `try/catch`): carries
  `status` + `errors: JsonApiErrorObject[]` ({status,code,title,detail,source,meta}).
- **Typed error codes** (ADR 0009): the codegen emits `ErrorCodes` (a const object, one
  TSDoc'd key per code the document's `ErrorDocument*` schemas list), the `ErrorCode` union
  derived from it and `ErrorCodeByStatus`, plus a `hasErrorCode` guard bound to
  `ErrorCode`. `JsonApiError<C = string>` types `code` as `C | (string & {})`; the catalogue is
  open, so an undocumented code still fits and the runtime's unbound `hasErrorCode` matches it.
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

### Commits, merges and releases

release-please files each commit on `main` under the packages whose files it changed
(ADR 0008), so how a PR lands decides which changelogs its entries reach.

- A PR that changes one package is **squash-merged**, titled as a Conventional Commit.
- A PR that changes several packages is **rebase-merged** (`gh pr merge --rebase`), with
  each commit a Conventional Commit scoped to one package (`feat(client): …`,
  `feat(angular): …`). Fold fixups in before merging; the branch's history becomes
  `main`'s. It needs no `BEGIN_COMMIT_OVERRIDE` block.
- The pre-commit hook typechecks only the workspaces a commit touches, so the client half
  of a change can be committed before the Angular half compiles against it. CI's full
  `pnpm typecheck` gates the merge.

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
