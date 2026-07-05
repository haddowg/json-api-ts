# Client-side validation

Per-field validation of every wire resource against its JSON Schema is **opt-in**.
By default the client trusts the wire — it runs only light structural guards and
otherwise materialises whatever came back. Turn full validation on when you want a
hard boundary against a drifting or third-party server.

## The default: structural guards only

Out of the box the client validates the *envelope*, not the *fields*. Every parsed
response passes through a small always-on guard that asserts the body is a JSON:API
document and that each `data`/`included` member carries a string `type` (and, for a
full resource, an `id`). A body that isn't a JSON:API document, or a resource missing
its `type`, throws a `StructuralGuardError`.

That's it. Because the same OpenAPI spec generates both the server's output and this
client, the envelope is invariant — so the runtime doesn't pay to re-check every
attribute on every read. There is no validation engine in the client's dependency
tree until you add one.

!!! note "Why trust the wire by default?"
    We own both ends: the server serves the spec, the codegen consumes it. Full
    per-field validation by default would add cost for little benefit. It's there
    when you need it — e.g. validating against a server you don't control — and free
    when you don't (ADR 0004). See [errors](errors.md) for how a failure surfaces.

## Turning it on

Two steps: generate the schemas alongside the client, then pass a `validate` engine
to `createClient`.

### 1. Generate the schemas

Add `--schemas` to your codegen invocation. It writes a sibling `*.schemas.gen.ts`
next to the client output — a per-type map of the JSON Schemas the server serves
(from its `/schemas.json` endpoint):

```bash
json-api-codegen \
  --input https://music.example/docs.json \
  --output src/generated/music-catalog.gen.ts \
  --schemas https://music.example/schemas.json
# writes both music-catalog.gen.ts and music-catalog.schemas.gen.ts
```

The schema artifact exports a single `schemas` constant, keyed by JSON:API type. See
[codegen](codegen.md) for the full CLI reference.

### 2. Bring an engine and wire it up

The client ships an **ajv adapter** but does not depend on ajv — you bring the engine.
The adapter (`@haddowg/json-api-client/ajv`) turns a user-supplied ajv instance plus
the generated `schemas` map into the `validate` option:

```ts
import Ajv2020 from 'ajv/dist/2020'
import { createAjvValidator } from '@haddowg/json-api-client/ajv'
import { createClient } from './generated/music-catalog.gen'
import { schemas } from './generated/music-catalog.schemas.gen'

// The server emits JSON Schema 2020-12, so use `Ajv2020`. `strict: false` tolerates
// the schemas' `x-enum-*` annotations; `allErrors` aggregates every failing field.
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })

const client = createClient({
  baseUrl: 'https://music.example',
  validate: createAjvValidator(ajv, schemas),
})
```

Once configured, every resource in each response's `data` and `included` is validated
against its per-type schema at the seam — before it materialises into your result:

```ts
// The well-formed compound document passes validation (album + artist + 3 tracks)
// and materialises normally.
const album = await client.albums.get('1', { include: ['artist', 'tracks'] })
album.title // 'OK Computer'
```

A resource whose attributes don't match its schema is rejected. Here the schema says
`averageRating` is `number | null`, and a string violates it:

```ts
// data.attributes.averageRating = 'nine' — a string where the schema wants number|null
await client.albums.get('1') // rejects: AjvValidationError, message includes "schema validation"
```

The adapter throws an `AjvValidationError` aggregating every failing field into
`failures` (each with the resource `type`/`id`, ajv's `pointer` into the resource, the
failing `keyword`, and the `message`), with a summary message listing the failing
pointers. See [errors](errors.md) for catching and inspecting it.

!!! tip "ajv options that matter"
    - Use **`Ajv2020`** — the server emits the JSON Schema 2020-12 dialect.
    - **`strict: false`** tolerates the `x-enum-*` annotations the server attaches.
    - **`allErrors: true`** reports every failing field, not just the first.
    - Formats (`date-time`, `uuid`, `uri`, …) are **advisory**. ajv ignores unknown
      formats by default; to enforce them attach `ajv-formats`. The client's posture
      is to validate structure and types and trust the wire on format minutiae — the
      example turns format checks off with `validateFormats: false`.

## Going deeper

Everything above is enough to switch validation on. The rest is behaviour you can rely
on but rarely have to think about.

??? note "Per-type validation and graceful partial coverage"
    The schema-driven config (`{ schemas, validator }`) looks each resource's schema up
    by `resource.type` and validates against `schemas[type]`. A type the server does
    **not** cover is *skipped, not failed* — so a partially-covered schema bundle is fine;
    the resources it does describe are validated, the rest pass through. The `included`
    array is validated the same way, member by member, each against its own type's schema.

    Relationship-linkage endpoints return bare resource *identifiers* (`type` + `id`, no
    `attributes`/`relationships`). Those are covered by the structural guard, not the
    per-field validator — the per-type schema describes the full resource object, so
    running it over an identifier would spuriously fail. The validator only runs on
    members that actually carry `attributes` or `relationships`.

??? note "Going deeper: the bare-function seam (no per-type map)"
    `validate` accepts either the schema-driven config `{ schemas, validator }` **or** a
    bare `Validator` function `(resource, schema) => void`. The bare form owns schema
    lookup itself — the runtime calls it per resource with `schema` set to `undefined`,
    so the function decides everything (which schema, how to validate, whether to throw).
    Use it to plug in a validation strategy that isn't a simple per-type JSON Schema map.
    The `createAjvValidator` adapter is itself a bare validator: it compiles each schema
    once up front and looks the compiled function up by `resource.type` internally.

??? note "Going deeper: writing your own adapter"
    A `Validator` is just `(resource: WireResource, schema: unknown) => void` — throw on
    an invalid resource, return on a valid one. So any engine works: compile the
    generated `schemas` with your validator of choice and wrap it in that signature. The
    ajv adapter is the reference implementation — see [ajv.ts](../packages/client/src/ajv.ts)
    for the pattern (compile-once, look up by type, skip uncovered types, aggregate errors).

## See it in the example app

The tested worked reference is the `opt-in validation (ajv)` group in
[example.test.ts](../packages/example/src/example.test.ts) — it validates a good
compound read, and rejects a wrong-typed attribute, using exactly the snippets above.
The generated schema artifact those tests import is
[music-catalog.schemas.gen.ts](../packages/example/src/generated/music-catalog.schemas.gen.ts),
and the ajv adapter itself is [ajv.ts](../packages/client/src/ajv.ts).

## Next

- [codegen](codegen.md) — generate the client and the `--schemas` artifact.
- [errors](errors.md) — catch and inspect `StructuralGuardError` and `AjvValidationError`.
