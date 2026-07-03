# Custom actions

Some endpoints aren't CRUD — an album gets *reissued*, a collection gets *summarised*, a file gets *imported*. The bundle advertises these as custom actions in the OpenAPI document, the codegen records them in the descriptor, and the client exposes them as typed method calls whose input and output shapes are derived entirely from that descriptor.

## The two scopes

Every action is declared at one of two scopes, and you reach it accordingly:

```ts
// resource-scoped: POST /albums/{id}/-actions/reissue
await client.albums.id('1').actions.reissue(/* … */)

// collection-scoped: POST /albums/-actions/summary
await client.albums.actions.summary(/* … */)
```

A resource-scoped action hangs off the id handle's `.actions`; a collection-scoped one off the type accessor's `.actions`. An action declared at one scope is simply absent at the other — `client.albums.actions.reissue` (collection) is `undefined` because `reissue` is resource-scoped, so reach it via `.id(id)`.

!!! note "Actions are typed, not conjured"
    The `.actions` surface only contains the actions the API actually declares. Names, scopes, HTTP method, input mode and output mode all come from the generated descriptor, so calling an action that doesn't exist is a compile error, not a 404 at runtime.

## The simplest case: no input

Start with an action that takes nothing and hands back a meta object. `summary` is collection-scoped, `input: none`, `output: meta`:

```ts
// summary is collection-scoped: input none, output meta.
const summary = await client.albums.actions.summary()
// summary is the document's top-level meta, returned directly.
summary.totalAlbums // number
```

A meta-output action has no resource to materialise, so the client returns the response document's top-level `meta` verbatim. That's the whole call — no envelope to build, nothing to unwrap.

## Document in, document out

When an action takes a JSON:API document *and* names an `inputType`, you pass **flat attributes** exactly as you would to `create`, and the client builds the `{ data: { type, attributes } }` envelope for you. When it returns a document, the client **materialises** the response into a flattened resource — so you read `result.title`, not `result.data.attributes.title`.

`reissue` is resource-scoped, `input: document`, `output: document`:

```ts
// Flat input, like create — the client wraps it into the JSON:API envelope.
const reissued = await client.albums.id('1').actions.reissue({
  title: 'OK Computer',
})

// The 2xx document is materialised into a flat resource.
reissued.id    // '1'
reissued.title // 'OK Computer'
```

Because the input envelope is built the same way `create` builds it, validation errors come back the same way too: a `422` is remapped from server pointers (`/data/attributes/title`) to your flat input keys, so `error.byPath()['title']` finds them. See [writes](writes.md) for the flat-input / `byPath()` model in full, and [errors](errors.md) for the `JsonApiError` API.

!!! tip "Where the shapes come from"
    A document-output action's result is typed as the materialised `ReadResult` of its `outputType` — identical to what a read of that type returns. A document-input action's argument is the flat `CreateInput` of its `inputType`. Both are read off the descriptor, not invented per action, so the typed contract matches exactly what the client sends and receives ([ADR 0005](https://github.com/haddowg/json-api-ts/blob/main/docs/adr/0005-derive-the-custom-action-surface-from-the-descriptor.md)).

## Going deeper

Most actions are one of the shapes above. The remaining modes and edge cases are below.

??? note "Going deeper: raw (non-JSON:API) input"
    An action can declare `input: raw` when its body isn't a JSON:API document — a file upload, a CSV, a bespoke command payload. The client sends your payload verbatim with the action's declared media type (`contentType`, e.g. `application/octet-stream`), falling back to a wildcard `*/*` only when the spec declared none:

    music-catalog's `artwork` action is exactly this — resource-scoped on albums, `input: raw`, `output: none`, `contentType: application/octet-stream`:

    ```ts
    // input: raw — the payload is sent as-is under the action's declared Content-Type.
    await client.albums.id('1').actions.artwork(pngBytes)
    ```

    Raw input is *not* wrapped in an envelope and *not* pointer-remapped — it's a pass-through, so a `422` from a raw action surfaces unremapped.

??? note "Going deeper: a bespoke command document"
    A `document`-input action whose `inputType` isn't a registered resource type has no envelope to build for you. In that case you pass the JSON:API document verbatim and the client sends it through unchanged (no flat-input convenience, no pointer remap). This is the escape hatch for command-style bodies that don't map onto a resource's attributes.

??? note "Going deeper: no output (204)"
    An `output: none` action resolves to `undefined` (a `204` / empty body) — a fire-and-forget command. `output: document` with `outputCardinality: many` materialises to an augmented collection instead of a single resource.

??? note "Going deeper: non-POST methods"
    Actions default to `POST`. An action declaring a single non-POST method (e.g. `#[AsJsonApiAction(methods: ['PATCH'])]`) records that `method` in the descriptor and the client dispatches over it — so a `PATCH`-only action stays reachable rather than being silently dropped. You still call it the same way; the verb is handled for you.

## See it in the example app

The tested reference lives in [`example.test.ts`](../packages/example/src/example.test.ts) under `describe('custom actions', …)`: the resource-scoped `reissue` (document in, document out) and the collection-scoped `summary` (no input, meta out) are both real typed calls run under `pnpm test`. The rationale for deriving the whole surface from the descriptor — including why a regenerated old client can be a breaking change to its actions — is in [ADR 0005](https://github.com/haddowg/json-api-ts/blob/main/docs/adr/0005-derive-the-custom-action-surface-from-the-descriptor.md).

## Next

- [writes](writes.md) — the flat-input model document-input actions reuse.
- [errors](errors.md) — `JsonApiError`, `isUnprocessable()`, and `byPath()`.
- [atomic-operations](atomic-operations.md) — batching several writes all-or-nothing.
