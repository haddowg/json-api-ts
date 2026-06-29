# @haddowg/json-api-codegen

The CLI (and programmatic API) that reads the
[`haddowg/json-api-symfony`](https://github.com/haddowg/json-api-symfony) OpenAPI 3.1 document and
emits a typed client: a runtime descriptor, per-type attribute interfaces, and a descriptor-bound
`createClient`. Optionally reads the bundle's JSON Schemas to emit a per-type schema map for the
[client's](../client) opt-in validation seam.

The OpenAPI document is fully self-describing for the runtime's needs — type identity
(`properties.type.const`), relationship cardinality and related types, the allowed `?include`
paths (a bounded, pre-expanded enum per endpoint), the create client-id policy, and paginator
kinds. The codegen only reads the spec; all real work is generic runtime machinery in
`@haddowg/json-api-client`.

## Install

A dev-only dependency — the **generated output** has no runtime tie back to the codegen (it imports
`@haddowg/json-api-client`).

```bash
pnpm add -D @haddowg/json-api-codegen
```

Two bin names are installed: `json-api-codegen` and the short alias `japi`.

## CLI

```bash
json-api-codegen --input <url|file> --output <file> [--server <name>] [--schemas <url|file>]
```

| Flag        | Required | Description                                                                           |
| ----------- | -------- | ------------------------------------------------------------------------------------- |
| `--input`   | yes      | OpenAPI document source — an http(s) URL or a local file path (JSON or YAML).         |
| `--output`  | yes      | Output file for the generated client (e.g. `src/api/music.gen.ts`).                   |
| `--server`  | no       | Server name to target. Metadata-only — the served document is already per-server.     |
| `--schemas` | no       | JSON Schema source (URL or path) for the validation seam. Omit to skip schema output. |

Example — generate against a served API, with the validation schemas:

```bash
json-api-codegen \
  --input https://music.example/docs.json \
  --output src/api/music.gen.ts \
  --schemas https://music.example/schemas.json
```

This writes:

- `src/api/music.gen.ts` — the typed client (descriptor + types + bound `createClient`);
- `src/api/music.schemas.gen.ts` — the per-type JSON Schema map (only with `--schemas`).

The schema artifact path is derived from `--output`: a `.gen.ts` suffix becomes `.schemas.gen.ts`,
a plain `.ts` becomes `.schemas.ts`.

> **Commit the generated files.** Like `openapi-typescript` / `graphql-codegen`, the output is one
> small, reviewable, diffable, versioned module in your repo — not a published package. Regenerate
> when the API changes.

### Multiple servers

The bundle serves one OpenAPI document per server (e.g. `default` and `admin` differ in their
type set and path prefix). Generate one client per server by pointing `--input` at each server's
document — one typed client per server.

## What it generates

The output module exports:

- `resourceMap` — the runtime descriptor (`as const`); what the [query](../query) package's
  normalization needs.
- `ResourceMap` — `typeof resourceMap`.
- `createClient(options)` — the descriptor-bound factory (the descriptor and the server's `atomic`
  capability are baked in; you supply only [`ClientOptions`](../client)).
- `Attributes` / `WriteAttributes` — the per-type attribute maps (read vs create/update).
- Per-type `…Attributes` / `…CreateAttributes` / `…UpdateAttributes` interfaces, enum types
  (e.g. `AlbumStatus`), and action input/output types.

With `--schemas`, the sibling module exports `schemas` — the per-type JSON Schema 2020-12 map.

```ts
import { createClient, type ResourceMap, resourceMap } from './api/music.gen'
import { schemas } from './api/music.schemas.gen'

const client = createClient({ baseUrl: 'https://music.example' })
```

### Verb / relation collisions

If a type has a relation named like a reserved verb on the resource handle (`get`, `update`,
`delete`, `rel`, `actions`, …), the codegen emits a **build-time warning** and that relation routes
through `.rel('name')` in the fluent client; the common case stays clean.

## Programmatic API

The same generation, callable from a script (`japi.config.ts`, a build step, etc.):

```ts
import { generate, type CodegenConfig } from '@haddowg/json-api-codegen'

const config: CodegenConfig = {
  input: 'https://music.example/docs.json',
  output: 'src/api/music.gen.ts',
  schemas: 'https://music.example/schemas.json', // optional
  server: 'default', // optional, metadata-only
}

await generate(config) // writes the output file(s); returns the client source string
```

Lower-level building blocks are also exported for advanced use: `readDocument` / `readSchemas`,
`buildDescriptor`, `emit`, `emitSchemas`, `detectVerbCollisions`, and `schemasOutputPath`.

## License

MIT
