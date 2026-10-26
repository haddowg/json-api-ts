# Custom actions

Some endpoints aren't CRUD — an album gets *reissued*, a collection gets *summarised*, a file gets *imported*. The server advertises these as custom actions in the OpenAPI document, the codegen records them in the descriptor, and the client exposes them as typed method calls whose input and output shapes are derived entirely from that descriptor.

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

    A string is sent as text, a `Blob`, `ArrayBuffer`, typed array, `FormData` or `URLSearchParams` as is, and anything else as JSON.

    Raw input is *not* wrapped in an envelope and *not* pointer-remapped — it's a pass-through, so a `422` from a raw action surfaces unremapped.

??? note "Going deeper: the Content-Type of a bodyless POST"
    A JSON:API server answers `415` to a `POST` that doesn't send `Content-Type: application/vnd.api+json`, even when it has no body. So an action without input still sends it when it's a `POST`. `PATCH`, `PUT` and `DELETE` send it only with a body.

??? note "Going deeper: a bespoke command document"
    A `document`-input action whose `inputType` isn't a registered resource type has no envelope to build for you. In that case you pass the JSON:API document verbatim and the client sends it through unchanged (no flat-input convenience, no pointer remap). This is the escape hatch for command-style bodies that don't map onto a resource's attributes.

??? note "Going deeper: no output (204)"
    An `output: none` action resolves to `undefined` (a `204` / empty body) — a fire-and-forget command. `output: document` with `outputCardinality: many` materialises to an augmented collection instead of a single resource.

??? note "Going deeper: non-POST methods"
    Actions default to `POST`. An action declaring a single non-POST method (e.g. `#[AsJsonApiAction(methods: ['PATCH'])]`) records that `method` in the descriptor and the client dispatches over it — so a `PATCH`-only action stays reachable rather than being silently dropped. You still call it the same way; the verb is handled for you.

## Raw responses

An action can answer in media types other than JSON:API, such as a CSV export, a PDF or an image, beside its JSON:API response or instead of it. Pick one with `accept`. The client sends it as the `Accept` header and types the result by the media type:

```ts
// GET /articles/-actions/report answers in JSON:API, text/csv, application/pdf or application/json.
const meta = await client.articles.actions.report() // JSON:API: the document's meta
const csv = await client.articles.actions.report({ accept: 'text/csv' }) // string
const pdf = await client.articles.actions.report({ accept: 'application/pdf' }) // Blob
const bytes = await client.articles.actions.report({
  accept: 'application/pdf',
  responseType: 'arrayBuffer',
}) // ArrayBuffer
const summary = await client.articles.actions.report({ accept: 'application/json' }) // ArticleSummary

// GET /articles/{id}/-actions/cover answers only in image/png, so that's the default.
const cover = await client.articles.id('art-1').actions.cover() // Blob
```

`accept` takes only the media types the action declares. Without it the client asks for JSON:API whenever the action declares a JSON:API response, so an action that gains a raw response keeps its existing calls. A text media type resolves to a `string`, a binary one to a `Blob` (or an `ArrayBuffer` with `responseType: 'arrayBuffer'`), and a JSON one to the parsed value, typed from its schema. An error is still a JSON:API document and still throws a [`JsonApiError`](errors.md), whatever you asked for.

A custom [transport](getting-started.md) has to honour `responseType` for binary media types: read a successful response into `binary` instead of `body`. The `fetch` transport and the Angular `httpClientTransport` do.

## Request media types

An action can accept several request media types. Pick one with `contentType`, and the body is typed by it:

```ts
// POST /articles/-actions/import accepts text/csv, image/*, multipart/form-data and application/json.
await client.articles.actions.import('id,title\n1,Hello\n') // the first listed: text/csv
await client.articles.actions.import(csvFile) // a text type also takes a picked Blob or File
await client.articles.actions.import(pngBlob, { contentType: 'image/png' }) // Blob, ArrayBuffer or Uint8Array
await client.articles.actions.import(form, { contentType: 'multipart/form-data' }) // FormData
await client.articles.actions.import({ total: 3 }, { contentType: 'application/json' }) // typed from its schema, unknown for {}
```

A wildcard such as `image/*` takes any concrete `image/…` type. Without `contentType` the client sends JSON:API when the action lists it, building the document from flat input as usual, else the first listed type. A multipart body goes out without a `Content-Type` of its own, so the transport can write the boundary. A custom transport has to send `rawBody` as is for binary, multipart and URL-encoded bodies.

### Form fields

When a multipart or URL-encoded body's schema lists `properties`, the codegen types its fields and you can pass a plain object. The client builds the `FormData` or `URLSearchParams` for you. A ready `FormData` or `URLSearchParams` is still accepted.

```ts
// multipart/form-data with properties title (required), cover (format: binary) and tags (array).
await client.articles.actions.import(
  { title: 'Spring list', cover: pngFile, tags: ['new', 'featured'] },
  { contentType: 'multipart/form-data' },
)
```

Required fields follow the schema's `required`, and the rest are optional. A `format: binary` field takes a `Blob` or `File`. A `File` keeps its name, and a bare `Blob` is named after its field. Numbers are sent as text and booleans as `true` or `false`. Each item of an array goes out as its own `name[]` entry, the bracketed form PHP servers read as a list, and a `null` or `undefined` field is left out. A schema with `additionalProperties` adds an index signature for the extra fields. A schema with no `properties` keeps the body a plain `FormData`. The same rules apply to an action whose only request body is multipart or URL-encoded. The PHP client takes the same fields as an array and encodes them the same way.

## See it in the example app

The tested reference lives in [`example.test.ts`](../packages/example/src/example.test.ts) under `describe('custom actions', …)`: the resource-scoped `reissue` (document in, document out) and the collection-scoped `summary` (no input, meta out) are both real typed calls run under `pnpm test`. The rationale for deriving the whole surface from the descriptor — including why a regenerated old client can be a breaking change to its actions — is in [ADR 0005](https://github.com/haddowg/json-api-ts/blob/main/docs/adr/0005-derive-the-custom-action-surface-from-the-descriptor.md).

## Next

- [writes](writes.md) — the flat-input model document-input actions reuse.
- [errors](errors.md) — `JsonApiError`, `isUnprocessable()`, and `byPath()`.
- [atomic-operations](atomic-operations.md) — batching several writes all-or-nothing.
