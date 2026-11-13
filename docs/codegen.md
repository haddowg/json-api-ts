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
To try it without a running API, generate from the music-catalog document this repo's
own clients are generated from and conformance-tested against. The bundle publishes it
as [`@haddowg/json-api-symfony-specs`](https://github.com/haddowg/json-api-symfony/pkgs/npm/json-api-symfony-specs)
on GitHub Packages (installing it needs a token with `read:packages`), and
`php bin/export-specs.php <dir>` in a checkout of
[haddowg/json-api-symfony](https://github.com/haddowg/json-api-symfony) writes the same
files.

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
contracts 24 to 38. An older document is refused, because it describes its error codes in a form
this codegen no longer reads: generate it with an older codegen release. A document with no
contract is read as it is, and a newer one generates with a warning that the client may
miss what the server added. What each server release added is in
the `haddowg/json-api` changelog.

A few things the codegen reads from the document that affect the generated client:

- **Links** are typed loosely: the client reads `href` from a link object and accepts
  a plain string too.
- **Open objects and maps.** An object whose `additionalProperties` is a schema takes
  members it does not declare, each of that schema's type. Its declared members are
  intersected with a `Record` of that type, so a spreadsheet row requiring `Key` is
  `{ Key: string } & Record<string, string>`, and one declaring nothing is just
  `Record<string, string>`. This holds anywhere in the document: a count per status in a
  raw action response is `Record<string, number>`, and a map nested in a list or another map
  is typed the same way. An object open to any member, or one that says nothing about
  undeclared members, stays `Record<string, unknown>`.
- **Unions of primitive types.** A value of several JSON types becomes a TS union of
  each, at the top level, inside an object and as a list's items. A schema listing its
  types, such as `["string", "number", "boolean", "array", "null"]` with string `items`,
  is `string | number | boolean | string[] | null`, and a `oneOf` of one schema per
  member, such as a string enum of `auto` and `off` beside an integer, is
  `"auto" | "off" | number`. An enum keeps its values' own types, so an integer member
  limited to `1` and `2` is `1 | 2`. The descriptor's format hint for such a value is
  `unknown`, since no one type describes it.
- **Named shapes.** A shape the server names as a schema component of its own, such as
  a `PlaceholderValue` union or a `Reviewer` object, becomes one exported type under
  that name, and every member using it refers to the name: inside an object, as a
  list's items and as a union's branch, on reads and writes alike. See
  [Named shapes](#named-shapes).
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
- **Default read order.** A to-many relation that declares the order its members are
  read in when a request names no `sort` publishes it as the `default` of the `sort`
  parameter on its related and relationship reads. The relation's JSDoc names it, for
  example "Without a `sort`, the server reads its members ordered by `position`". The
  client sends nothing for it, since the server applies the order either way.
- **Sort and filter docs.** What each described sort key orders by, read from the `sort`
  parameter's `x-sort-descriptions`, goes into the TSDoc on `sortable`. A sort or filter
  family's description goes on its entry in `sortFamilies` or `filterFamilies`, with a
  filter family's example as an `@example`. A filter's default, the `default` of its
  `filter[<key>]` schema, is named on `filterable`. See
  [filtering and sorting](filtering-and-sorting.md#what-the-descriptor-says-about-filters-and-sorts).
- **A relation's own sorts and filters.** The client types a relation over one type's
  `sort` with that type's collection sorts, and matches its list filters against that
  type's. When the relation's related read, or its relationship read if it has no related
  endpoint, takes other sorts or filters, the codegen records the relation's own on it.
  That covers a sort the relation declares, such as the music catalog's `duration` on
  `albums.tracks`, sorts and filters by pivot fields, and a relation that drops its related
  type's filter defaults. Sorts and filters are compared apart, keys and descriptions and
  defaults included, so a relation that only filters differently records only
  `filterable`, `listFilters` and `filterFamilies`. A relation whose reads take what the
  collection read takes records nothing.
- **Relations whose reads take no sort or no filter.** Every to-one, and any to-many whose
  reads have no `sort` parameter, gets `sortable: []`, polymorphic or not. A relation whose
  reads have no `filter[<key>]` parameter and no filter family gets `filterable: []` the
  same way. The client then types `sort` or `filter` on its `.get()`, `.related()` and
  `relatedQuery` entry as `never`, the way a collection that offers no sorting or filtering
  is typed. A to-one `relatedQuery` entry takes no `sort` whatever the descriptor records. A relation with neither a related nor a relationship read gets both empty
  lists, including a relation of a type that has no endpoints of its own, such as
  `credits.person` in the contract witness.
- **Polymorphic relations.** A relation whose linkage is a union is marked
  `polymorphic: true` whatever its member count, so a `MorphTo` over a single type is
  polymorphic too. Its related and relationship endpoints don't advertise the related
  type's `filter`, `sort` and `page` parameters. A `MorphToMany` identified by its link
  rows can sort and filter those rows by pivot fields, and its reads then advertise their
  own `filter` and `sort`. The codegen records them on the relation as `sortable`,
  `sortFamilies`, `filterable`, `listFilters` and `filterFamilies`, and the client narrows
  `sort` and `filter` on its `.get()` and `.related()` to them. Its identifiers' typed
  `meta.pivot` becomes the relation's `readPivot` and `writePivot`, as on a
  `BelongsToMany`.
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
materialised result the client works with. Error responses are left out, because their
codes reach the client through the [error catalogue](#error-codes).

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
  `…UpdateAttributes` interfaces, enum unions (e.g. `AlbumStatus`), named shapes (e.g.
  `Reviewer`), and per-action input/output aliases.
- **`Links`** — each type that declares links, mapped to its `…Links` interface. See
  [below](#declared-links).
- **`ErrorCode` / `ErrorCodeByStatus` / `ErrorCodeByOperation` / `ErrorMetaByCode` /
  `hasErrorCode` / `findError`** — the server's documented error codes, the codes only some
  operations raise, each code's typed `meta`, and a guard and finder bound to them. See
  [below](#error-codes).
- **`pageLimits` / `relatedPageLimits`** — the page defaults and caps of each
  collection and each related collection. See [below](#page-defaults-and-caps).
- **`pageKinds` / `relatedPageKinds`** — the pagination strategies each collection
  and related collection offers. See [below](#pagination-strategies).

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

Values pass through as the wire carries them: a `date` or `date-time` is an ISO `string`
and a decimal a `number`, with no coercion, so a result serialises and caches unchanged.

An enum alias takes its component's name. When that name isn't a usable TypeScript type
name (it has spaces or punctuation, starts with a digit, is a reserved word, or clashes
with another name in the module), the codegen derives one from it, such as `ReleaseState`
for `release state`, and prints a warning naming both.

### Named shapes

A server can name a shape that several fields share, so it projects once as a schema
component. Each such component becomes one exported type under its name, an interface for
an object and a type alias for anything else, with the component's own description and
constraints as its TSDoc. A shape whose writes differ from its reads also has a
`<Name>Create` and a `<Name>Update` component, and each is its own type. Only the ones the
document references are there.

```ts
/** @maxLength 200 */
export type PlaceholderValue = string | number | boolean

export interface Reviewer {
  /** @minLength 1 */
  name: string
  /** @format date-time */
  reviewedAt: string | null
}

export interface ReviewerCreate {
  /** @minLength 1 */
  name: string
}

export interface ArticlesAttributes {
  /** The value a placeholder takes when nothing is bound. */
  defaultValue: PlaceholderValue
  fallbackValue: PlaceholderValue | null
  reviewedBy: Reviewer | null
}

export interface ArticlesCreateAttributes {
  defaultValue: PlaceholderValue
  fallbackValue?: PlaceholderValue | null
  reviewedBy?: ReviewerCreate
}
```

A use that admits `null` is `<Name> | null`, since the component itself never does. A use's
description, deprecation, example and non-empty keyword stay TSDoc on the member. A required
list keeps its name rather than becoming a non-empty tuple, so `minItems: 1` beside the
reference is only TSDoc. The descriptor's format hint for a named shape is its component's:
`object` for an object and `unknown` for a union.

A shape keeps its component name unless that name is one the generated module already uses
or isn't a usable TypeScript type name. The names the module uses are its own exports and
imports (`Attributes`, `Links`, `Included`, `TypeName` and the rest), each type's
`<Type>Attributes`, `<Type>CreateAttributes`, `<Type>UpdateAttributes` and `<Type>Links`, and
its action input and output aliases. A clash takes a `Shape` suffix, so a component named
`ArticlesLinks` is `ArticlesLinksShape`. A name that isn't a type name is PascalCased first,
`Placeholder.Value` becoming `PlaceholderValue`, and gets the suffix too when another
component already has that name. A name starting with a digit takes `Shape` as a prefix
instead, and a number follows if the result is still taken. The codegen prints a warning
naming both. The result doesn't depend on the order the module reaches the components in,
as long as no two of them derive the same name.

A document older than contract 32 never names a shape, so a `$ref` to a component that isn't
an enum is still typed inline there.

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

A discriminated union (a `oneOf` of objects with a `discriminator`) becomes a union of
its branches, and each branch's discriminator member is the literal its `const` names, so
checking it narrows to that branch. A `oneOf` with no discriminator whose branches are closed
objects tells its branches apart by their members instead, so each branch lists the other
branches' members as `?: never`. A write mixing two branches then fails to compile, as the
server would reject it, and checking a member against `undefined` narrows to its branch:

```ts
shape: { radius: number; width?: never; height?: never } | { width: number; height: number; radius?: never } | null
``` A list attribute types its elements from its `items`
schema, so a list of objects or of a discriminated union keeps the members, `required`
and nullability of each element, with read and write elements following their own
schemas as above:

```ts
// read
steps: ({ operation: "trim" } | { params: { find: string; replace: string } | null; operation: "find_replace" })[] | null
// create and update
steps?: ({ operation: "trim" } | { params?: { find?: string; replace?: string }; operation: "find_replace" })[]
```

A write replaces the whole list, so an update element requires what a create element
does.

Every constraint the schema declares becomes a TSDoc tag on the member, so it shows
on hover: `@format`, `@pattern`, `@minLength`/`@maxLength`,
`@minimum`/`@maximum`, `@exclusiveMinimum`/`@exclusiveMaximum`, `@multipleOf`,
`@minItems`/`@maxItems`, `@uniqueItems`, `@minProperties`/`@maxProperties`, plus
`@defaultValue`, `@example` and `@deprecated`. An `@example` comes from the schema's `examples`
list, one tag per value, or from a singular `example`. The tags document the rule; the
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

### Identifier meta

A relation whose server declares the members it adds to each linkage member's `meta`
publishes them as a `<Type><Rel>IdentifierMeta` component. The codegen reads it into the
relation's `identifierMeta`, in the same shape as `readPivot`:

```ts
members: {
  cardinality: "many", types: ["users"], pivot: true,
  readPivot: { fields: { position: "integer" } },
  identifierMeta: { fields: { primary: "boolean", role: "string" }, nullable: ["primary"] },
  // …
}
```

That types `$edge.meta` on the members of the resource's own relationship and of the
relationship endpoint, beside `pivot` when there is one. The record stays open, since the
related resource's own meta can sit there too:

```ts
const article = await client.articles.get('1')
article.author?.$edge?.meta?.role // string
```

Identifier meta is read-only, so no write takes it, and the related endpoint doesn't render
it: its members are resource objects, not linkage. A polymorphic relation types the meta of
every member the same way.

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
pass `Attributes`, or `$links` falls back to `ResourceLinks`.

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

A related collection, such as `GET /albums/{id}/tracks`, can page differently from the
related type's own collection. `relatedPageLimits` reads each one from its related
endpoint and keys it by parent type, then by relation name. Below that it has the same
shape as `pageLimits`:

```ts
export const relatedPageLimits = {
  albums: {
    tracks: {
      number: { default: 1, minimum: 1 },
      size: { default: 2, minimum: 1, maximum: 100 },
    },
  },
} as const
```

A relation whose related endpoint states no bounds is left out, and so is a parent left
with none. When no related collection states any, it is `{}`.

### Pagination strategies

`pageKinds` lists the strategies each paginated collection offers, keyed by type, and
`relatedPageKinds` does the same for each related collection, keyed by parent type, then
by relation name. A single strategy is a one-entry tuple. A
[strategy menu](pagination.md#choosing-a-strategy-multipaginator) lists the `kind` of
each arm, and the one the server uses when the request names none comes first:

```ts
export const pageKinds = {
  albums: ['page'],
  tracks: ['page', 'cursor', 'offset'],
} as const

export const relatedPageKinds = {
  albums: { tracks: ['page'] },
} as const
```

Every paginated collection is listed, whether or not its members state bounds. The
codegen reads the strategy from the `x-paginator` stamp on the page schema, which names
a single strategy or, for a menu, its default. Every built-in `haddowg/json-api`
paginator stamps it. A collection whose page schema has no stamp, as a custom paginator
may leave it, is left out of both consts, as is a menu whose stamped default isn't one
of its arms.

### Error codes

A `haddowg/json-api` document catalogues the error codes the server can send. Each
`components.schemas.ErrorDocument<NNN>` offers, after the open generic `Error`, the error
*shapes* at that status: components grouping the codes that share a `source` member and a
`meta` declaration, whose `code` is an `anyOf` of one `const` branch per code, each with the
code's `title` and `description`. A code is offered only on the operations that can raise it,
so most operations answer a status with an error document of their own, such as
`ArticlesUpdate409` or `AlbumsFetchOne404`, which offers the shared codes plus its own. A shared
document may offer no specific code, and a server drops it, with its response component such as
`NotFound`, when no operation answers from it. The codegen finds each operation's document
through its response, inline or a response component, so the document's name doesn't matter to
it. Each code's example lives in
`components.examples` under the code. The codegen reads them into these exports:

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

export interface ErrorCodeByOperation {
  "update.articles": "ARTICLE_LOCKED"
}

export interface ErrorMetaByCode {
  INSUFFICIENT_SCOPE: { requiredScopes: [string, ...string[]]; missingScopes: [string, ...string[]]; include?: string }
}

export const hasErrorCode = hasErrorCodeRuntime as ErrorCodeGuard<ErrorCode>
export const findError = findErrorRuntime as ErrorFinder<ErrorCode, ErrorMetaByCode>
```

- `ErrorCodes` has a key for every code any error document lists, sorted, each
  holding its own code. A key's TSDoc carries the code's title and description from its
  branch, and an `@example` of the `detail` in the code's example. A code that isn't a
  valid identifier gets a quoted key.
- `ErrorCode` is the union of those codes, derived from `ErrorCodes`. The TSDoc
  lives on the object because editors show it on hover and in completion for an
  object key, but not for a member of a string literal union.
- `ErrorCodeByStatus` maps each status that has an `ErrorDocument<NNN>`, or that some
  operation answers with a document of its own, to its codes, including the codes only some
  operations raise at it. A status whose documents offer only the generic `Error` maps to
  `never`.
- `ErrorCodeByOperation` maps each operation id with an error document of its own to the codes
  it adds to the ones every operation raises: the document's codes less the shared
  `ErrorDocument<NNN>` ones, or all of them where the status has no shared document. The generated client exports no type per operation document, so a
  server renaming one changes nothing a client imports.
- `ErrorMetaByCode` types the `meta` each code declares. A code whose `meta` is optional
  types as `… | undefined`.
- `hasErrorCode` only accepts an `ErrorCode`, so a misspelt code fails to compile, and
  `findError` returns the first error carrying a code with its `meta` typed. See
  [errors](errors.md#match-on-an-error-code) for using them.

The bound `createClient` passes `ErrorCode` to the runtime, so the client type
carries it too. A document with no error catalogue gets an empty `ErrorCodes` and
`ErrorCode = string`, and the guard then takes any code.

### Deprecation

The server can mark a type, an operation, an action, an attribute, a relation, a filter, a
sort key or a sort family deprecated. A deprecated thing keeps working, so the client still
types and sends it. The codegen turns each marker into TSDoc, and where the client surface
reaches the tagged entry, your editor strikes the name through:

- An attribute marked `deprecated` gets `@deprecated` on its member in `…Attributes`,
  `…CreateAttributes` and `…UpdateAttributes`, at any depth. The read view's attribute is
  struck through.
- A relation marked deprecated in the read resource or a write body gets `@deprecated` on its
  entry in `resourceMap`, so `client.articles.id('1').formerAuthor` is struck through.
- A deprecated action gets `@deprecated` on its `actions` entry, so
  `client.articles.id('1').actions.retract` is struck through.
- A type whose every operation is deprecated gets `@deprecated` on its `resourceMap` entry,
  so `client.tags` is struck through. Each deprecated CRUD operation also gets one on its
  `paths` entry, and a relation whose every endpoint is deprecated gets one on its entry.

When the server gives a sunset date, the tag names it:

```ts
/** @deprecated It may stop responding on or after 2027-06-30. */
tags: {
```

Some markers have nowhere to strike through. A single deprecated endpoint of a relation, such
as its related read, is named in the relation's TSDoc instead, because the relation itself
still works. The sentence reads "The `fetchRelated` endpoint is deprecated." The `get`, `list`, `create`, `update`
and `delete` methods are the same for every type, so they carry no per-type tag either; the
type's `paths` entry does. Filter keys, sort keys and sort families are members of
`filterable`, `sortable` and `sortFamilies`, and a member of a string literal union can't
carry TSDoc. The codegen names the deprecated ones in the TSDoc on those three entries
instead:

```ts
/** The server marks the `length` sort deprecated, in either direction. */
sortable: [
```

A document with no markers generates no deprecation TSDoc at all.

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
  (`string` / `number` / `boolean` / `date` / `date-time` / `object`, or `unknown`
  for a value of several types). The
  *precise* per-type interface (e.g. `AlbumsAttributes`) is emitted alongside and
  wired onto the client through the `Attributes` map.
- **`relations`** — per relation: `cardinality` (`one`/`many`), the related
  `types` array, whether it is a `pivot` (`belongsToMany`) relation (with its
  [`readPivot` and `writePivot`](#pivot-fields)), its declared
  [`identifierMeta`](#identifier-meta), whether it is
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
- **`sortFamilies`**: the sort families the collection read accepts beside `sortable`,
  read from the `sort` parameter's `x-sort-families`. Each is a `prefix` and the
  `suffixPattern` its keys' suffix must match, and adds `<prefix>.${string}` and
  `-<prefix>.${string}` to the type's sort union. When the parameter has families its
  items are an `anyOf` of the fixed-key enum and one pattern per family, and `sortable`
  holds that enum's keys. Absent when the type declares no family. See
  [sort families](filtering-and-sorting.md#sort-families).
- **`listFilters`**: the keys of `filterable` whose filter takes a list, read from the
  `x-filter-list` on their `filter[<key>][]` parameters. A filter that takes both the
  array and the comma form is one `filterable` key. Each is typed `readonly string[]` and
  sent as `filter[<key>][]` once per member. Absent when no filter takes a list. See
  [list filters](filtering-and-sorting.md#list-filters).
- **`filterFamilies`**: the filter families the collection read accepts beside
  `filterable`, read from the `filter` parameter's `x-filter-families`. Each is a `prefix`,
  the `suffixPattern` its keys' suffix must match and `list: true` when its filters take a
  list, and adds `<prefix>.${string}` to the type's `filter` object. Absent when the type
  declares no family. A collection action that takes filters carries its own `listFilters`
  and `filterFamilies` beside its `filterable`. See
  [filter families](filtering-and-sorting.md#filter-families).
- **`included`** — the types a compound document of the type can carry, read from the
  document's typed `included` (a `oneOf` over `<Type>Resource` components discriminated by
  `type`). A relation's `included` lists the same for its related read. Absent when nothing is
  includable, or when the document types `included` only as `{type, id}`. The generated
  `Included<'albums'>` and `RelatedIncluded<'albums', 'tracks'>` types are the matching resource
  unions, narrowed by `type`; without a list they cover every type.
- **`countable`** — the collection's `withCount` tokens and the negotiation
  profile URI (read from the parameter's `x-profile`, never hardcoded).
- **`resourceCountable`** — the same for each operation answering with one resource that
  documents `withCount`, keyed `fetchOne`, `create` or `update`, with `_self_` left out of the
  tokens. Absent when none documents it.
- **`relatedQuery`** — the `relatedQuery` parameter for resources of this type, read from the
  `<Type>RelatedQuery` component the documents share between every operation answering with
  them. `relations` lists the relations it addresses, the keys of the component schema's
  `properties`. `operations` names the type's own operations that take it (`fetchMany`,
  `fetchOne`, `create`, `update`), and is empty for a type only related reads or actions answer
  with, such as `credits` in the contract witness. `profile` is the Relationship Queries profile
  URI read from its `x-profile`. A relation over one type whose related read takes it carries
  `relatedQuery: true`, and so does an action answering with a resource that takes it. Absent
  when no operation documents it. See
  [relationship queries](filtering-and-sorting.md#relationship-queries).
- **`actions`** — custom actions keyed by name, each carrying `scope`
  (`resource`/`collection`), `path`, `input` (`document`/`none`/`raw`) and
  `output` (`document`/`meta`/`location`/`none`), plus an `inputType`/`outputType` where the
  action names a resource, and a `location` when it answers with a URL. A `document` action gets emitted `…Input`/`…Output`
  type aliases. See [custom actions](custom-actions.md). An action needing OAuth
  scopes carries them as `scopes`, and one declaring a `202 Accepted` carries
  `accepted: { jobType }`. Its `output` and `outputType` come from its other success
  responses, since a `202`'s body is the job.
- **`accepted`** — the writes that declare a `202 Accepted`, keyed `create` or `update`,
  each `{ jobType }`: the job type the `202` body's primary `data` names, from a `$ref` to
  that type's document or an inline document of a type the server doesn't register.
  Those writes, and only those, resolve to their result or an `Accepted` job and take
  `wait`. Absent when no write declares one. See
  [writes accepted for later](writes.md#writes-accepted-for-later).
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

In your own project, `--check` belongs in the same CI job as your lint and typecheck
steps, pinned to a committed spec, so a stale client can never merge:

```bash
json-api-codegen --input spec/music.openapi.json --output src/api/music.gen.ts --check
```

!!! note "This repo generates in CI instead of committing"
    This repo's own clients are not committed. The server documents they come from are
    devDependencies pinned to one exact version, `@haddowg/json-api-symfony-specs` (the
    bundle's music-catalog example) and `@haddowg/json-api-witness` (core's contract
    witness), and [`scripts/generate.mjs`](../scripts/generate.mjs) writes every client and
    MCP model from them before the typecheck and the tests run. `pnpm codegen:check` then
    runs the CLIs' `--check` against what was written. Because no diff of the output appears
    in a pull request, CI generates it on the base and the head and posts the difference as
    a comment, and the check fails until the `generated-output` label says someone read it.

    ```bash
    pnpm generate        # build the CLIs and write every output from the pinned documents
    pnpm codegen:check   # fail if an output on disk is not what the CLIs produce
    pnpm check:pins      # each document pin is exact, published, and a release on main
    ```

## See it in the example app

- [`scripts/generate.mjs`](../scripts/generate.mjs) — the generate / drift-check harness
  this repo runs (`pnpm generate` / `pnpm codegen:check`).
- `packages/codegen/test/generated/music-catalog.client.gen.ts`, written by
  `pnpm generate` — a full generated client, header, interfaces, descriptor and factory.
- `examples/spotify-clone/src/generated/music-catalog.gen.ts`, written the same way — the
  generated client the spotify-clone app actually imports and uses.

## Next

- [Concepts](concepts.md) — the descriptor and how the generic runtime consumes it.
- [Reads](reads.md) — the typed read surface the descriptor unlocks.
- [Validation](validation.md) — wiring the `--schemas` output into the opt-in seam.
