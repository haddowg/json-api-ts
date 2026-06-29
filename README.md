# json-api-ts

A typesafe, **JSON:API-flavored** TypeScript client, generated from the OpenAPI 3.1 document
emitted by the [`haddowg/json-api-symfony`](https://github.com/haddowg/json-api-symfony) bundle.

You point the codegen at your API's `/docs.json`, commit the generated client into your repo,
and get a `createClient` whose every read and write is typed end to end — `?include` hydrates
the requested relations into the result type, sparse `fields` narrow it, and the wire envelope
is materialised into clean, flat resource objects.

- **Typesafe (de)serialisation of resources and relationships**, including `?include` /
  compound documents — requested relationships are hydrated in the result type; the rest stay
  resource identifiers.
- **Framework-agnostic core** with a tiny `fetch`-shaped transport seam; first-class
  **TanStack Query** bindings on top.
- **`type:id` cache normalization** — edit a resource once, every cached query updates.
- Full **reads and mutations**, custom actions, and Atomic Operations.
- **Opt-in per-field validation** against the bundle's JSON Schemas (bring your own ajv).

## Lineage

```
haddowg/json-api          (core PHP library — framework-agnostic JSON:API)
        │
        ▼
haddowg/json-api-symfony  (Symfony bundle — emits the OpenAPI 3.1 + JSON Schemas)
        │
        ▼
haddowg/json-api-ts       (this repo — consumes the spec, generates the TS client)
```

The OpenAPI document is the contract: it carries machine-readable type identity, relationship
cardinality and related types, the allowed `?include` paths, the per-type client-id policy, and
paginator kinds — everything the generic runtime needs. The codegen reads it; the runtime is
parameterised by it. See [`CONTEXT.md`](./CONTEXT.md) and [`docs/adr/`](./docs/adr/) for the
design rationale.

## Packages

| Package                                           | Role                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`@haddowg/json-api-client`](./packages/client)   | Generic, framework-agnostic runtime, parameterised by a generated descriptor. |
| [`@haddowg/json-api-codegen`](./packages/codegen) | CLI: OpenAPI (+ JSON Schemas) → descriptor + types + bound `createClient`.    |
| [`@haddowg/json-api-query`](./packages/query)     | TanStack Query option/key factories + `type:id` normalization.                |

The [`packages/example`](./packages/example) workspace is a worked, tested usage reference: every
snippet there is a real typed call against the generated client, run under `pnpm test` so it can't
rot. The snippets in these READMEs are drawn from it.

## Quickstart

### 1. Generate a client from your API's OpenAPI document

```bash
# Install the codegen (dev-only — the generated output has no runtime tie to it).
pnpm add -D @haddowg/json-api-codegen
# Install the runtime (and the TanStack bindings, if you want them).
pnpm add @haddowg/json-api-client @haddowg/json-api-query

# Read the served OpenAPI document, emit the typed client, and (optionally) the JSON Schema map.
pnpm exec json-api-codegen \
  --input https://music.example/docs.json \
  --output src/api/music.gen.ts \
  --schemas https://music.example/schemas.json
```

`--input` and `--schemas` each accept an http(s) URL or a local file (JSON or YAML). The
generated `src/api/music.gen.ts` (and the `--schemas` sibling `src/api/music.schemas.gen.ts`)
is **committed into your repo** — reviewable, diffable, versioned, à la `openapi-typescript`. It
imports `@haddowg/json-api-client` at runtime; regenerate it when the API changes.

### 2. Create a client

```ts
import { createClient } from './api/music.gen'

// The generated `createClient` bakes in the descriptor and the server's atomic capability,
// so you supply only options. `transport` defaults to the global `fetch` when omitted.
const client = createClient({
  baseUrl: 'https://music.example',
  headers: () => ({ Authorization: `Bearer ${getToken()}` }), // optional, may be async
})
```

### 3. Read

```ts
// List with a typed filter, sort, an `include` that hydrates `artist`, and a sparse fieldset.
const albums = await client.albums.list({
  filter: { status: 'released' },
  sort: '-releasedAt',
  include: ['artist'],
  fields: { albums: ['title', 'status', 'artist'] },
  page: { number: 1 },
})

albums[0]!.title // typed string
albums[0]!.artist?.name // hydrated — `artist` is a full resource, not an identifier
albums.$page.kind // 'page' — pagination rides the array (count-free-safe)
```

### 4. Write

```ts
// Flat input — the client builds the JSON:API envelope and materialises the 201 response.
const created = await client.albums.create({ title: 'Kid A', status: 'released' })
created.id // the server-assigned id

await client.albums.id('1').update({ title: 'OK Computer (Remaster)' })
await client.albums.id('1').delete()
```

See the per-package docs for the full surface — relationship mutation, custom actions, atomic
batches, cursor pagination, the TanStack bindings, and the validation seam.

## Development

```bash
pnpm install          # resolves + locks the toolchain
pnpm build            # turbo: build every package (tsdown → dual ESM/CJS + .d.ts)
pnpm typecheck        # turbo: tsc --noEmit per package
pnpm test             # vitest, whole workspace
pnpm lint             # oxlint
pnpm format           # oxfmt --write
pnpm check            # lint + format:check + typecheck
pnpm lint:publish     # turbo: publint + are-the-types-wrong per publishable package
pnpm smoke            # require()/import the built dist both ways (needs a prior `pnpm build`)
```

`lint:publish` and `smoke` guard packaging: `publint` + `@arethetypeswrong/cli` validate each
publishable package's `exports`/`types`/`files`/`bin` and that its types resolve under both module
systems, and the smoke `require()`s and `import`s the built `dist` (including the
`@haddowg/json-api-client/ajv` sub-path) to prove the dual ESM/CJS build loads either way. Both run
in CI after the build.

## Design & docs

- [`CONTEXT.md`](./CONTEXT.md) — the design, the glossary, and the resolved decisions.
- [`docs/adr/`](./docs/adr/) — the architecture decision records.
- [`docs/PLAN.md`](./docs/PLAN.md) — the build roadmap.

## License

MIT
