# json-api-ts

A typesafe, JSON:API-flavored TypeScript client, **generated** from the OpenAPI 3.1 document your API already serves. Point the codegen at your spec, commit the emitted client, and every read and write is typed end to end — `?include` hydrates the requested relations into the result type, sparse `fields` narrow it, and the wire envelope is materialised into clean, flat resource objects.

## Lineage

The OpenAPI document is the contract. The [`haddowg/json-api-symfony`](https://github.com/haddowg/json-api-symfony) bundle emits it (with the per-type JSON Schemas); this repo consumes it — the codegen reads it, and a generic, framework-agnostic runtime is parameterised by it.

```
haddowg/json-api          (core PHP library — framework-agnostic JSON:API)
        │
        ▼
haddowg/json-api-symfony  (Symfony bundle — emits the OpenAPI 3.1 + JSON Schemas)
        │
        ▼
haddowg/json-api-ts       (this repo — consumes the spec, generates the TS client)
```

That spec carries everything the runtime needs: machine-readable type identity, relationship cardinality and related types, the allowed `?include` paths, the per-type client-id policy, and paginator kinds. See [concepts](concepts.md) for the mental model and [architecture](architecture.md) for how the pieces fit together.

## Packages

Three published packages, plus a worked example workspace.

| Package                                                    | Role                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`@haddowg/json-api-client`](../packages/client)          | Generic, framework-agnostic runtime, parameterised by a generated descriptor. |
| [`@haddowg/json-api-codegen`](../packages/codegen)        | CLI: OpenAPI (+ JSON Schemas) → descriptor + types + a bound `createClient`.   |
| [`@haddowg/json-api-query`](../packages/query)            | TanStack Query option/key factories + `type:id` cache normalisation.          |

!!! tip "The example workspace is the source of truth for API shape"
    [`packages/example`](../packages/example) is a worked, tested usage reference: every snippet in [`example.test.ts`](../packages/example/src/example.test.ts) is a real, typed call against the generated client, run under `pnpm test` so it can't rot. When in doubt about a signature, read it there.

## A 30-second taste

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

The generated `src/api/music.gen.ts` is **committed into your repo** — reviewable, diffable, versioned, à la `openapi-typescript`. It imports `@haddowg/json-api-client` at runtime; regenerate it when the API changes. See [codegen](codegen.md) for the full CLI.

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

### 3. One typed read

```ts
// List with a typed filter, sort, an `include` that hydrates `artist`, and a sparse fieldset.
const albums = await client.albums.list({
  filter: { title: 'OK' },
  sort: '-releasedAt',
  include: ['artist'],
  fields: { albums: ['title', 'status', 'artist'] },
  page: { number: 1 },
})

albums[0]!.title // typed string
albums[0]!.artist?.name // hydrated — `artist` is a full resource, not an identifier
albums.$page.kind // 'page' — pagination rides the array (count-free-safe)
```

`include` widens `artist` into a hydrated resource; `fields[albums]` narrows the result to exactly the listed members — any other attribute is statically absent from the type. More in [reading](reads.md).

### 4. One typed write

```ts
// Flat input — the client builds the JSON:API envelope and materialises the 201 response.
const created = await client.albums.create({ title: 'Kid A', status: 'released' })
created.id // the server-assigned id

await client.albums.id('1').update({ title: 'OK Computer (Remaster)' })
await client.albums.id('1').delete()
```

You pass flat attributes; the client wraps them into the JSON:API document and flattens the response back out. See [writes](writes.md).

## Where to next

- [Getting started](getting-started.md) — install, generate against your own API, and make your first call.
- [Concepts](concepts.md) — resource objects, materialisation, hydration, and the augmented arrays that carry the envelope.
- [Reading](reads.md) — list, get, follow relationships, filter, sort, include, and paginate.
- [TanStack Query bindings](tanstack-query.md) — option/key factories and `type:id` write-through normalisation for React.

For the full worked application, see the [example app](example-app.md) — a React + TanStack Query Spotify clone over a mock transport.
