# Generating the client

The typed client is generated, not hand-written. `@haddowg/json-api-codegen`
reads the OpenAPI 3.1 document your `haddowg/json-api`-powered API serves and
emits a single TypeScript module — a runtime descriptor, per-type attribute
types, and a descriptor-bound `createClient`. This page walks the CLI from the
one-line invocation through to wiring the drift gate into CI.

## The one command

Point `--input` at your served (or exported) OpenAPI document and `--output` at
a file in your repo:

```bash
npm install -D @haddowg/json-api-codegen

json-api-codegen \
  --input https://music.example/docs.json \
  --output src/api/music.gen.ts
```

That writes one file — `src/api/music.gen.ts` — which you commit like any other
source. The [getting started](getting-started.md) walkthrough uses exactly this.
To try it without a running API, point `--input` at the committed music-catalog
spec this repo's own clients are generated from and conformance-tested against:
`https://raw.githubusercontent.com/haddowg/json-api-ts/main/packages/codegen/test/fixtures/music-catalog.openapi.json`.

!!! note "Two bin names"
    The package installs both `json-api-codegen` and the short alias `japi`, so
    `japi --input … --output …` is equivalent. The generated output has **no
    runtime tie back to the codegen** — it imports only `@haddowg/json-api-client`
    — so the CLI stays a dev-only dependency.

## Inputs

`--input` is the source spec; `--output` is where the client lands. Both inputs
accept **either a URL or a local file path**, and the parser reads **JSON or
YAML** from either.

| Flag        | Required | What it is                                                                   |
| ----------- | -------- | ---------------------------------------------------------------------------- |
| `--input`   | yes      | OpenAPI 3.1 document — an `http(s)` URL or a local file (`.json`/`.yaml`).    |
| `--output`  | yes      | Output file for the generated client, e.g. `src/api/music.gen.ts`.           |
| `--schemas` | no       | JSON Schema source (URL or path) for the [validation](validation.md) seam.   |
| `--examples` | no      | Also write the operations' worked examples to a sibling module. See [below](#operation-examples). |
| `--server`  | no       | Target server name. Metadata-only — the served document is already per-server. |
| `--check`   | no       | Drift gate — regenerate in memory and fail if the committed output is stale. |

A local spec is convenient for CI (see [below](#drift-checking-in-ci)); a URL is
convenient during development against a running API. Either resolves to the same
generated output for the same spec content.

The CLI prints a `wrote <path>` line for each file it writes. Warnings go to
stderr with a `[json-api-codegen]` prefix, such as a newer contract than it
reads, a relation that collides with a verb, a paginator it can't read, or a
document with no JSON:API resource types at all, which generates an empty client.

The document's `info.x-generator.contract` is a compatibility number the projector
stamps, which moves only when the document's structure does. This codegen reads
contracts 1 to 18. A document with no contract, from a server before
`haddowg/json-api` 1.1.0, is read as it is, and a newer one generates with a warning
that the client may miss what the server added. What each server release added is in
the `haddowg/json-api` changelog.

A few things the codegen reads from the document that affect the generated client:

- **Links** are typed loosely: the client reads `href` from a link object and accepts
  a plain string too.
- **Relation paths** use the relation's URI field name, which can differ from its name
  (`/articles/{id}/published-by` for `publisher`). The codegen finds each relation's
  endpoints by operationId (`fetchRelated.articles.publisher`) and records the segment
  as the relation's `uriField`, which the client puts in the path.
- **Wrapped `$ref`s.** A `$ref` that carries an `example`, `examples` or `default` is
  written as a single-entry `allOf`. The codegen reads it as the `$ref` it holds, so an
  enum attribute is still typed `status: ArticleStatus`, and the wrapper's description,
  example and default become TSDoc on the member.
- **Raw media types.** An action that answers in media types other than JSON:API gets
  each one recorded as `rawOutput`, read as `binary` for a `format: binary` schema,
  `text` for any other string schema and `json` otherwise. A JSON schema is typed under
  its component's name (`ArticleSummary`) or, when inline, under
  `<Type><Action><MediaType>Output`. An action that accepts several request bodies gets
  them as `inputMedia`, read the same way, and a multipart entry becomes a `FormData`
  body. See [raw responses and request media types](custom-actions.md#raw-responses).
- **Action docs.** An action's summary and description become the JSDoc of its method.
  The projector's stand-in text for an action its author didn't describe ("Invoke the
  `report` action") is left out. When the document carries worked examples, the method
  shows one as an `@example`: the request body when the action takes one, otherwise its
  first success response, pretty-printed under a title such as "Request body" or
  "Response `200` as `text/csv`". A body longer than 80 lines is named but not shown;
  the [examples module](#operation-examples) still has it. The CRUD and relationship
  methods come from the generic runtime, so their examples are only in the examples
  module.
- **Several methods.** Each method of a multi-method action gets its own action method,
  as described under [several methods](custom-actions.md#an-action-with-several-methods).
  An action's `x-safety` flags go into the descriptor as `readOnly`, `destructive` and
  `idempotent`, and its JSDoc says which ones it declares. An action's own vendor
  extensions, such as `x-workflows`, are left out.
- **OAuth scopes** an operation lists in its `security` under the server's `oauth2`
  scheme (found by `type`, whatever it's named) go into the descriptor: per type in
  `scopes`, keyed by operation, on each action as `scopes`, and on the `atomic` const.
  The JSDoc of the descriptor's `paths` entries, relations, actions and `atomic` names
  them too, so a hover on `resourceMap.articles.relations.author` lists what each of its
  endpoints needs.
- **Polymorphic relations.** A relation whose linkage is a union is marked
  `polymorphic: true` whatever its member count, so a `MorphTo` over a single type is
  polymorphic too. Its related and relationship endpoints don't advertise the related
  type's `filter`, `sort` and `page` parameters.
- **Location documents.** An action that answers with a URL, such as a short-lived
  download link, is marked `location: { mediaType }` and, when the URL is all it answers
  with, `output: "location"`. The client then returns the URL instead of fetching it, as
  described under [actions that answer with a URL](custom-actions.md#actions-that-answer-with-a-url).
  An action that only documents a `303` has no `location`, and the transport follows the
  redirect.

### The validation schemas

Add `--schemas` to also read the server's JSON Schema bundle and emit a sibling
module carrying a per-type schema map — the fuel for the client's opt-in
[validation](validation.md) seam:

```bash
json-api-codegen \
  --input https://music.example/docs.json \
  --output src/api/music.gen.ts \
  --schemas https://music.example/schemas.json
```

The schema artifact path is **derived from `--output`**: a `.gen.ts` suffix
becomes `.schemas.gen.ts` (so the example above also writes
`src/api/music.schemas.gen.ts`), a plain `.ts` becomes `.schemas.ts`. Omit
`--schemas` and no schema module is written — validation is entirely optional.

### Operation examples

Add `--examples` to also write the worked examples the document declares
to a sibling module, named the way the schema module is: `music.gen.ts` gets
`music.examples.gen.ts`. It exports `examples`, typed as the client's
`ApiExamples`, for a consumer that wants each operation's sample without reading
the OpenAPI document, such as a tool that describes every operation:

```ts
import { examples } from './api/music.examples.gen'

examples.albums?.operations?.create?.request?.['application/vnd.api+json']
examples.albums?.operations?.['fetchRelated.tracks']?.responses?.['200']
examples.albums?.actions?.reissue?.request
```

Each type has `operations`, keyed by the operation's `operationId` without the
type (`fetchCollection`, `fetchOne`, `create`, `update`, `delete`, and
`fetchRelated.<relation>`, `fetchRelationship.<relation>`,
`updateRelationship.<relation>`, `addRelationship.<relation>`,
`removeRelationship.<relation>`), and `actions`, keyed by action name. Each entry
has a `request` and `responses` keyed by status, and each of those maps a media
type to its example. A body is the whole wire document, not the flat input or
materialised result the client works with. Error responses are shared components
in the document rather than per operation, so they are left out.

Anything without an example is left out: a type, an operation, a request or a
status. A document with no examples writes no module and warns that it has none. The module is off by
default because it is several times the size of the client and an app that only
calls the API has no use for it.

### Multiple servers

The backend serves **one document per server** (a `default` and an `admin` server
typically differ in their type set and path prefix). Generate one client per
server by pointing `--input` at each server's document, writing each to its own
`--output`. The `--server` flag is metadata-only — it does not slice a combined
document; you select the server by choosing the right input URL.

## What it generates

The codegen only *reads* the spec — the spec is fully self-describing for the
runtime's needs, and all the real machinery lives in the generic
`@haddowg/json-api-client`. The emitted module exports:

- **`resourceMap`** — the runtime `ApiDescriptor`, emitted `as const satisfies
  ApiDescriptor`. This is the [descriptor](concepts.md) the generic runtime is
  parameterised by.
- **`ResourceMap`** — `typeof resourceMap`.
- **`createClient(options)`** — the descriptor-bound factory. The descriptor and
  the server's `atomic` capability are baked in; you supply only `ClientOptions`
  (`baseUrl`, `transport?`, `headers?`, …).
- **`Attributes` / `WriteAttributes`** — the per-type attribute maps (read vs
  create/update), plus the per-type `…Attributes` / `…CreateAttributes` /
  `…UpdateAttributes` interfaces, enum unions (e.g. `AlbumStatus`), and per-action
  input/output aliases.
- **`Links`** — each type that declares links, mapped to its `…Links` interface. See
  [below](#declared-links).
- **`ErrorCode` / `ErrorCodeByStatus` / `hasErrorCode`** — the server's documented
  error codes and a type guard bound to them. See [below](#error-codes).
- **`pageLimits`** — each collection's page defaults and caps. See
  [below](#page-defaults-and-caps).

With `--schemas`, the sibling module exports `schemas` — the per-type JSON Schema
2020-12 map. With `--examples`, another exports `examples`, each operation's
worked examples.

```ts
import { createClient, type ResourceMap, resourceMap } from './api/music.gen'
import { schemas } from './api/music.schemas.gen'

const client = createClient({ baseUrl: 'https://music.example' })
```

### Attribute types

Each attribute interface is generated from its own schema: `…Attributes` from the
response schema, `…CreateAttributes` and `…UpdateAttributes` from the request
bodies. The server can state different rules for each, so the three can differ.

A read attribute is `| null` exactly when the response schema admits `null`. That is any attribute the server doesn't guarantee a value
for, such as an optional field a create left out. Required fields, and fields the
server marks as always filled, stay non-null:

```ts
export interface TracksAttributes {
  /** @minLength 1 */
  title: string
  /** @minimum 1 */
  trackNumber: number
  /**
   * @minItems 1
   * @uniqueItems
   */
  genres: [string, ...string[]]
  previewOffset: string | null
}
```

A nullable enum (`anyOf` of the enum and `null`) becomes `AlbumStatus | null`.

An enum alias takes its component's name. When that name isn't a usable TypeScript type
name (it has spaces or punctuation, starts with a digit, is a reserved word, or clashes
with another name in the module), the codegen derives one from it, such as `ReleaseState`
for `release state`, and prints a warning naming both.

A nested object follows the same rules member by member. A
response schema lists every member the server always renders in the object's
`required`, so on reads those members lose their `?` and only nullability is left
to decide. Write interfaces keep the request body's own `required`:

```ts
// read
packaging: { material: string; gatefold: boolean | null } | null
// create
packaging?: { material: string; gatefold?: boolean } | null
```

Every constraint the schema declares becomes a TSDoc tag on the member, so it shows
on hover: `@format`, `@pattern`, `@minLength`/`@maxLength`,
`@minimum`/`@maximum`, `@exclusiveMinimum`/`@exclusiveMaximum`, `@multipleOf`,
`@minItems`/`@maxItems`, `@uniqueItems`, `@minProperties`/`@maxProperties`, plus
`@defaultValue`, `@example` and `@deprecated`. The tags document the rule; the
client doesn't enforce them (use [validation](validation.md) for that). One
constraint changes the type: an array with `minItems` of 1 or more is a non-empty
tuple, `[T, ...T[]]`, on reads and writes alike, so a create can't send an empty
list the server would reject.

### Write-only relations

A write-only relation is one the create and update bodies accept but no response
renders. The codegen marks it `writeOnly: true` in the descriptor. It's found by the
`writeOnly: true` keyword on its body property or, in an older
document, by being in the write bodies and missing from the response schema.

The client keeps it settable on `create`, `update` and atomic operations, and its
relationship accessor keeps the mutation verbs the endpoint offers. It has no slot on
the read view, isn't a `fields` member, and its accessor has no `.get()` or
`.related()`:

```ts
await client.articles.create({ title: 'Draft', reviewer: { type: 'people', id: '3' } })
await client.articles.id('1').reviewer.set({ type: 'people', id: '4' })

const article = await client.articles.get('1')
article.reviewer // type error: not on the read view
```

### Pivot fields

A `belongsToMany` relation describes its `meta.pivot` twice in the descriptor:
`readPivot` for what a response renders and `writePivot` for what a request sends.
Each holds the field hints, the fields that are always there (`required`, absent
when every field is) and the fields that may be `null`:

```ts
orderedTracks: {
  cardinality: "many", types: ["tracks"], pivot: true,
  readPivot: {
    fields: { addedAt: "date-time", position: "integer", weight: "integer" },
    nullable: ["weight"],
  },
  writePivot: {
    fields: { position: "integer", weight: "integer" },
    required: ["position"],
  },
  // …
}
```

They come from the `<Type><Rel>Pivot` and `<Type><Rel>WritePivot`
components, so a read-only field such as `addedAt` is on reads and never asked for
on writes. That types `$pivot` like this:

```ts
// read: a member of .related(), .get() or an included relation
$pivot?: { readonly addedAt: string; readonly position: number; readonly weight: number | null }
// write: .add(), .replace(), create and update
$pivot?: { readonly position: number; readonly weight?: number }
```

An older document has one shared pivot schema. The codegen treats every field as
rendered on reads, and drops the fields marked `readOnly` from writes.

### Declared links

A server can declare named links on a type, such as a signed upload URL with the
method, headers and expiry to use. The document lists each one under the type's
`<Type>ResourceLinks`, which extends the shared
`ResourceLinks` through an `allOf`, and the codegen emits a `…Links` interface for every
type that declares any:

```ts
export interface ImagesLinks extends ResourceLinks {
  /** Where to fetch the original file. */
  download?: {
    href: string
    title: "Original"
    type: "image/png"
    meta: {
      /** The HTTP method to use. */
      method: "GET"
      /** When the URL stops working. */
      expiresAt: string
      headers?: Record<string, unknown> | null
    }
  }
  /** The `thumbnail` link, absent when it does not apply to the resource. */
  thumbnail?: string
}

export interface Links {
  images: ImagesLinks
}
```

Every declared link is optional, because the server leaves a link out when it doesn't
apply. A link with meta or static members is a link object: `href`, each static member
as its literal, and `meta` typed member by member the way attributes are, with each
member's description and example as TSDoc. `meta` is optional unless one of its members
is always rendered, and a member that can be hidden is optional inside it. A link with
neither is a bare URL string. Meta values pass through as the wire sends them, so a
`date-time` member is an ISO `string`.

`createClient` passes `Links` to the runtime, so `$links` on a resource of that type is
typed without a cast:

```ts
const image = await client.images.get('img-1')

image.$links?.download?.href           // string
image.$links?.download?.meta.expiresAt // string
image.$links?.thumbnail                // string | undefined
image.$links?.['other']                // unknown: undeclared links stay reachable
```

`self` and any link the type doesn't declare keep the loose `ResourceLinks` types, and
a type that declares no links isn't in `Links` and keeps `ResourceLinks` as it was. If
you spell out a result type by hand, pass `WithLinks<Attributes, Links>` where you would
pass `Attributes`, or `$links` falls back to `ResourceLinks`
([ADR 0012](https://github.com/haddowg/json-api-ts/blob/main/docs/adr/0012-declared-links-ride-the-attributes-type-argument.md)).

### Page defaults and caps

Each page member states its `default` and the page-size
cap as a `maximum`. The codegen collects them per collection, keyed by wire key and,
for a [strategy menu](pagination.md#choosing-a-strategy-multipaginator), by arm:

```ts
export const pageLimits = {
  albums: {
    number: { default: 1, minimum: 1 },
    size: { default: 15, minimum: 1, maximum: 50 },
  },
  tracks: {
    page: { number: { default: 1, minimum: 1 }, size: { default: 15, minimum: 1, maximum: 50 } },
    cursor: { size: { default: 15, minimum: 1, maximum: 50 } },
    offset: { offset: { default: 0, minimum: 0 }, limit: { default: 15, minimum: 1, maximum: 50 } },
  },
} as const
```

The client sends the `page` you pass as it is and never clamps it. Read
`pageLimits` when you need the numbers, for example to bound a page-size picker. A
collection whose page schema states none of them is left out.

### Error codes

A `haddowg/json-api` document catalogues the error codes the server can send. Each
`components.schemas.ErrorDocument<NNN>` offers its codes as `anyOf` branches, one
`<Code>Error` component per code with a `code` const, plus the open generic `Error`.
The codegen reads them into four exports:

```ts
export const ErrorCodes = {
  /** The credential is valid but lacks permission. */
  ACCESS_DENIED: "ACCESS_DENIED",
  RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
  // …
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

export interface ErrorCodeByStatus {
  403: "ACCESS_DENIED"
  404: "RESOURCE_NOT_FOUND"
  500: never
}

export const hasErrorCode = hasErrorCodeRuntime as ErrorCodeGuard<ErrorCode>
```

- `ErrorCodes` has a key for every code any error document lists, sorted, each
  holding its own code. A key gets TSDoc when its component has a `description`,
  plus an `@example` for each `example`/`examples` value on
  the component's `detail` property. An older document has neither, so its keys
  carry no TSDoc. A code that isn't a valid identifier gets a quoted key.
- `ErrorCode` is the union of those codes, derived from `ErrorCodes`. The TSDoc
  lives on the object because editors show it on hover and in completion for an
  object key, but not for a member of a string literal union.
- `ErrorCodeByStatus` maps each status that has an `ErrorDocument<NNN>` to its
  codes. A status whose document offers only the generic `Error` maps to `never`.
- `hasErrorCode` only accepts an `ErrorCode`, so a misspelt code fails to compile.
  See [errors](errors.md#match-on-an-error-code) for using it.

The bound `createClient` passes `ErrorCode` to the runtime, so the client type
carries it too. A document with no error catalogue gets an empty `ErrorCodes` and
`ErrorCode = string`, and the guard then takes any code.

### Inside the descriptor

Each wire type in `resourceMap` carries a compact `ResourceDescriptor`. Here is
the `albums` entry from the [example client](../examples/spotify-clone/src/generated/music-catalog.gen.ts),
lightly trimmed:

```ts
export const resourceMap = {
  albums: {
    attributes: { title: "string", releasedAt: "date-time", status: "string", /* … */ },
    relations: {
      artist: { cardinality: "one", types: ["artists"], pivot: false, mutations: { set: true } },
      tracks: {
        cardinality: "many", types: ["tracks"], pivot: false,
        mutations: { add: true, remove: true, replace: true },
        countable: { tokens: ["_self_", "playlists"], profile: "…/countable/" },
      },
    },
    paths: {
      fetchMany: "/albums", fetchOne: "/albums/{id}", create: "/albums",
      update: "/albums/{id}", delete: "/albums/{id}",
      fetchRelated: "/albums/{id}/{rel}", fetchRelationship: "/albums/{id}/relationships/{rel}",
    },
    paginator: "page",
    clientId: "forbidden",
    includable: ["artist", "artist.albums", "tracks", "tracks.album", "tracks.playlists"],
    sortable: ["title", "-title", "releasedAt", "-releasedAt", "status", "-status"],
    filterable: ["artist.name", "q", "rating", /* … */],
  },
  // …
} as const satisfies ApiDescriptor
```

Every field is derived from the spec. Where the server stamps a vendor extension
(`x-profile`, `x-paginator`) the codegen reads it; otherwise it works from the
document's structure:

- **`attributes`** — the read attribute names with a coarse wire-format hint
  (`string` / `number` / `boolean` / `date` / `date-time` / `object`). The
  *precise* per-type interface (e.g. `AlbumsAttributes`) is emitted alongside and
  wired onto the client through the `Attributes` map.
- **`relations`** — per relation: `cardinality` (`one`/`many`), the related
  `types` array, whether it is a `pivot` (`belongsToMany`) relation (with its
  [`readPivot` and `writePivot`](#pivot-fields)), whether it is
  [`writeOnly`](#write-only-relations), its `uriField` when its paths use a
  segment other than its name, `polymorphic: true` when its linkage is a union of
  types, even of one (read `isPolymorphic(relation)`, which falls back to counting
  `types` in an older descriptor), and the derived `mutations` capability (`add`/`remove`/`replace` for
  a to-many, `set` for a to-one — read from the relationship endpoint's HTTP
  methods). A relation whose related or relationship endpoint is suppressed by the
  API is marked `related: false` / `relationship: false` so the client gates it
  off rather than offering a call that 404s. A relation may also carry its own
  `countable` and a divergent `paginator`.
- **`paths`** — only the per-operation paths that actually exist
  (`fetchMany`/`fetchOne`/`create`/`update`/`delete`/`fetchRelated`/`fetchRelationship`).
  A read-only type simply has no `create`/`update`/`delete`.
- **`paginator`** — how the collection paginates, read from its `page` query
  parameter:
    - When the page schema carries `x-paginator`, the stamp
      decides the strategy (`page`, `offset`, `cursor` or `fixed`) and the wire key
      for each of its roles. With the default keys the descriptor holds the bare
      kind (`"page"`); with renamed keys it holds
      `{ strategy: "page", keys: { number: "p", size: "size" } }`.
    - A `MultiPaginator` stamps `{ strategy: "multi", default }` on a `oneOf` of
      arms. The descriptor becomes a menu,
      `{ strategy: "multi", default: "page", arms: { page: "page", cursor: "cursor" } }`,
      keyed by each arm's `kind` const. An arm without its own stamp is inferred
      from its member names; an arm nothing recognises is left out with a warning.
    - Without a stamp (an older document, or a custom paginator that stamps
      nothing) the codegen infers the strategy from canonical member names, in
      either the `page` object parameter or the flattened `page[number]` form:
      `number`+`size` is `page`, `offset`+`limit` is `offset`, `after` or `before`
      is `cursor`, `number` alone is `fixed`. Renamed keys can't be inferred.
    - Anything unrecognised, including a strategy this codegen doesn't know, logs a
      warning and generates as `none`.

    See [pagination](pagination.md) for the typed `page` argument and `$page` this
    drives.
- **`clientId`** — the create client-id policy: `forbidden` / `optional` /
  `required`, read from the create-request schema. See [writes](writes.md).
- **`includable` / `sortable` / `filterable`** — the bounded, pre-expanded token
  sets the collection read accepts (`?include` paths incl. nested dotted forms;
  signed sort fields; `filter[…]` keys). These drive typed narrowing on the read
  surface — see [includes and sparse fieldsets](includes-and-sparse-fieldsets.md)
  and [filtering and sorting](filtering-and-sorting.md).
- **`countable`** — the collection's `withCount` tokens and the negotiation
  profile URI (read from the parameter's `x-profile`, never hardcoded).
- **`actions`** — custom actions keyed by name, each carrying `scope`
  (`resource`/`collection`), `path`, `input` (`document`/`none`/`raw`) and
  `output` (`document`/`meta`/`location`/`none`), plus an `inputType`/`outputType` where the
  action names a resource, and a `location` when it answers with a URL. A `document` action gets emitted `…Input`/`…Output`
  type aliases. See [custom actions](custom-actions.md). An action needing OAuth
  scopes carries them as `scopes`.
- **`scopes`** — the OAuth scopes each operation needs, keyed by the operation id
  without its type (`fetchOne`, `fetchRelated.author`, `addRelationship.tags`). Absent when no operation of the type needs one.

The server-level Atomic Operations capability is emitted separately as an
`atomic` const and threaded into `createClient` by default — see
[atomic operations](atomic-operations.md).

??? note "Going deeper: verb/relation collisions"
    If a type has a relation named like a reserved verb on the resource handle
    (`get`, `update`, `delete`, `create`, `list`, `actions`, `rel`, …), the
    codegen emits a **build-time warning** and that relation routes through
    `.rel('name')` in the fluent client instead of a bare accessor. The common
    case — relations that do not shadow a verb — stays clean. The warning names
    the type and relation so you know which one moved.

??? note "Going deeper: the programmatic API"
    The same generation is callable from a script — useful for a build step or a
    custom regeneration harness:

    ```ts
    import { generate, generateFiles, check, type CodegenConfig } from '@haddowg/json-api-codegen'

    const config: CodegenConfig = {
      input: 'https://music.example/docs.json',
      output: 'src/api/music.gen.ts',
      schemas: 'https://music.example/schemas.json', // optional
      examples: true,                                // optional
      server: 'default',                             // optional, metadata-only
    }

    await generate(config)                 // writes the file(s); returns the client source
    await generateFiles(config)            // the same, returning the paths it wrote
    const { ok } = await check(config)     // drift gate: regenerate in memory, compare, no write
    ```

    Lower-level building blocks are exported too — `readDocument` / `readSchemas`,
    `buildDescriptor`, `buildExamples` / `operationExamples`, `emit` / `emitSchemas` /
    `emitExamples`, `readErrorCatalogue` / `emitErrorCodes`, `detectVerbCollisions`,
    `schemasOutputPath` / `examplesOutputPath`, the provenance helpers
    `deriveProvenance` / `provenanceLines` / `hashJson`, and `checkContract` with
    `MINIMUM_CONTRACT` / `MAXIMUM_CONTRACT`, which throws for a document older than
    the codegen reads and returns a warning for a newer one.

## Provenance and drift

### The provenance stamp

Every generated artifact carries a provenance record in its header — the source
spec identifier (`<info.title> <info.version>`), the first declared server URL,
and a stable 16-hex content hash of the source document:

```ts
/**
 * AUTO-GENERATED by @haddowg/json-api-codegen — do not edit by hand.
 * Regenerate from the source OpenAPI document instead.
 *
 * Source spec: Music Catalog API 1.0.0
 * Server:      https://music.example
 * Spec hash:   c73c5d49624ebbe8
 */
```

The stamp is **timestamp-free and deterministic** — the hash is taken over the
canonicalised document (object keys sorted), so two byte-different-but-equivalent
specs hash the same, and regenerating from the same spec yields byte-identical
output. That determinism is what makes the header a reliable review anchor (which
spec produced this committed client?) and what lets the drift gate compare output
byte-for-byte.

### Committing and regenerating

**Commit the generated files.** Like `openapi-typescript` or `graphql-codegen`,
the output is one small, reviewable, diffable, versioned module in your repo — not
a published package. Regenerate whenever the API changes and commit the diff; a PR
then shows exactly how the wire contract moved.

### Drift checking (`--check`)

`--check` regenerates every artifact **in memory** and compares it against the
committed `--output` (and its schema and examples siblings when `--schemas` and
`--examples` are set) **without
writing anything**. It prints a per-artifact `ok`/`DRIFT` line and exits non-zero
if any committed file is missing or out of date:

```bash
json-api-codegen \
  --input spec/music-catalog.openapi.json \
  --output src/api/music.gen.ts \
  --schemas spec/music-catalog.schemas.json \
  --check
```

Pin `--input` to a **committed spec fixture** so the check is deterministic in CI:
a drifted generated client — someone edited the spec fixture but forgot to
regenerate, or hand-edited the output — fails the build with a clear message
telling them to regenerate and commit.

## Drift-checking in CI

This repo drift-checks all of its own generated clients from a single committed
spec fixture, and it is a good template. [`scripts/codegen.mjs`](../scripts/codegen.mjs)
runs the CLI once per output, threading `--check` through when invoked with the
flag:

```bash
pnpm codegen         # regenerate every client from the committed spec fixture
pnpm codegen:check   # the CI gate — fail if any committed client is stale
```

Those two scripts are wired in the root [`package.json`](https://github.com/haddowg/json-api-ts/blob/main/package.json) as
`node scripts/codegen.mjs` and `node scripts/codegen.mjs --check`. In your own
project, `codegen:check` belongs in the same CI job as your lint/typecheck step —
so a stale client can never merge.

!!! tip "One source keeps the examples honest"
    In this repo the same fixture generates the test snapshot in the codegen
    package **and** both example clients, so all three stay pinned to one wire
    contract. Your app typically has just one output per server, but the pattern
    is the same: one committed spec in, drift-checked clients out.

## See it in the example app

- [`scripts/codegen.mjs`](../scripts/codegen.mjs) — the regenerate / drift-check
  harness this repo runs (`pnpm codegen` / `pnpm codegen:check`).
- [`music-catalog.client.gen.ts`](../packages/codegen/test/generated/music-catalog.client.gen.ts)
  — the committed snapshot of a full generated client, header, interfaces,
  descriptor and factory.
- [`music-catalog.gen.ts`](../examples/spotify-clone/src/generated/music-catalog.gen.ts)
  — the generated client the spotify-clone app actually imports and uses.

## Next

- [Concepts](concepts.md) — the descriptor and how the generic runtime consumes it.
- [Reads](reads.md) — the typed read surface the descriptor unlocks.
- [Validation](validation.md) — wiring the `--schemas` output into the opt-in seam.
