# Concepts

The mental model behind `json-api-ts` — why it is generated the way it is, and why a
read comes back as a flat, hydrated object. Read this once and the rest of the docs
will feel obvious.

There are only two ideas to hold:

1. **The OpenAPI document is the contract.** Everything the client needs to be typesafe
   is already in the spec your API serves.
2. **The wire envelope is materialised.** The nested JSON:API document a read returns is
   turned into flat resource objects with hydrated relations, so you work with `album.title`
   and `album.artist.name`, not `data.attributes.title`.

Everything else is machinery in service of those two ideas.

## The OpenAPI document is the contract

JSON:API's wire shape is invariant — every response is `{ data, included?, meta?, links? }`,
every resource is `{ type, id, attributes?, relationships? }`. That regularity is the whole
point: the *shape* never changes, only the *catalogue of types* does. And the catalogue is
fully described by the OpenAPI 3.1 document your [`haddowg/json-api`](https://github.com/haddowg/json-api)-powered
backend — the Symfony bundle, the Laravel package, or the core in your own stack — emits at `/docs.json`.

The spec is **self-describing** for everything the client needs — no bespoke extension is
required to read it:

- **Type identity** is machine-readable — every `<Type>Resource` / `<Type>ResourceIdentifier`
  schema carries `properties.type.const` (e.g. `const: "albums"`).
- **Relationships** are derivable from structure: enumerate a resource's
  `relationships.properties`; the relationship component's `data` gives **cardinality**
  (an array = to-many; `anyOf [ident, null]` = to-one) and the **related type** (follow the
  `$ref` to the identifier, read its `type.const`). A nested `anyOf` = **polymorphic** (more
  than one related type).
- **The allowed `?include` paths** are handed over literally, **pre-expanded** as a bounded
  enum per endpoint (`artist`, `artist.albums`, `tracks.album`, …) — so include-driven typing
  is a union over a *finite* set, never open recursion.
- **The create client-id policy** is encoded in the create request body: `id: false`
  (forbidden), `id` in `required`, or `id` optional.
- **Paginator kind**, sortable/filterable keys, countable tokens, and custom actions are all
  read off the same document.

!!! note "One typed client per server"
    The spec is per-server. The music-catalog example ships a `default` and an `admin` server
    that differ in type-set and path prefix, so you generate one client per server. See
    [codegen](codegen.md).

## The codegen emits a descriptor, not per-endpoint code

Because the wire shape is invariant, all the real work — serialise, deserialise, resolve
includes, materialise, normalise — is **generic** machinery that only needs to know the
type catalogue. So the codegen does **not** template a client method per OpenAPI operation
(the usual OpenAPI-generator approach, which produces large, brittle output that fights
JSON:API's regularity).

Instead it emits a single **runtime descriptor** — a plain `as const` object describing
each type — and **derives the TypeScript types from it** ([ADR 0001](https://github.com/haddowg/json-api-ts/blob/main/docs/adr/0001-generate-a-runtime-descriptor-not-per-endpoint-clients.md)).
The generated file looks like this (abridged):

```ts
export const resourceMap = {
  albums: {
    attributes: { title: 'string', status: 'string', releasedAt: 'date-time', /* … */ },
    relations: {
      artist: { cardinality: 'one', types: ['artists'], mutations: { set: true } },
      tracks: { cardinality: 'many', types: ['tracks'], mutations: { add: true, remove: true, replace: true } },
    },
    paths: { fetchOne: '/albums/{id}', fetchMany: '/albums', create: '/albums', /* … */ },
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['artist', 'artist.albums', 'tracks', 'tracks.album', 'tracks.playlists'],
    // sortable, filterable, countable, actions …
  },
  // artists, tracks, playlists, …
} as const satisfies ApiDescriptor

export type ResourceMap = typeof resourceMap
export const createClient = (options: ClientOptions) => /* binds resourceMap into the runtime */
```

The descriptor carries exactly what types alone can't express at runtime — attribute-vs-relation,
cardinality, related type(s), per-operation path templates (respecting `uriType` and server
prefixes), paginator kind, and the client-id policy — plus generated interfaces for the precise
attribute types. This is one source of truth: the value drives the runtime, the types are computed
from it.

The payoff: **tiny, uniform generated output** and a single generic runtime that works for any
API without change. The trade-off, recorded in the ADR, is that the descriptor shape is the
contract between the codegen and the runtime, so changing it is a breaking change across both
packages.

!!! tip "The descriptor is fully static"
    `resourceMap` is a plain object literal — you can read it, log it, and TypeScript sees it
    `as const`, so `resourceMap.albums.relations.artist.types` narrows to `['artists']`. It has
    no runtime tie to the codegen; the generated file only imports `@haddowg/json-api-client`.

## The generic runtime is parameterised by the descriptor

`@haddowg/json-api-client` ships the generic machinery: the `fetch`-shaped transport seam,
content negotiation, (de)serialisation, materialisation, the fluent read/write surface, typed
errors. It knows nothing about `albums` or `tracks` — it is parameterised by the descriptor
the codegen bakes in:

```ts
import { createClient } from './api/music.gen'

const client = createClient({ baseUrl: 'https://music.example' })

// The descriptor tells the runtime that `albums` exists, that `artist` is a to-one to
// `artists`, and that `/albums/{id}` is the fetch path. There is no per-endpoint code.
const album = await client.albums.id('1').get({ include: ['artist'] })
```

The fluent surface (`client.<type>.list/get/create`, `.id(id).update/delete`, relationship
accessors, `.actions.<name>`, `client.atomic`) is all generic — it reads the descriptor to
know which types, relations, and verbs exist and gates the surface accordingly (an unadvertised
relationship verb is typed `never`, a suppressed related endpoint is a compile error). The
[architecture](architecture.md) page details how the packages fit together.

## Reads are materialised into flat resource objects

A JSON:API read returns a normalised wire document — primary `data` plus a flat `included`
array, with relationships expressed as `{ type, id }` identifiers you'd have to stitch back
together yourself. The client does that stitching for you and **materialises** the envelope
into a self-contained hydrated graph ([ADR 0002](https://github.com/haddowg/json-api-ts/blob/main/docs/adr/0002-resource-and-hydration-model.md)):

```ts
const album = await client.albums.id('1').get({ include: ['artist', 'tracks'] })

album.title          // attribute — a plain string
album.artist?.name   // hydrated — `artist` is a full resource object (you asked to include it)
album.tracks         // an augmented array of Track resource objects
album.tracks.length  // it's a real array
```

Two design choices make this ergonomic and safe:

- **Data is flattened as own *enumerable* properties** — `type`, `id`, attributes, and
  relations are plain props, so `{ ...album }` and `JSON.stringify(album)` are clean. The
  wire envelope (resource meta, links, the shared top-level document) is exposed through
  non-enumerable **`$`-prefixed accessors** (`$meta`, `$links`, `$self`, `$document`,
  `$edge`, `$pivot`, `$rel`, `$raw`). `$` is collision-proof because JSON:API forbids it in
  member names; `type`/`id` stay plain because the spec reserves them.
- **The return type is computed from the `include` argument.** Because the spec hands over a
  bounded enum of includable paths, TypeScript can promise that an included relation is a full
  resource and a non-included one is `Identifier | undefined`. Ask for `include: ['artist']`
  and `album.artist` is an `Artist`; omit it and it's an identifier (or `undefined`).

!!! note "Missing includes are graceful, never an error"
    If the server omits a relation you didn't include, it stays an identifier (with a dev-mode
    warning) — the client never throws at the materialisation boundary. See
    [materialisation](materialisation.md).

??? note "Going deeper: per-edge views and identity by `type:id`"
    A related value is a **per-edge view** — it reads through to the underlying resource for its
    attributes but carries its own edge-local envelope (`$edge`, and `$pivot` for a
    `belongsToMany` relation). The *same* track reached through two different playlists is two
    distinct views with different pivot data, so **identity is by `type:id`, never object
    reference** — `playlist.tracks[0]` is not reference-equal to the same track fetched
    standalone. This is deliberate: edge-local data (`$pivot`/`$edge`) must never leak onto the
    shared node. [Materialisation](materialisation.md) covers the accessors in full.

## Generated code is committed into your repo

The codegen writes the descriptor + types + bound `createClient` into a file in **your**
repository (one file, or a small directory) — à la `openapi-typescript` or `graphql-codegen`.
It is reviewable, diffable, and versioned. It is **not** a published package: it imports
`@haddowg/json-api-client` at runtime, and you regenerate it whenever the API changes and
commit the diff.

This keeps the surprise out of your build: the types your editor sees are the types in your
git history, and a spec change shows up as a reviewable diff rather than a silent behaviour
shift. See [codegen](codegen.md) for the CLI and config.

## Where to go next

- **[architecture](architecture.md)** — the three packages, the transport seam, and how a
  request flows through the runtime.
- **[codegen](codegen.md)** — pointing the CLI at your spec and what it emits.
- **[materialisation](materialisation.md)** — the resource-object shape, `$`-accessors,
  hydration, and augmented arrays in detail.

For the full design rationale and glossary, read [`CONTEXT.md`](../CONTEXT.md) and the
[ADRs](https://github.com/haddowg/json-api-ts/tree/main/docs/adr).

## See it in the example app

- The generated descriptor and types for a real API:
  [music-catalog.gen.ts](../packages/example/src/generated/music-catalog.gen.ts) — the
  `resourceMap` and derived `ResourceMap` type this page describes.
- Every concept exercised as a tested, typed call:
  [example.test.ts](../packages/example/src/example.test.ts) (run under `pnpm test`, grouped
  by `describe(...)`).
- A full worked React + TanStack Query app over the same generated client:
  [spotify-clone](../examples/spotify-clone/src/generated/music-catalog.gen.ts).

**Next:** [architecture](architecture.md) · [codegen](codegen.md) · [reads](reads.md)
