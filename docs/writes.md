# Writing

Creating, updating, and deleting resources. You pass a **flat attributes object** and the client builds the JSON:API write envelope for you — no `data`, no `attributes` wrapper, no `type` to repeat. The response is [materialised](materialisation.md) back into a clean resource object exactly like a read.

## The three verbs

```ts
// Create — flat input, POST /albums. Returns the materialised 201 response.
const created = await client.albums.create({ title: 'Kid A', status: 'released' })
created.id // '10' — the server-assigned id

// Update — partial patch, PATCH /albums/10. Send only the keys you're changing.
await client.albums.id('10').update({ title: 'OK Computer (Remaster)' })

// Delete — DELETE /albums/10. Resolves void on a 204.
await client.albums.id('10').delete()
```

Creates live on the **type accessor** (`client.<type>`); updates and deletes live on the **id-scoped handle** (`client.<type>.id(id)`). The handle does not fetch — it is just an addressed builder.

!!! tip "Flat in, flat out"
    Input is flat because the accessor already names the type. `client.albums.create({...})` sends `{ data: { type: 'albums', attributes: {...} } }` on the wire, and the 201 response comes back materialised into the same flat shape you read with — `created.title` is a typed `string`, not `created.attributes.title`. See [materialisation](materialisation.md) for the full resource-object shape.

## Create

`create` takes the type's flat write attributes and returns the materialised resource, with its **server-assigned id** populated:

```ts
const created = await client.albums.create({ title: 'Kid A', status: 'released' })
expect(created.id).toBe('10')
expect(created.title).toBe('Kid A')
```

The input is typed against the generated create-attributes interface for the type (`AlbumsCreateAttributes` in the example) — required fields are required, enums are narrowed (`status` is the `AlbumStatus` union), and an unknown key is a type error. Any key the descriptor knows to be a **relation** is routed to `data.relationships` instead of `data.attributes`; writing relationships alongside attributes has its own page — see [relationship mutation](relationship-mutation.md). A [write-only relation](codegen.md#write-only-relations), one the server accepts but never renders, is settable here like any other, though it never appears on the result.

### The client-id policy

Whether you may (or must) supply an `id` on create is fixed per type by the API's spec and baked into the descriptor as one of three policies:

| `clientId` | Behaviour |
| ---------- | --------- |
| `forbidden` | Any `id` you pass is **dropped** — the server assigns it. |
| `optional` | An `id` you pass is sent through; omit it and the server assigns one. |
| `required` | You **must** supply an `id`. |

The client enforces this when it builds the document: under `forbidden` an `id` in your input is silently stripped, otherwise a string `id` is passed through as `data.id`. Most resources are `forbidden` (server-assigned); a type that expects a client-chosen id will be `required` in its descriptor and typed accordingly.

??? note "Going deeper: shaping the create response with include/fields"
    Like a read, a write's response is a JSON:API document — so `create` (and `update`) accept an optional second argument to narrow it with `include` and sparse `fields`:

    ```ts
    const created = await client.albums.create(
      { title: 'Kid A', status: 'released' },
      { include: ['artist'], fields: { albums: ['title', 'status', 'artist'] } },
    )
    created.artist?.name // hydrated in the create response
    ```

    The same rules as [reads](includes-and-sparse-fieldsets.md) apply: an `include`d relation is hydrated in the result type; a sparse fieldset narrows which attributes come back. Where the write documents it, `withCount` counts the written resource's relations, read back with `$count` (see [counting relationships](pagination.md#counting-relationships-with-withcount)). Where it documents `relatedQuery`, that filters and sorts the written resource's relationships as a read's does, keyed by relation name (see [relationship queries](filtering-and-sorting.md#relationship-queries)). The client names the profiles these need in `Accept` only.

## Update

`update` is a **partial patch** — send only the members you're changing. It returns the materialised, patched resource:

```ts
const updated = await client.albums.id('1').update({ title: 'OK Computer (Remaster)' })
updated.title // 'OK Computer (Remaster)'
```

The handle's `id` always wins as the document id, so you never repeat it in the patch body. Omitted keys are left untouched server-side (JSON:API PATCH semantics). The input is typed as a `Partial` of the type's write attributes.

## Writes accepted for later

A server can accept a create or update for later and answer `202 Accepted` with a job to poll. The codegen reads the `202` from the spec, so only the writes that declare one change type: they resolve to their usual result or an `Accepted` job, and `isAccepted()` tells them apart.

```ts
import { isAccepted } from '@haddowg/json-api-client'

const result = await client['catalog-exports'].create({ format: 'csv' })
if (isAccepted(result)) {
  result.job.state // the materialised export-jobs resource
  result.contentLocation // the job URL, from Content-Location
  result.retryAfter // seconds to wait, from Retry-After, or undefined
  const created = await result.$poll({ timeout: 60_000 })
}
```

The job is the job type's resource when the API declares that type, an open record when it doesn't, and the document's top-level `meta` when the server answers with a meta-only document. `retryAfter` reads `Retry-After` as delta-seconds or an HTTP date, counted from when the response arrived.

Pass `wait` to poll straight away, and the call resolves to the plain result:

```ts
const created = await client['catalog-exports'].create(
  { format: 'csv' },
  { wait: { timeout: 60_000, signal: controller.signal } },
)
```

`wait: true` polls with the defaults. `$poll()` and `wait` take the same options: `timeout` in milliseconds, five minutes by default, and an `AbortSignal`. A poll is a `GET` on `contentLocation`:

- an answer holding the job means the job is pending, so the client waits for that answer's `Retry-After`, else the `202`'s, else a second, and polls again;
- a `303` means the job is done. The `fetch` transport follows it, so any other `2xx` is the finished result. A transport that hands back the `303` gets its `Location` fetched;
- a non-2xx throws the usual [`JsonApiError`](errors.md). The client has no hook for a failed job: the server reports one as an HTTP error;
- a job still pending at the timeout rejects with a `PollTimeoutError`, and an abort rejects with the signal's reason, as an aborted request does.

The finished result is the resource the job URL ends at, so the write's `include` and `fields` don't reach it. A call with `wait` is typed without them, and so is `$poll()`.

A `202` on an operation whose spec doesn't declare one isn't treated as a job: the client materialises the answer as before.

## Delete

`delete` sends `DELETE /{type}/{id}` and resolves `void` on the server's `204`:

```ts
const result = await client.albums.id('1').delete()
result // undefined
```

There is no body and no response to materialise.

## Errors surface by your flat input path

Because the client owns the envelope, it also **inverts the error back**. A failed write throws a typed [`JsonApiError`](errors.md); each error's raw `source.pointer` (a wire path like `/data/attributes/title`) is remapped to the **flat input key you actually supplied**, so `byPath()` groups violations by the shape of your input — ideal for driving form field errors.

```ts
const error = (await client.albums.create({ title: '' }).catch((e) => e)) as JsonApiError

error.isUnprocessable() // true (a 422 / validation error)
// The wire pointer `/data/attributes/title` is remapped to the flat key `title`.
error.byPath()['title']?.[0]?.detail // 'must not be blank'
```

The remapping is descriptor-aware, so it understands nesting: a nested map attribute (`/data/attributes/releaseInfo/label`) becomes `releaseInfo.label`, a relationship (`/data/relationships/artist/data`) becomes `artist`, and a client-id conflict (`/data/id`) stays `id`. Query-side errors (a bad `filter[x]`) already carry `source.parameter` and are left as-is. The raw `source.pointer` stays on every error object as an escape hatch. See [error handling](errors.md) for the full status matchers and `byPath()` contract.

!!! warning "Server-side validation, not client-side"
    A `422` comes from the API validating your write (the server's [validation](validation.md) rules). The client does **not** run those checks before sending — it trusts the types and lets the server be the authority. The opt-in client-side [validation seam](validation.md) validates *wire responses*, not your write input.

## See it in the example app

- The tested writes group in [example.test.ts](../packages/example/src/example.test.ts) (`describe('writes', …)`) covers create → 201, partial update, `204` delete, and the `byPath()` remap — every snippet on this page is drawn from it.
- [PlaylistsPage.tsx](../examples/spotify-clone/src/pages/PlaylistsPage.tsx) drives `writes.playlists.create()` from a form; [PlaylistDetailPage.tsx](../examples/spotify-clone/src/pages/PlaylistDetailPage.tsx) drives an optimistic `update` — both through the [TanStack Query](tanstack-query.md) mutation option factories over the same underlying `client.<type>` verbs.
- The per-type `clientId` policy is visible in [the generated descriptor](../packages/example/src/generated/music-catalog.gen.ts) (each type's `clientId` field).

## Next

- [Relationship mutation](relationship-mutation.md) — writing to-one and to-many relations, standalone and embedded in a resource write.
- [Custom actions](custom-actions.md) — non-CRUD, resource- and collection-scoped operations.
- [Error handling](errors.md) — `JsonApiError`, status matchers, and `byPath()`.
