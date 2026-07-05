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

The input is typed against the generated create-attributes interface for the type (`AlbumsCreateAttributes` in the example) — required fields are required, enums are narrowed (`status` is the `AlbumStatus` union), and an unknown key is a type error. Any key the descriptor knows to be a **relation** is routed to `data.relationships` instead of `data.attributes`; writing relationships alongside attributes has its own page — see [relationship mutation](relationship-mutation.md).

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

    The same rules as [reads](includes-and-sparse-fieldsets.md) apply: an `include`d relation is hydrated in the result type; a sparse fieldset narrows which attributes come back.

## Update

`update` is a **partial patch** — send only the members you're changing. It returns the materialised, patched resource:

```ts
const updated = await client.albums.id('1').update({ title: 'OK Computer (Remaster)' })
updated.title // 'OK Computer (Remaster)'
```

The handle's `id` always wins as the document id, so you never repeat it in the patch body. Omitted keys are left untouched server-side (JSON:API PATCH semantics). The input is typed as a `Partial` of the type's write attributes.

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
