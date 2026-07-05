# Relationship mutation

Change the *membership* of a relationship without touching the resource's attributes:
add or remove members of a to-many, replace it wholesale, or point a to-one at a
different resource. Every mutation runs through the id-scoped relationship builder and
sends only linkage on the wire.

## The builder

Reach a relationship through the resource handle, then name the relation:

```ts
client.<type>.id(id).rel(name)
```

That accessor exposes the mutation verbs the relation supports:

- **to-many** — `.add(refs)` (POST), `.remove(refs)` (DELETE), `.replace(refs)` (PATCH);
- **to-one** — `.set(ref | null)` (PATCH).

A ref is a bare identifier `{ type, id }` (or a hydrated resource — its `type`/`id` are
extracted for you). You pass an array to the to-many verbs, a single ref (or `null` to
clear) to `.set`.

```ts
// Add tracks to a playlist's to-many relationship.
await client.albums
  .id('1')
  .rel('tracks')
  .add([{ type: 'tracks', id: '4' }])

// Point an album's to-one `artist` at a different artist.
await client.albums.id('1').rel('artist').set({ type: 'artists', id: '2' })
```

Both examples are tested end to end in
[example.test.ts](../packages/example/src/example.test.ts) (the `relationship mutations`
group). A mutation resolves the materialised linkage, or `void` on a `204`.

!!! note "`.rel(name)` vs `handle.<name>`"
    `client.albums.id('1').tracks` reaches the same accessor as `.rel('tracks')`. Prefer
    `.rel(name)` when a relation's name collides with a reserved handle member
    (`get`/`update`/`delete`/`rel`/`actions`/`type`/`id`) — those are shadowed by the
    handle itself, so a relation of the same name is only reachable via `.rel(name)`.

## Replace: reordering and wholesale swaps

`.replace(refs)` PATCHes the *entire* set to exactly the refs you pass, in order. It is
the natural fit for a reorder — send the same members in their new positions:

```ts
await client.albums
  .id('1')
  .rel('tracks')
  .replace([
    { type: 'tracks', id: '1' },
    { type: 'tracks', id: '3' },
  ])
```

## The worked example: managing a playlist's tracks

The spotify-clone app manages a playlist's tracklist end to end through this builder. The
relevant relation is `playlists.orderedTracks` — a many-to-many with a **pivot** carrying
each edge's `position`. The three moves map straight onto the verbs:

- **add** a track picked from the catalogue → `.add([ref])`;
- **remove** a track → `.remove([{ type, id }])`;
- **reorder** (move up/down) → a wholesale `.replace(refs)` carrying each member's new
  position.

In the app these run through the TanStack Query mutation factories (so they patch the
cache optimistically), but the underlying calls are exactly the builder verbs above:

```ts
// examples/spotify-clone/src/pages/PlaylistDetailPage.tsx
const relTracks = writes.playlists.id(id).rel('orderedTracks')
const add = useMutation(relTracks.add({ optimistic: true }))
const remove = useMutation(relTracks.remove({ optimistic: true }))
const reorder = useMutation(relTracks.replace({ optimistic: true }))

// Move a track one slot: replace the whole set in the new order.
reorder.mutate(orderedRefs(next))
// Remove a track by identifier.
remove.mutate([{ type: 'tracks', id: track.id }])
```

The catalogue search that feeds `add` lives in
[TrackPicker.tsx](../examples/spotify-clone/src/components/TrackPicker.tsx) — see
[PlaylistDetailPage.tsx](../examples/spotify-clone/src/pages/PlaylistDetailPage.tsx) for
the full flow. How the mutation factories wire optimism and cache patching is covered on
the [TanStack Query](tanstack-query.md) page.

## Verb gating: only the verbs the endpoint advertises exist

The generated descriptor records which mutation verbs each relationship endpoint
advertises (the server's `cannotAdd` / `cannotRemove` / `cannotReplace`). The client
honours that on **both** surfaces:

- the static type of an unadvertised verb is `never` — calling it is a compile error;
- the runtime accessor omits the method entirely — it is genuinely absent, not just
  untyped (a plain-JS caller gets "not a function" rather than a `403` round-trip).

For example, `tracks.playlists` in the music catalogue advertises only `add` and
`remove`. Its `.replace` is `never` at the type level and absent at runtime:

```ts
// ✅ advertised
await client.tracks.id('1').rel('playlists').add([{ type: 'playlists', id: 'p1' }])

// ❌ compile error — `replace` is `never` for this relation (endpoint forbids it),
//    and there is no method to call at runtime either.
await client.tracks.id('1').rel('playlists').replace([/* … */])
```

Cardinality gates in the same way: a to-one relation exposes only `.set` (no
`add`/`remove`/`replace`), and a to-many exposes no `.set`. So the builder can only ever
offer the verbs that actually make sense for the relation.

??? note "Going deeper: how gating is resolved"
    Each relation in the descriptor carries an optional `mutations` block, e.g.

    ```ts
    orderedTracks: {
      cardinality: 'many',
      types: ['tracks'],
      pivot: true,
      mutations: { add: true, remove: true, replace: true },
      // …
    }
    ```

    The codegen populates it from each relationship endpoint's advertised HTTP methods
    (POST→`add`, DELETE→`remove`, PATCH→`replace` for a to-many; PATCH→`set` for a
    to-one). At the type level, `RelationMutation` gates each verb on its flag *and* on the
    verb's cardinality matching the relation's — see the `RelationshipAccessor` type in
    [result-types.ts](../packages/client/src/result-types.ts). At runtime,
    `relationshipAccessor` only attaches a method when the relation advertises it (see
    [client.ts](../packages/client/src/client.ts)). A relation with no `mutations` block
    at all (an older/hand-written descriptor) falls back to cardinality-only gating, so its
    verbs stay callable.

## Writing pivot data on a to-many edge

A `belongsToMany` relation with a pivot (like `playlists.orderedTracks`) lets each
membership carry per-edge fields — here `position` and `weight`. You supply them by
attaching a `$pivot` object to the ref; the runtime lifts it onto the wire identifier's
`meta.pivot`, and (when the codegen knows the relation's pivot fields) `$pivot` is typed
to exactly those fields:

```ts
await client.playlists
  .id(id)
  .rel('orderedTracks')
  .replace([
    { type: 'tracks', id: 't1', $pivot: { position: 1, weight: 1 } },
    { type: 'tracks', id: 't2', $pivot: { position: 2, weight: 2 } },
  ])
```

The spotify-clone app builds these refs in
[playlist-tracks.ts](../examples/spotify-clone/src/api/playlist-tracks.ts): `trackRef`
attaches `$pivot` to a hydrated track, and `orderedRefs` positions a whole array 1-based
for a reorder. Passing the full hydrated track (not a bare identifier) is deliberate —
the client sends only linkage + `$pivot` on the wire, but the extra props let the
optimistic row render its real title before the settle refetch.

!!! tip "Validation errors are keyed by the pivot path"
    A `422` on a pivot field comes back with its `source.pointer` remapped to the flat
    input path — e.g. `orderedTracks[0].$pivot.position` — so `error.byPath()` groups it
    under the ref you actually sent. See [errors](errors.md) for the error model.

## See it in the example app

- The tested reference: the `relationship mutations` group in
  [example.test.ts](../packages/example/src/example.test.ts) (add / replace / set).
- The worked flow: adding, removing and reordering tracks (with pivot `position`) in
  [PlaylistDetailPage.tsx](../examples/spotify-clone/src/pages/PlaylistDetailPage.tsx),
  with the ref builders in
  [playlist-tracks.ts](../examples/spotify-clone/src/api/playlist-tracks.ts).

## Next

- [Writes](writes.md) — create, update and delete resources (and set relationships inside a create/update).
- [Materialisation](materialisation.md) — how a mutation's linkage response, `$pivot` and augmented arrays are shaped.
- [TanStack Query](tanstack-query.md) — driving these mutations optimistically with automatic cache patching.
