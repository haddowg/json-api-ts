# @haddowg/json-api-client

> **Part of the [jsonapi.rest](https://jsonapi.rest) suite** — a complete, spec-compliant
> JSON:API 1.1 stack: a framework-agnostic PHP [core](https://github.com/haddowg/json-api), a
> [Symfony bundle](https://github.com/haddowg/json-api-symfony), a
> [Laravel package](https://github.com/haddowg/json-api-laravel), and this **typed TypeScript
> client**, bound together by one conformance-tested OpenAPI 3.1 contract.
> Full documentation: **[haddowg.github.io/json-api-ts](https://haddowg.github.io/json-api-ts/)**.

The generic, framework-agnostic runtime for a typesafe JSON:API client. Parameterised by a
descriptor emitted by [`@haddowg/json-api-codegen`](../codegen) — the codegen reads your API's
OpenAPI document; this package does the de/serialisation, hydration, and the fluent surface.

Works standalone (`await client.albums.list()` needs no framework). For TanStack Query caching +
normalization, add [`@haddowg/json-api-query`](../query).

## Install

```bash
pnpm add @haddowg/json-api-client
```

You generally don't construct the client from this package directly — the generated module
re-exports a descriptor-bound `createClient`. The snippets below assume that generated
`createClient` (see the [codegen docs](../codegen)).

## Creating a client

```ts
import { createClient } from './api/music.gen'

const client = createClient({
  baseUrl: 'https://music.example',
  // transport?: defaults to the global `fetch` adapter when omitted
  // headers?: per-request header provider (e.g. bearer auth); may be async
  headers: async () => ({ Authorization: `Bearer ${await getToken()}` }),
})
```

`ClientOptions`:

| Option      | Type                                        | Notes                                                        |
| ----------- | ------------------------------------------- | ------------------------------------------------------------ |
| `baseUrl`   | `string`                                    | Base URL the generated path templates resolve against.       |
| `transport` | `(req) => Promise<res>`                     | The transport seam; defaults to a `fetch` adapter.           |
| `headers`   | `() => HeadersInit \| Promise<HeadersInit>` | Per-request header provider (bearer auth, etc.).             |
| `atomic`    | `AtomicDescriptor \| null`                  | Atomic endpoint; the generated `createClient` threads it in. |
| `validate`  | `ValidationOption`                          | Opt-in per-field validation seam (off by default).           |

## Reads

A resource read returns a **materialised** value: attributes and `type`/`id` are flat, enumerable
props (clean to spread / `JSON.stringify`); the envelope hangs off non-enumerable `$`-accessors.

### List a collection — filter / sort / include / fields / page

```ts
const albums = await client.albums.list({
  filter: { status: 'released' },
  sort: '-releasedAt',
  include: ['artist'], // widens `artist` to a hydrated resource in the result type
  fields: { albums: ['title', 'status', 'artist'] }, // sparse — other attrs are statically absent
  page: { number: 1 },
})

albums[0]!.title // string
albums[0]!.artist?.name // hydrated artist resource (its attributes are typed)
albums.$page.kind // 'page' | 'offset' | 'cursor' | 'none'
albums.$meta?.['page'] // raw top-level meta
```

> A relation kept in `include` must also stay in the `fields` set for that type, or it is narrowed
> off the result type.

### Get one — with a hydrated compound document

```ts
const ok = await client.albums.get('1', { include: ['artist', 'tracks'] })

ok.title // string
ok.$self // resource-level self link (non-enumerable)
ok.tracks // the to-many `tracks` is a hydrated augmented array of track resources
```

### Resource-level `$`-accessors

A materialised resource carries (all non-enumerable):

- `$meta` — resource-level meta
- `$links` / `$self` — resource-level links (`$self` is the `self` link shorthand)
- `$document` — the shared, trimmed top-level `{ jsonapi, meta, links }`
- `$raw` — the original JSON:API resource object (escape hatch)
- `$rel(name)` — `{ data, links, meta }` for a relation (links-only relations + introspection)

### Follow a relationship

```ts
// The related RESOURCES (full objects): GET /albums/1/tracks
const tracks = await client.albums
  .id('1')
  .rel('tracks')
  .related({ page: { size: 2 } })
tracks.map((t) => t.title)
tracks.$page.kind

// The LINKAGE (resource identifiers): GET /albums/1/relationships/tracks
const linkage = await client.albums.id('1').rel('tracks').get()
```

### Pivot data on a many-to-many edge

Each member of a `belongsToMany` to-many carries its per-edge pivot under `$pivot` (typed sugar
over `meta.pivot`); the same resource in another parent carries a different pivot.

```ts
const ordered = await client.playlists.id(playlistId).rel('orderedTracks').related()
ordered[0]!.$pivot?.['position'] // edge-local pivot data
```

### `withCount` (the Countable profile)

`withCount` is constrained to the type's count tokens and only available on `list` / related
reads (no single-`get` endpoint advertises it). The client negotiates the Countable profile in
`Accept` automatically when `withCount` is present.

```ts
const albums = await client.albums.list({ withCount: ['tracks'] })
```

### Pagination & cursor

All three collection surfaces (top-level lists, related collections, to-many relationship arrays)
expose the same `$page` + `$next()` / `$prev()`. Navigation is **count-free-safe** — driven by
link presence, not a total. Cursor pagination is just a paginator `kind`; page with
`page[cursor]` / `page[size]` query params and walk it with `$next()`:

```ts
let page = await client.tracks.list({ page: { size: 50 } })
while (page) {
  for (const track of page) {
    /* … */
  }
  page = await page.$next() // undefined when there is no next link
}
```

## Writes

Flat ergonomic input — the client builds the JSON:API document. Create / update return the
materialised resource; delete resolves `void`.

```ts
// POST /albums — `id` is required/optional/forbidden per the spec's per-type policy.
const created = await client.albums.create({ title: 'Kid A', status: 'released' })

// PATCH /albums/1 — a partial patch.
const updated = await client.albums.id('1').update({ title: 'OK Computer (Remaster)' })

// DELETE /albums/1 — resolves void (a 204).
await client.albums.id('1').delete()
```

Create / update accept an optional second arg `{ include?, fields? }` to shape the materialised
response, exactly like a read.

### Relationship mutation

A to-many relation exposes `add` / `remove` / `replace`; a to-one exposes `set(ref | null)`. A
verb is present only when the relation's endpoint advertises it (the descriptor's per-relation
`mutations` flags, derived from the bundle's `cannotAdd` / `cannotRemove` / `cannotReplace` +
endpoint exposure) — a forbidden verb is a compile error, not a runtime surprise.

```ts
// to-many: POST / DELETE / PATCH .../relationships/tracks
await client.albums
  .id('1')
  .rel('tracks')
  .add([{ type: 'tracks', id: '4' }])
await client.albums
  .id('1')
  .rel('tracks')
  .remove([{ type: 'tracks', id: '4' }])
await client.albums
  .id('1')
  .rel('tracks')
  .replace([
    { type: 'tracks', id: '1' },
    { type: 'tracks', id: '3' },
  ])

// to-one: PATCH .../relationships/artist
await client.albums.id('1').rel('artist').set({ type: 'artists', id: '2' })
await client.albums.id('1').rel('artist').set(null) // clear
```

> **Verb / relation collision:** relations are reachable via `.rel('name')` (and, for the common
> case, by name directly off the handle). A relation named like a reserved verb (`get`, `update`,
> `delete`, `actions`, …) is shadowed — the codegen warns at build time and you reach it via
> `.rel('name')`.

## Custom actions

Actions are reached via `.actions.<name>`: collection-scoped off the type accessor, resource-scoped
off a handle (`.id(id)`). The body shape follows the action's declared `input`
(`none` / `document` / `raw`); a `document` output is materialised, a `none` output resolves
`undefined`.

```ts
// Resource-scoped, document in / document out.
const reissued = await client.albums.id('1').actions.reissue({
  data: { type: 'albums', attributes: { title: 'OK Computer' } },
})

// Collection-scoped, no input.
const summary = await client.albums.actions.summary()
```

## Atomic operations

`client.atomic(tx => …)` records ops in order and posts them as one all-or-nothing batch (the
atomic ext media type). A `tx.create(...)` handle **doubles as a `lid` ref**, so a just-created
resource wires into later ops without a server id. Results are typed positionally by op index.

```ts
const [artist, geogaddi] = await client.atomic((tx) => {
  const newArtist = tx.create({ type: 'artists', name: 'Boards of Canada' })
  const newAlbum = tx.create({ type: 'albums', title: 'Geogaddi', artist: newArtist })
  return [newArtist, newAlbum] as const
})

artist.data.id // '99'
geogaddi.data.title // 'Geogaddi'
```

`tx` also exposes `tx.update({ type, id, …fields })` and `tx.delete({ type, id } | ref)`. Calling
`client.atomic` on a server that exposes no atomic endpoint throws.

## Errors

A non-2xx throws a typed `JsonApiError` carrying `status` + `errors: JsonApiErrorObject[]`, with
expressive status matchers and pointer grouping:

```ts
import type { JsonApiError } from '@haddowg/json-api-client'

try {
  await client.albums.create({ title: '' })
} catch (e) {
  const error = e as JsonApiError
  error.isUnprocessable() // 422 (alias: isValidationError())
  // Server pointers (`/data/attributes/title`) are remapped to your FLAT input path (`title`).
  error.byPath()['title']?.[0]?.detail // 'must not be blank'
}
```

Status matchers: `hasStatus(n)`, `is4xx()`, `is5xx()`, `isBadRequest()` /400,
`isUnauthorized()` /401, `isForbidden()` /403, `isNotFound()` /404, `isNotAcceptable()` /406,
`isConflict()` /409, `isUnsupportedMediaType()` /415, `isUnprocessable()` /
`isValidationError()` /422, `isRateLimited()` /429.

`byPath()` groups errors by the flat input path (falling back to the raw pointer, then the query
`parameter`) — the payoff for form/validation UX. Each error keeps its raw `source.pointer` as an
escape hatch; atomic errors also carry an `opIndex`.

> A response that parses but violates the JSON:API envelope shape (not a document, a member
> missing `type`/`id`) throws a `StructuralGuardError` — distinct from a server-reported
> `JsonApiError`. These light structural guards are always on; full per-field validation is opt-in
> (below).

## Transport

The transport is a tiny `fetch`-shaped function, so any impl (native `fetch`, undici, an axios
adapter, or a test mock) drops in:

```ts
import type {
  JsonApiTransport,
  TransportRequest,
  TransportResponse,
} from '@haddowg/json-api-client'

const transport: JsonApiTransport = async (req: TransportRequest): Promise<TransportResponse> => {
  const res = await myHttpLib(req.method, req.url, { headers: req.headers, body: req.body })
  return { status: res.status, headers: res.headers, body: res.text }
}

const client = createClient({ baseUrl: 'https://music.example', transport })
```

Retries are deliberately out of scope here — the transport (or the TanStack layer) owns them.

## Opt-in validation

The core runtime trusts the wire (you own both ends; the envelope is invariant) and only runs the
light structural guards. Full per-field validation is **opt-in** via the `validate?` option, fed by
the codegen-emitted per-type `schemas` map. The validation engine is brought by you, never in the
core dep tree.

### With the bundled ajv adapter

`ajv` is an optional peer dependency; the adapter lives at the `@haddowg/json-api-client/ajv`
sub-path, so importing the main entry never pulls ajv in.

```bash
pnpm add ajv
```

```ts
import Ajv2020 from 'ajv/dist/2020'
import { createClient } from './api/music.gen'
import { createAjvValidator } from '@haddowg/json-api-client/ajv'
import { schemas } from './api/music.schemas.gen' // the codegen's `--schemas` output

// The bundle emits JSON Schema 2020-12, so use `Ajv2020`. `strict: false` tolerates the
// schemas' `x-enum-*` annotations; `allErrors` aggregates every failing field.
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })

const client = createClient({
  baseUrl: 'https://music.example',
  validate: createAjvValidator(ajv, schemas),
})
```

Every wire resource is now validated against `schemas[type]`; a type the bundle does not cover is
skipped (graceful partial coverage). A failure throws an `AjvValidationError` carrying every
failing `{ type, id?, pointer, keyword, message }`.

### With your own engine

`validate` also accepts the schema-driven config `{ schemas, validator }` or a bare
`(resource, schema) => void` validator that owns its own schema lookup:

```ts
const client = createClient({
  baseUrl: 'https://music.example',
  validate: (resource) => {
    // throw on an invalid resource; return for a valid one
  },
})
```

## License

MIT
