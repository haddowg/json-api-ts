# Includes and sparse fieldsets

`include` and `fields` are where the typing pays off. Both are ordinary JSON:API query
parameters — but because the client is generated from your API's spec, each one reshapes the
**result type** as well as the request. An `include` hydrates the named relations into typed
nested resources; a sparse `fields` narrows the attributes and relations present on the result.
Neither needs a cast.

If you haven't yet, read [reading](reads.md) first — this page assumes you know `list` / `get`
and how a materialised resource is shaped.

## Include a relation

Pass `include` an array of relation names. Each one is **hydrated**: it widens from a bare
resource identifier to the full related resource in the returned value.

```ts
// GET /albums/1?include=artist
const album = await client.albums.get('1', { include: ['artist'] })

album.title // typed string
album.artist?.name // hydrated — `artist` is a full Artist resource, not an identifier
```

The magic is the type. Because `include` is captured as a `const` tuple at the call site, the
return type is **conditional on that tuple**: the relations you named become hydrated resources;
every other relation stays a resource identifier (`{ type, id }`) — or `undefined` for a
links-only relation that carried no linkage. So `album.artist.name` type-checks precisely
because `'artist'` is in the `include`, and would not if it weren't.

!!! note "`include` values are constrained to what the server advertises"
    The element type of `include` is the descriptor's `includable` enum for that type — the
    exact set of paths the API exposes. A relation the server won't include is a **compile
    error**, mirroring its `400 INCLUSION_NOT_ALLOWED`. A type that advertises nothing
    includable types `include` as `never`, so you can't pass it at all.

## Narrow with sparse fieldsets

`fields` is a per-type map from a wire type to the member names you want for it. It narrows the
result type to exactly those members — everything else is **statically absent**, matching the
server, which only emits the requested members.

```ts
// GET /albums?include=artist&fields[albums]=title,status,artist
const albums = await client.albums.list({
  include: ['artist'],
  fields: { albums: ['title', 'status', 'artist'] },
})

albums[0]!.title // present — requested
albums[0]!.artist?.name // present — `artist` was requested (and included)
// albums[0]!.releasedAt      // TYPE ERROR — not in fields[albums]
```

Relations are sparse-fieldset members too. Note the interaction with `include`:

!!! warning "A relation you `include` must also stay in its `fields` list"
    A sparse fieldset drops any member you don't name — **including relations**. So if you both
    `include: ['artist']` and narrow `fields: { albums: [...] }`, `artist` has to appear in that
    list, or it's narrowed off the type despite being hydrated on the wire. In the snippet above,
    `artist` is kept in `fields[albums]` for exactly this reason.

The complete tested version of this list-with-include-and-fields read — request URL, materialised
result, and `$page` — is the first `reads` case in
[example.test.ts](../packages/example/src/example.test.ts).

## A compound `get`

`get` on a single resource takes the same `include` (and `fields`). One request, the whole graph:

```ts
// GET /albums/1?include=artist,tracks
const album = await client.albums.get('1', { include: ['artist', 'tracks'] })

album.title // string
album.artist?.name // hydrated to-one
album.tracks.length // hydrated to-many — an augmented array of Track resources
album.tracks[0]!.title // each member is typed, no cast
```

A to-one you include is `Resource | null` (an empty to-one materialises to `null`, even when
included). A to-many you include is a `Collection` of hydrated members — the same augmented array
model used for top-level collections, so it still carries `$page` / `$links` / `$meta` and
`$next()` / `$prev()`. A to-many you *don't* include stays a `Collection`, but of identifiers.

This is exactly what the spotify-clone's album page does — the album, its artist, and its full
tracklist in a single compound read:

```ts
// examples/spotify-clone/src/pages/AlbumDetailPage.tsx
const albumQuery = useQuery(reads.albums.get(id, { include: ['artist', 'tracks'] }))
const album = albumQuery.data
// album.artist.name and each album.tracks[i].title are typed off the client, no cast.
```

## Nested include paths

Where the spec advertises them, `include` accepts dotted paths — a relation of a related
resource, pre-expanded by the server into a bounded enum (e.g. `artist.albums`, `tracks.album`).
The server hydrates the whole chain into one compound document, and the runtime stitches it all
in.

```ts
// GET /albums/1?include=tracks,tracks.album
const album = await client.albums.get('1', { include: ['tracks', 'tracks.album'] })
album.tracks[0]!.title // hydrated
```

!!! note "Nested paths hydrate on the wire; the return type narrows only the top level"
    Only the **top-level relation** of each path drives return-type narrowing today — so
    `tracks` above is typed as hydrated, while a track's own `album` stays a resource identifier
    in the type (the nested resources are present at runtime; the type just doesn't descend into
    them yet). Include the top-level relation of a nested path and you'll get its narrowing for
    free — `['tracks.album']` hydrates `tracks` in the type as well as on the wire.

## Combining include and fields across types

`fields` is keyed by type, so a compound read can narrow both the primary type and each included
type independently. The `TrackPicker` component does this — list tracks, include each track's
`album`, and trim both to just the members the UI renders:

```ts
// examples/spotify-clone/src/components/TrackPicker.tsx
const tracksQuery = useQuery(
  reads.tracks.list({
    ...filter,
    include: ['album'],
    fields: { tracks: ['title', 'durationSeconds', 'album'] },
  }),
)
```

Here `fields[tracks]` keeps `album` in the fieldset (so the hydration survives the narrowing),
and you could add a `fields[albums]` entry to trim the included albums to just their `title`.

??? note "Going deeper: what an un-included relation looks like"
    An excluded relation is **not** dropped — it's just not hydrated:

    - **to-one, excluded** → `Identifier | null | undefined` (a bare `{ type, id }`, `null` for
      an empty to-one, or `undefined` when the relation was links-only);
    - **to-many, excluded** → a `Collection` of `Identifier` members (linkage may still be
      present, and a lazy to-many always materialises as an augmented array — only its members
      differ from the hydrated case).

    So you can always read `album.artist?.id` off a non-included to-one, or iterate
    `playlist.tracks` for identifiers, without a second request — you just don't get the related
    attributes until you include it (or follow the relation with `.related()`; see
    [reading](reads.md)).

## How this interacts with materialisation

The result type on this page is the compile-time projection of what the runtime actually builds.
When a response comes back, [materialisation](materialisation.md) indexes `included` by `type:id`
and stitches each included resource into its relationship slot as a nested resource object;
linked-but-not-included relations stay identifiers, and links-only relations resolve to
`undefined`. `include` / `fields` don't change *how* materialisation works — they change *what
the server sends*, and the generated types describe the shape that produces. Two consequences
worth knowing:

- **A missing include is graceful, never fatal.** If you write code expecting `album.artist` to
  be a resource but the server didn't include it, the runtime leaves it as an identifier (with a
  dev-mode warning) rather than throwing. The type is your guard-rail; the runtime won't crash if
  the wire and the type ever disagree.
- **Included resources are shared by `type:id`.** The same artist included under two albums is
  materialised once and referenced from both, so attribute reads are consistent across the graph.

For filtering and ordering the collection you're reading (as opposed to shaping what each resource
carries), see [filtering and sorting](filtering-and-sorting.md).

## See it in the example app

- [BrowsePage.tsx](../examples/spotify-clone/src/pages/BrowsePage.tsx) — a list with
  `include: ['artist']` narrowed by `fields[albums]`.
- [AlbumDetailPage.tsx](../examples/spotify-clone/src/pages/AlbumDetailPage.tsx) — a compound
  `get` with `include: ['artist', 'tracks']`.
- [example.test.ts](../packages/example/src/example.test.ts) — the tested `reads` cases: the
  list-with-include-and-fields read and the compound `get`.
- [the generated client](../examples/spotify-clone/src/generated/music-catalog.gen.ts) — see each
  type's `includable` enum (including the nested `tracks.album` / `artist.albums` paths) that
  constrains what `include` accepts.

## Next

- [Materialisation](materialisation.md) — how the compound document becomes a hydrated graph.
- [Reading](reads.md) — the `list` / `get` surface these options ride on.
- [Filtering and sorting](filtering-and-sorting.md) — shaping the collection itself.
