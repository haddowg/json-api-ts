# json-api-ts

A typesafe, **JSON:API-flavored** TypeScript client, generated from the OpenAPI 3.1 spec
emitted by the [`haddowg/json-api-symfony`](https://github.com/haddowg/json-api-symfony)
bundle.

- **Typesafe (de)serialisation of resources and relationships**, including `?include` /
  compound documents — requested relationships are hydrated in the result type; the rest
  stay resource identifiers.
- **Framework-agnostic core** with a tiny `fetch`-shaped transport seam; first-class
  **TanStack Query** bindings on top.
- **`type:id` cache normalization** — edit a resource once, every cached query updates.
- Full **reads and mutations**, custom actions, and Atomic Operations.

> Status: **scaffolding / pre-v1.** The design is settled (see
> [`CONTEXT.md`](./CONTEXT.md) and [`docs/adr/`](./docs/adr/)); the build is sequenced in
> [`docs/PLAN.md`](./docs/PLAN.md).

## Packages

| Package                                           | Role                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| [`@haddowg/json-api-client`](./packages/client)   | Generic runtime, parameterised by a generated descriptor.                  |
| [`@haddowg/json-api-codegen`](./packages/codegen) | CLI: OpenAPI (+ JSON Schemas) → descriptor + types + bound `createClient`. |
| [`@haddowg/json-api-query`](./packages/query)     | TanStack Query bindings + normalization.                                   |

## Development

```bash
pnpm install          # resolves + locks the toolchain (commit pnpm-lock.yaml)
pnpm build            # turbo: build every package (tsdown → dual ESM/CJS + .d.ts)
pnpm typecheck        # turbo: tsc --noEmit per package
pnpm test             # vitest, whole workspace
pnpm lint             # oxlint
pnpm format           # prettier --write
pnpm check            # lint + format:check + typecheck
```

> The pinned tool versions in `package.json` are **starting points** — run `pnpm install` to resolve and commit the lockfile. `tsdown` (and, if adopted, `oxfmt`) are `0.x`; pin them exactly once resolved.

## License

MIT
