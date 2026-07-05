# Architecture

A map of the `json-api-ts` monorepo: what each package is for, where the seams are, and where the generated code you commit actually lives. If you want the reasoning behind these boundaries rather than the shape of them, the [ADRs](https://github.com/haddowg/json-api-ts/tree/main/docs/adr) are the record.

## The lineage

`json-api-ts` sits at the end of the chain. It never talks to your database or your PHP — it consumes a contract, and any backend built on `haddowg/json-api` emits that contract: the Symfony bundle, the Laravel package, or the core wired into your own stack.

```
haddowg/json-api            core PHP library (framework-agnostic JSON:API)
        │
        ▼
haddowg/json-api-symfony    framework integrations — each emits the same
haddowg/json-api-laravel    OpenAPI 3.1 document + JSON Schemas; the core
  …or the core directly     serves them from any PSR-15 stack
        │
        ▼
haddowg/json-api-ts         this repo — reads the spec, generates the typed TS client
```

The OpenAPI document is the contract. It carries machine-readable type identity, relationship cardinality and related types, the allowed `?include` paths, the per-type client-id policy, and paginator kinds — everything the runtime needs to be fully generic. See [concepts](concepts.md) for the vocabulary those pieces map onto.

## The three published packages

The core idea is a single split: a **build-time reader** that turns your spec into a descriptor, and a **runtime** that is parameterised by that descriptor and does all the real work. Nothing is templated per endpoint — see [ADR 0001](https://github.com/haddowg/json-api-ts/blob/main/docs/adr/0001-generate-a-runtime-descriptor-not-per-endpoint-clients.md) for why.

| Package | Role |
| --- | --- |
| [`@haddowg/json-api-client`](../packages/client) | The generic, framework-agnostic runtime. |
| [`@haddowg/json-api-codegen`](../packages/codegen) | The build-time CLI. |
| [`@haddowg/json-api-query`](../packages/query) | TanStack Query bindings. |

### `@haddowg/json-api-client` — the runtime

The generic engine. It is parameterised by a descriptor and knows nothing about your specific API until one is baked in. It owns:

- the **transport seam** — a tiny `fetch`-shaped function `(req) => Promise<res>`, with a `fetch` adapter as the default, plus content negotiation and the `headers`/`onError`/`onResponse` hooks;
- **`materialise()`** — turning a compound wire document into the hydrated, flat resource graph (attributes and hydrated relations as own enumerable props, envelope on non-enumerable `$`-accessors, to-many values as augmented arrays);
- the **serialize-write** path — flat input in, JSON:API envelope out, with pointer remapping back to your flat paths on error;
- a **typed error model** (`JsonApiError` with status matchers);
- **atomic** operation batching; and
- an **optional normalized index** used by the query layer.

Its only runtime footprint is an *optional* `ajv` peer (for the validation seam — see [validation](validation.md)); it ships an `ajv` sub-path but never pulls it into the core dependency tree.

```ts
// The generated file re-exports a createClient bound to your descriptor;
// under the hood it delegates to the runtime's generic createClient.
import { createClient } from './api/music.gen'

const client = createClient({ baseUrl: 'https://music.example' })
```

### `@haddowg/json-api-codegen` — the CLI

The build-time half. It reads your served OpenAPI 3.1 document (and, optionally, the JSON Schema bundle) from a URL or a local file, builds an `ApiDescriptor`, and emits one committed `.gen.ts` file: the descriptor `as const`, the derived per-type interfaces, and a `createClient` bound to that descriptor. It depends on `@haddowg/json-api-client` (for the descriptor types it emits against) and `yaml` — nothing else. It is a **dev dependency**; the output it produces has no runtime tie back to the CLI. See [codegen](codegen.md) for the full flow.

### `@haddowg/json-api-query` — TanStack bindings

An optional layer on top of the runtime. It exposes query/mutation **option factories** (not pre-bound hooks) plus a deterministic key factory and `type:id` write-through normalization, so a single resource edit patches every cached query that holds it. It takes `@tanstack/query-core` as a **peer** dependency, which keeps it framework-neutral across React/Vue/Svelte/Solid. See [tanstack-query](tanstack-query.md).

!!! note "The core client stands alone"
    `await client.albums.list()` works with no TanStack in the tree. `json-api-query` is purely additive — reach for it when you want caching and normalization, skip it otherwise.

## The descriptor: the seam between codegen and runtime

Everything hinges on one artifact. The codegen emits a **runtime descriptor object** and derives the TypeScript types *from it* (one source of truth), rather than templating a method per OpenAPI operation:

```ts
export const resourceMap = { /* … */ } as const
export type Api = ApiFor<typeof resourceMap>
export const createClient = /* bound to resourceMap */
```

The descriptor carries what types alone cannot express at runtime — attribute-vs-relation, cardinality, related type(s), per-operation path templates (`uriType`/server-prefix aware), paginator kind, the create client-id policy, and per-relation mutation and endpoint-exposure flags. The runtime reads all of this generically.

Because the descriptor is the contract between the two packages, **its shape is load-bearing**: changing it is a breaking change across both. That coupling is the deliberate trade for a tiny, uniform, fully-generic runtime ([ADR 0001](https://github.com/haddowg/json-api-ts/blob/main/docs/adr/0001-generate-a-runtime-descriptor-not-per-endpoint-clients.md)).

## Where generated code lives

Generated code is committed into **your** repo — one file per server, à la `openapi-typescript` — not published as a package:

```
your-app/
  src/api/
    music.gen.ts          # descriptor + types + bound createClient
    music.schemas.gen.ts  # optional: the JSON Schema map for the validation seam
```

It imports `@haddowg/json-api-client` at runtime and is reviewable, diffable, and versioned like any other source. Regenerate it when the API changes.

!!! tip "One client per server"
    The spec is per-server. If your bundle exposes a `default` and an `admin` server, they differ in type-set and path prefix, so you generate a separate typed client for each.

You can see exactly what the codegen produces in both example workspaces: [`packages/example/src/generated/music-catalog.gen.ts`](../packages/example/src/generated/music-catalog.gen.ts) and [`examples/spotify-clone/src/generated/music-catalog.gen.ts`](../examples/spotify-clone/src/generated/music-catalog.gen.ts).

## The dependency posture

The rule is **minimal, shallow-tree, and either tiny or very actively maintained** — not dogmatic zero-dep ([ADR 0004](https://github.com/haddowg/json-api-ts/blob/main/docs/adr/0004-validation-and-dependency-posture.md)). The result is a shallow tree per package:

- **client** — no hard runtime deps; `ajv` is an *optional* peer for the opt-in validation seam.
- **codegen** — `yaml` plus the client (for descriptor types), build-time only.
- **query** — `@tanstack/query-core` as a peer.

A heavy or deep-tree dependency is rejected; a small, well-kept one is accepted when it earns its place. The intent is avoiding npm supply-chain exposure and bundle bloat.

## The example workspaces

Two non-published workspaces exercise the packages end to end:

- [`packages/example`](../packages/example) — the canonical, **tested** usage reference. Every snippet in [`example.test.ts`](../packages/example/src/example.test.ts) is a real typed call run under `pnpm test`, grouped by `describe(...)`, so it can't rot. This is the source of truth for API shape.
- [`examples/spotify-clone`](../examples/spotify-clone) — a full worked React + TanStack Query app over a mock transport, with feature pages, generated clients, and the query bindings wired in. See [example-app](example-app.md).

??? note "Going deeper: the toolchain"
    The monorepo is pnpm workspaces + Turborepo, with tsdown (rolldown; dual ESM/CJS + `.d.ts`), Vitest, oxlint/oxfmt, and tsc. Packaging is guarded in CI by `publint` and `@arethetypeswrong/cli` plus a dual ESM/CJS smoke test. Versioning is release-please in manifest mode, matching the PHP repos in the lineage. The build wiring lives at the repo root and in each package's `package.json`; the full development command list is in the [README](../README.md).

## See it in the example app

The [spotify-clone `client.ts`](../examples/spotify-clone/src/api/client.ts) shows the runtime and a generated client wired together against a mock transport — the smallest end-to-end picture of the two halves meeting.

## Next

- [concepts](concepts.md) — the vocabulary the descriptor is built on.
- [codegen](codegen.md) — how the spec becomes the descriptor and generated file.
- [tanstack-query](tanstack-query.md) — the optional caching and normalization layer.
