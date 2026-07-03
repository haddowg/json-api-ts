# Atomic operations

Run several writes as one all-or-nothing batch with `client.atomic(tx => [...])`. The whole batch commits together or nothing does, a later operation can reference a resource an earlier one just created, and each result comes back typed in the position you asked for.

## A two-operation batch

Pass a callback to `client.atomic`. It receives a recorder (`tx`) whose `create`, `update` and `delete` methods each record one operation, in order. Because one recorder spans every type, each operation carries its own `type` discriminant in the object you hand it — exactly the flat input shape a standalone [write](writes.md) takes, plus that `type`.

```ts
const [artist, album] = await client.atomic((tx) => {
  const a = tx.create({ type: 'artists', name: 'Boards of Canada' })
  const b = tx.create({ type: 'albums', title: 'Geogaddi' })
  return [a, b] as const
})

artist.data.type // 'artists' — typed
album.data.title // 'Geogaddi' — typed
```

The callback returns the handles it wants results for (`as const` keeps the tuple positional). Each handle resolves to its own materialised result — `{ data, meta? }`, where `data` is the created/updated resource, materialised exactly as a read would be. A `create`/`update` handle types its `data` as the resource of its type; a `delete` handle resolves to `undefined` (a delete carries no data).

!!! note "The result tuple follows what you return"
    Results are resolved by each returned handle's operation index, not by callback order, so the tuple is sound whichever handles you return and in whatever order. Return nothing at all and you get the loose, ordered `AtomicResult[]` instead.

## Building operations

Each recorder method mirrors a standalone write:

```ts
await client.atomic((tx) => {
  tx.create({ type: 'artists', name: 'Aphex Twin' })
  tx.update({ type: 'albums', id: '100', title: 'Drukqs (Remaster)' })
  tx.delete({ type: 'albums', id: '101' })
})
```

- `tx.create({ type, ...fields })` records an `add`. Attributes and relationships route through the same serialisation as a `POST /{type}` body.
- `tx.update({ type, id, ...fields })` records an `update` against the existing resource.
- `tx.delete({ type, id })` records a `remove`. It also accepts a resource identifier or a materialised resource (its `{ type, id }` is extracted).

The batch is posted as one request — `{ "atomic:operations": [...] }` to the server's `/operations` endpoint — and the server's `{ "atomic:results": [...] }` is parsed back positionally.

!!! tip "The atomic capability is threaded in for you"
    The generated `createClient` bakes in whether the server exposes atomic operations, so `client.atomic` is available with no extra wiring. Under the hood the batch negotiates the atomic extension media type (`application/vnd.api+json; ext="https://jsonapi.org/ext/atomic"`) on both `Content-Type` and `Accept`.

## Cross-operation references by `lid`

A `tx.create` handle doubles as a `{ type, lid }` relationship reference. Drop it (or spread it) into a later operation's relation slot and that operation wires to the just-created resource — no server-assigned id needed yet, because the whole batch commits together.

```ts
const [artist, geogaddi] = await client.atomic((tx) => {
  const newArtist = tx.create({ type: 'artists', name: 'Boards of Canada' })
  // `newArtist` is a { type, lid } ref — the album's `artist` relation points at it.
  const newAlbum = tx.create({ type: 'albums', title: 'Geogaddi', artist: newArtist })
  return [newArtist, newAlbum] as const
})

artist.data.id // '99' — the server-assigned id, now real
geogaddi.data.title // 'Geogaddi'
```

On the wire the first operation carries a generated local id and the second references it:

```json
{ "atomic:operations": [
  { "op": "add", "data": { "type": "artists", "lid": "atomic-0", "attributes": { "name": "Boards of Canada" } } },
  { "op": "add", "data": { "type": "albums", "attributes": { "title": "Geogaddi" },
    "relationships": { "artist": { "data": { "type": "artists", "lid": "atomic-0" } } } } }
] }
```

Each create's `lid` is deterministic — `atomic-<opIndex>` — so it is stable and human-readable across the batch. This is the tested snippet in [example.test.ts](../packages/example/src/example.test.ts) (the `atomic operations` block).

??? note "Going deeper: targeting a same-batch resource with update / delete"
    An `update` or `delete` can also target a resource created earlier in the same batch by passing `lid` instead of `id`. Pass the create handle to `tx.delete`, or give `tx.update` a `lid` — the recorder rides the local id, never a (not-yet-existing) server id.

    ```ts
    await client.atomic((tx) => {
      const draft = tx.create({ type: 'albums', title: 'Untitled' })
      tx.update({ type: 'albums', lid: draft.lid, title: 'Music Has the Right to Children' })
      // or discard it entirely: tx.delete(draft)
    })
    ```

## When a batch fails

An atomic batch is all-or-nothing: if one operation is rejected the whole batch rolls back and `client.atomic` throws a single [`JsonApiError`](errors.md). Because the client built the envelope, it inverts each error's `source.pointer` back to *which operation* failed and *which flat field* within it.

```ts
try {
  await client.atomic((tx) => {
    tx.create({ type: 'artists', name: 'Boards of Canada' })
    tx.create({ type: 'albums', title: '' }) // fails validation
  })
} catch (error) {
  if (error instanceof JsonApiError) {
    for (const e of error.errors) {
      e.opIndex // 1 — the failing operation's zero-based index in the batch
      e.path // 'title' — the flat input path within that operation
    }
  }
}
```

The server points at `/atomic:operations/{n}/data/attributes/title`; the client strips the `atomic:operations/{n}` prefix to recover the numeric `opIndex`, then inverts the remaining `/data/...` tail to the flat path using *that operation's* type. Both `opIndex` and `path` sit on each `JsonApiErrorObject` (the raw `source.pointer` stays too, as an escape hatch).

!!! warning "Errors are per operation, not per handle"
    `opIndex` is the operation's position in the recorded batch — the order you *called* the recorder — which is independent of the order you *returned* handles for the result tuple. See [errors.md](errors.md) for the full error model, the status matchers, and `byPath()` grouping.

## See it in the example app

- [example.test.ts](../packages/example/src/example.test.ts) — the tested `atomic operations` block: the artist + album batch with a cross-op `lid` reference, typed positionally.
- [atomic.ts](../packages/client/src/atomic.ts) — the transaction builder itself: the recorder, the `lid` generation, and the error-pointer remap.

## Next

- [writes.md](writes.md) — the standalone create / update / delete surface each operation mirrors.
- [errors.md](errors.md) — the `JsonApiError` model and how atomic pointers remap to `(opIndex, path)`.
- [custom-actions.md](custom-actions.md) — the other write-shaped surface the generated client threads in.
