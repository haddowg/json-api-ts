# json-api-ts — Build Plan

A TypeScript monorepo that generates a **JSON:API-flavored, fully typesafe client** from
the OpenAPI 3.1 spec emitted by the `haddowg/json-api-symfony` bundle.

> This is the _build roadmap_. The **design decisions and their rationale live in
> [`../CONTEXT.md`](../CONTEXT.md) and [`adr/`](adr/)** — this document does not repeat
> them; it sequences the work.

Lineage: `haddowg/json-api` (core PHP) → `haddowg/json-api-symfony` (emits the spec) →
`haddowg/json-api-ts` (consumes it).

---

## Core decision

Generate a **runtime descriptor with types derived from it — not per-endpoint client
code** (ADR 0001). JSON:API's wire shape is invariant, so all real work is generic
runtime machinery parameterised by the descriptor; the codegen only reads the spec.

The spec is self-describing for everything we need (verified against the live
music-catalog example, 56 paths / 175 schemas): type identity is `properties.type.const`;
relationships, cardinality and related type(s) come from each relationship component's
`data`; allowed `?include` paths are a bounded, pre-expanded enum per endpoint; the
create client-id policy is encoded in the create request (`id: false` / required /
optional). Only two `x-` extensions exist today (`x-enum-varnames`,
`x-enum-descriptions`).

---

## Packages

| Package                               | Role                                                                                                                                                    | Deps                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `@haddowg/json-api-client`            | Generic runtime: transport seam + `fetch` default, (de)serialise/materialise, typed errors, optional normalized index. Parameterised by the descriptor. | minimal, shallow-tree (ADR 0004) |
| `@haddowg/json-api-codegen`           | CLI: reads OpenAPI (+ JSON Schemas) from URL/file, emits descriptor + types + bound `createClient`.                                                     | build-time only                  |
| `@haddowg/json-api-query`             | TanStack bindings: query/mutation + key factories, `type:id` normalization glue.                                                                        | peer `@tanstack/query-core`      |
| `@haddowg/json-api-angular` _(later)_ | RxJS/injectable surface for non-TanStack users.                                                                                                         | peer `@angular/*`                |

Generated code is committed into the **user's** repo (one file / small dir), not a
published package. One typed client per server.

---

## Toolchain

Vite+'s underlying tools wired **directly** (not the alpha `vp` wrapper — migrate to it
once it's ≥1.0): **pnpm** workspaces · **Turborepo** · **tsdown** (rolldown; dual
ESM/CJS + `.d.ts`) · **Vitest** · **oxlint** + a formatter (Prettier as the stable
stand-in for the intended oxfmt; Biome is the alternative) · **tsc**. Versioning via
**release-please** (manifest + `node-workspace`), matching the PHP repos. CI = PR check
(install → lint/format/typecheck → test → build) + release (`npm publish --provenance`).

---

## Build phases

- **Phase 0 — Scaffold.** ✅ Monorepo, three package skeletons, CI + release workflows,
  release-please config, base TS/lint/format/test wiring, CONTEXT.md + ADRs 0001–0004.
- **Phase 1 — Codegen MVP.** Read the OpenAPI document (URL/file, JSON/YAML); build the
  `ApiDescriptor`; emit per-type attribute interfaces + relationship metadata
  (cardinality, related type(s), polymorphic sets) + id policy + per-operation paths +
  paginator kind. Emit the verb/relationship collision routing. Fixture: the saved
  music-catalog spec (`packages/codegen/test/fixtures/`).
- **Phase 2 — Client reads.** Transport + content negotiation; typed `JsonApiError`
  (status matchers + pointer remapping); `materialise()` (flatten + `$`-accessors +
  hydration + augmented arrays + `$edge`/`$pivot`); include-driven conditional return
  types; pagination (`$page` + `$next/$prev`); the fluent read surface
  (`list`/`get`/`.id().get`/`.rel.get`/`.rel.related`).
- **Phase 3 — Client writes.** Flat input → envelope; the fluent id-scoped builder
  (`create`/`update`/`delete`, relationship `add/remove/replace`/`set`); custom actions;
  the atomic transaction builder (type-in-object, `lid` refs).
- **Phase 4 — Normalization + TanStack (`json-api-query`).** Deterministic key factory;
  query/mutation option factories; Strategy 2 write-through patching; patch-vs-invalidate
  split; optimistic updates through the patch.
- **Phase 5 — Validation seam.** Opt-in `validate?` fed by the bundle's JSON Schemas
  (needs bundle endpoint B2); per-type, graceful, engine brought by the user.
- **Phase 6 — Polish & release.** Worked example against music-catalog, docs, dual
  ESM/CJS verified, publish `v0.1`.
- **Later.** `json-api-angular`; consider Strategy 1 normalization; adopt `vp` when ≥1.0.

---

## Bundle-side enrichment track (in `json-api-symfony` / core)

Sequenced **after** the TS scaffold; core-first as usual. Needed for full fidelity, not
for codegen to start.

1. **Type pivot `meta.pivot`** in the linkage identifier schemas as proper OAS (no `x-`
   extension) — unlocks typed `$pivot` (read + the writable `position`).
2. **Serve the JSON Schemas over HTTP** alongside `/docs.json`, behind the same expose
   gate / warmer / artifact-store, reusing `JsonSchemaFactory` (today CLI-only). Per
   server; aggregate `GET /schemas.json` (+ optional per-type) — the validation seam's
   source.

---

## Open questions

- Exact tool versions need a first `pnpm install` to lock (tsdown/oxfmt are 0.x — expect
  to pin precisely once resolved).
- Atomic error-pointer remapping carries an op-index prefix — confirm the
  `(opIndex, path)` shape when Phase 3 lands.
- Whether `json-api-angular` is wanted at all, or TanStack's Angular adapter suffices.
