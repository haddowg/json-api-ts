# Generating the client

The typed client is generated, not hand-written. `@haddowg/json-api-codegen`
reads the OpenAPI 3.1 document your `haddowg/json-api-symfony` API serves and
emits a single TypeScript module — a runtime descriptor, per-type attribute
types, and a descriptor-bound `createClient`. This page walks the CLI from the
one-line invocation through to wiring the drift gate into CI.

## The one command

Point `--input` at your served (or exported) OpenAPI document and `--output` at
a file in your repo:

```bash
pnpm add -D @haddowg/json-api-codegen

json-api-codegen \
  --input https://music.example/docs.json \
  --output src/api/music.gen.ts
```

That writes one file — `src/api/music.gen.ts` — which you commit like any other
source. The [getting started](getting-started.md) walkthrough uses exactly this.

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
| `--server`  | no       | Target server name. Metadata-only — the served document is already per-server. |
| `--check`   | no       | Drift gate — regenerate in memory and fail if the committed output is stale. |

A local spec is convenient for CI (see [below](#drift-checking-in-ci)); a URL is
convenient during development against a running API. Either resolves to the same
generated output for the same spec content.

### The validation schemas

Add `--schemas` to also read the bundle's JSON Schema bundle and emit a sibling
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

### Multiple servers

The bundle serves **one document per server** (a `default` and an `admin` server
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

With `--schemas`, the sibling module exports `schemas` — the per-type JSON Schema
2020-12 map.

```ts
import { createClient, type ResourceMap, resourceMap } from './api/music.gen'
import { schemas } from './api/music.schemas.gen'

const client = createClient({ baseUrl: 'https://music.example' })
```

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

Every field is derived structurally from the spec — no proprietary extension is
required:

- **`attributes`** — the read attribute names with a coarse wire-format hint
  (`string` / `number` / `boolean` / `date` / `date-time` / `object`). The
  *precise* per-type interface (e.g. `AlbumsAttributes`) is emitted alongside and
  wired onto the client through the `Attributes` map.
- **`relations`** — per relation: `cardinality` (`one`/`many`), the related
  `types` array, whether it is a `pivot` (`belongsToMany`) relation (with
  `pivotFields` when present), the polymorphic type set (multiple entries in
  `types`), and the derived `mutations` capability (`add`/`remove`/`replace` for
  a to-many, `set` for a to-one — read from the relationship endpoint's HTTP
  methods). A relation whose related or relationship endpoint is suppressed by the
  API is marked `related: false` / `relationship: false` so the client gates it
  off rather than offering a call that 404s. A relation may also carry its own
  `countable` and a divergent `paginator`.
- **`paths`** — only the per-operation paths that actually exist
  (`fetchMany`/`fetchOne`/`create`/`update`/`delete`/`fetchRelated`/`fetchRelationship`).
  A read-only type simply has no `create`/`update`/`delete`.
- **`paginator`** — the collection's paginator kind, detected from its `page[…]`
  query parameters: `page`, `offset`, `cursor`, or `none`. See
  [pagination](pagination.md).
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
  `output` (`document`/`meta`/`none`), plus an `inputType`/`outputType` where the
  action names a resource. A `document` action gets emitted `…Input`/`…Output`
  type aliases. See [custom actions](custom-actions.md).

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
    import { generate, check, type CodegenConfig } from '@haddowg/json-api-codegen'

    const config: CodegenConfig = {
      input: 'https://music.example/docs.json',
      output: 'src/api/music.gen.ts',
      schemas: 'https://music.example/schemas.json', // optional
      server: 'default',                             // optional, metadata-only
    }

    await generate(config)                 // writes the file(s); returns the client source
    const { ok } = await check(config)     // drift gate: regenerate in memory, compare, no write
    ```

    Lower-level building blocks are exported too — `readDocument` / `readSchemas`,
    `buildDescriptor`, `emit` / `emitSchemas`, `detectVerbCollisions`,
    `schemasOutputPath`, and the provenance helpers `deriveProvenance` /
    `provenanceLines` / `hashJson`.

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
committed `--output` (and its schema sibling when `--schemas` is set) **without
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
