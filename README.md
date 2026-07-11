# json-api-ts

A typesafe, **JSON:API-flavored** TypeScript client, generated from your API's OpenAPI 3.1
document.

> **Part of the [jsonapi.rest](https://jsonapi.rest) suite** — a complete, spec-compliant
> JSON:API 1.1 stack: a framework-agnostic PHP [core](https://github.com/haddowg/json-api), a
> [Symfony bundle](https://github.com/haddowg/json-api-symfony), a
> [Laravel package](https://github.com/haddowg/json-api-laravel), and this **typed TypeScript
> client**, bound together by one conformance-tested OpenAPI 3.1 contract.

You point the codegen at your API's `/docs.json`, commit the generated client into your repo, and
get a `createClient` whose every read and write is typed end to end — `?include` hydrates the
requested relations into the result type, sparse `fields` narrow it, and the wire envelope is
materialised into clean, flat resource objects. First-class **TanStack Query** bindings sit on
top, with `type:id` cache normalization, full reads and mutations, custom actions, Atomic
Operations, and opt-in per-field validation against your server's JSON Schemas.

## Packages

| Package                                           | Role                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`@haddowg/json-api-client`](./packages/client)   | Generic, framework-agnostic runtime, parameterised by a generated descriptor. |
| [`@haddowg/json-api-codegen`](./packages/codegen) | CLI: OpenAPI (+ JSON Schemas) → descriptor + types + bound `createClient`.    |
| [`@haddowg/json-api-query`](./packages/query)     | TanStack Query option/key factories + `type:id` normalization.                |

## Install

```bash
# Codegen is dev-only; the generated output has no runtime tie to it.
npm install -D @haddowg/json-api-codegen
npm install @haddowg/json-api-client @haddowg/json-api-query

# Read the served OpenAPI document and emit the typed client.
npx json-api-codegen --input https://your-api.example/docs.json --output src/api/client.gen.ts
```

## Documentation

The full documentation is published at **[haddowg.github.io/json-api-ts](https://haddowg.github.io/json-api-ts/)**.
Start with [Getting started](https://haddowg.github.io/json-api-ts/getting-started/), or browse
the [documentation index](https://haddowg.github.io/json-api-ts/).

The [`packages/example`](./packages/example) workspace is a worked, tested usage reference — every
snippet in the docs is a real typed call against the generated client, run under `pnpm test` so it
cannot rot.

## License

MIT
