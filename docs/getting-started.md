# Getting started

From zero to a first typed read and write against your JSON:API. You generate a
client from your API's OpenAPI document, create it once, then read and write with
full end-to-end types — no hand-written models, no casts.

!!! note "Prerequisites"
    Your API is served by the [`haddowg/json-api-symfony`](https://github.com/haddowg/json-api-symfony)
    bundle, which exposes an OpenAPI 3.1 document (usually at `/docs.json`) and,
    optionally, a JSON Schema map (at `/schemas.json`). That document is the
    contract the codegen reads — see [concepts](concepts.md) for why.

## 1. Install

The codegen is a **dev-only** dependency: the client it generates has no runtime
tie back to it. The runtime (and, if you want caching, the TanStack Query
bindings) are ordinary runtime dependencies.

```bash
# dev-only — generates the client, then gets out of the way
pnpm add -D @haddowg/json-api-codegen

# runtime — the generic client the generated module binds to
pnpm add @haddowg/json-api-client

# optional — TanStack Query bindings (add when you want caching + normalisation)
pnpm add @haddowg/json-api-query
```

## 2. Generate the client

Point the codegen at your API's OpenAPI document and choose where the client
lands. Add `--schemas` to also emit the per-type JSON Schema map that powers the
optional [validation](validation.md) seam.

```bash
pnpm exec json-api-codegen \
  --input https://music.example/docs.json \
  --output src/api/music.gen.ts \
  --schemas https://music.example/schemas.json
```

`--input` and `--schemas` each accept an **http(s) URL or a local file** (JSON or
YAML) — so you can generate straight from a running server or from a spec fixture
committed to your repo. This writes two files:

- `src/api/music.gen.ts` — the typed client (runtime descriptor + types + a bound
  `createClient`);
- `src/api/music.schemas.gen.ts` — the per-type schema map (only with `--schemas`).

!!! tip "Commit the generated files"
    The output is one small, reviewable, diffable module — commit it into your
    repo, à la `openapi-typescript`. It imports `@haddowg/json-api-client` at
    runtime; regenerate it whenever the API changes. The header carries a
    deterministic provenance stamp (source spec + a content hash), and
    `--check` gives you a CI drift gate. See [codegen](codegen.md) for the full
    flag reference, the programmatic API, and multi-server output.

## 3. Create the client

The generated `createClient` bakes in the descriptor and the server's atomic
capability, so you supply only options. `transport` defaults to the global
`fetch` when omitted — the minimal client is just a `baseUrl`.

```ts
import { createClient } from './api/music.gen'

const client = createClient({
  baseUrl: 'https://music.example',
})
```

Add a `headers` provider for auth — it runs per request and **may be async**, so
a fresh bearer token is fetched each time:

```ts
const client = createClient({
  baseUrl: 'https://music.example',
  headers: async () => ({ Authorization: `Bearer ${await getToken()}` }),
})
```

??? note "Going deeper: swapping the transport"
    The `transport` seam is a tiny `fetch`-shaped function, so undici, an axios
    adapter, or a test mock all drop in. The [example.test.ts](../packages/example/src/example.test.ts)
    reference wires a mock transport that replays captured fixtures; in a real app
    you omit `transport` entirely and let the client use global `fetch`. See the
    [`@haddowg/json-api-client` README](../packages/client/README.md) for the
    transport contract and the full `ClientOptions` table.

## 4. First read

Read a collection with a typed filter and sort. `include` hydrates a related
resource into the result type; `fields` narrows the result to exactly the
selected attributes.

```ts
const albums = await client.albums.list({
  filter: { title: 'OK' },
  sort: '-releasedAt',
  include: ['artist'], // widens `artist` to a hydrated resource
  fields: { albums: ['title', 'status', 'artist'] },
  page: { number: 1 },
})

albums[0]!.title // typed string
albums[0]!.artist?.name // hydrated — `artist` is a full resource, not an identifier
albums.$page.kind // 'page' — pagination rides the array, count-free-safe
```

Fetching a single resource is just as flat:

```ts
const ok = await client.albums.get('1', { include: ['artist', 'tracks'] })
ok.title // string
ok.tracks // the to-many `tracks`, hydrated into an array of track resources
```

The wire envelope is [materialised](materialisation.md) into flat resource
objects: `type`/`id` and attributes are plain enumerable props, while the
envelope (links, meta, pagination) hangs off non-enumerable `$`-accessors. See
[reading](reads.md) for the full read surface.

## 5. First write

Writes take **flat** input — the client builds the JSON:API envelope and
materialises the response back into a flat resource.

```ts
// POST /albums — returns the materialised 201 body
const created = await client.albums.create({ title: 'Kid A', status: 'released' })
created.id // the server-assigned id

// PATCH /albums/1 — a partial patch
await client.albums.id('1').update({ title: 'OK Computer (Remaster)' })

// DELETE /albums/1 — resolves void (a 204)
await client.albums.id('1').delete()
```

A failed write throws a typed error you can key by your flat input path — ideal
for form UX:

```ts
try {
  await client.albums.create({ title: '' })
} catch (e) {
  const error = e as import('@haddowg/json-api-client').JsonApiError
  error.isUnprocessable() // 422
  error.byPath()['title']?.[0]?.detail // 'must not be blank'
}
```

See [writing](writes.md) for the full write surface (response shaping,
relationship mutation from within a write) and [errors](errors.md) for the error
model.

## See it in the example app

- The [spotify-clone client wiring](../examples/spotify-clone/src/api/client.ts)
  is a concrete, real-world `createClient` — it builds the client over either a
  seeded mock transport or a live `fetch` transport, wires a QueryClient with
  `type:id` normalisation, and exposes the bound TanStack read/write APIs.
- The tested [example.test.ts](../packages/example/src/example.test.ts) is the
  canonical usage reference: every read/write snippet on this page is a real typed
  call there, grouped by `describe(...)` and run under `pnpm test`, so it can't
  rot.

## Next

- [Codegen](codegen.md) — every flag, the drift check, and multi-server output.
- [Reading](reads.md) — filters, sort, include, sparse fields, pagination.
- [Writing](writes.md) — create/update/delete, response shaping, relationship writes.
