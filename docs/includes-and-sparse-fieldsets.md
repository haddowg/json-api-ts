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

### Select single keys of an attribute

A server can let a sparse fieldset name one key of an object attribute as `<attribute>.<key>`,
under the [Field Selection profile](https://haddowg.github.io/json-api/profiles/field-selection/).
A table showing a few keys of the same object for every row then reads only those keys. The
attributes that allow it are in the descriptor's `selectableKeys`, and each adds
`` `<attribute>.${string}` `` to the members `fields` takes for that type. Any other dotted member
is a compile error.

```ts
// GET /products?fields[products]=name,values.cap,values.countries
const products = await client.products.list({
  fields: { products: ['name', 'values.cap', 'values.countries'] },
})

products[0]!.values // { cap?: number; countries?: string[] }
products[0]!.$keySelection // { values: ['cap', 'countries'] }
```

An attribute named only through its keys is present and typed with just those keys, each
optional, since a resource whose value lacks a selected key leaves it out. A `null` value stays
`null`. An attribute you also list whole comes back whole, and its type stays whole. When the
`fields` array isn't a literal the client can read, every key stays in the type and is optional.

A server can also let a member name a key of an object inside the attribute, one more
`.<key>` per level. The descriptor's `selectableKeyPaths` lists those paths. The nested object is
narrowed the same way, and the path selects nothing else of the objects it passes through, so
`location.geo.lat` types and returns `location` holding only `geo`, and `geo` holding only an
optional `lat`. A key you also list whole, such as `location.geo` beside `location.geo.lat`, comes
back whole, and its type stays whole.

```ts
// GET /articles/a-1?fields[articles]=location.postcode,location.geo.lat
const article = await client.articles.get('a-1', {
  fields: { articles: ['location.postcode', 'location.geo.lat'] },
})

article.location // { postcode?: string; geo?: { lat?: number } } | null
article.$keySelection // { location: ['postcode', 'geo.lat'] }
```

A list whose items take keys has `*` where a key goes, and `<attribute>.*.<key>` selects that key
of every item. The list keeps its length and order, each item typed and returned with only the
selected keys, each optional, and a path keeps going through nested objects and lists the same way.
Listing the list, or its items as `<attribute>.*`, beside a path into it brings the list back whole.
`<attribute>.*` on its own is read exactly as `<attribute>`: the whole list, typed whole and left
out of `$keySelection`. There is no index: a server refuses `lines.0`.

```ts
// GET /articles/a-1?fields[articles]=lines.*.sku,lines.*.price.amount
const order = await client.articles.get('a-1', {
  fields: { articles: ['lines.*.sku', 'lines.*.price.amount'] },
})

order.lines // { sku?: string; price?: { amount?: number } }[] | null
order.$keySelection // { lines: ['*.sku', '*.price.amount'] }
```

A value that is one of several variants, such as a hero that is an image or a video, or a list of
headings and figures, takes the keys any variant lets a fieldset select, whether it is an attribute,
a key of an object or the items of a list. Every value comes back with the member naming its
variant and only the selected keys its own variant has, so the type narrows on the discriminator as
it does whole:

```ts
// GET /articles/a-1?fields[articles]=sections.*.text,sections.*.size.width
const article = await client.articles.get('a-1', {
  fields: { articles: ['sections.*.text', 'sections.*.size.width'] },
})

article.sections
// ({ kind: 'heading'; text?: string } | { kind: 'figure'; size?: { width?: number } } | { kind: 'rule' })[] | null
```

Each resource's `$keySelection` holds the paths the request selected of each attribute it
narrowed, in request order, each once, leaving out a path whose key the request also lists whole,
so code that merges two reads of a resource can tell a narrowed value from a whole one. It is empty when nothing was narrowed. A page that `$next()`
fetches reads the selection off the link it follows.

The server advertises the profile in the response's `Content-Type` when it narrowed something.
The client never asks for it and reads the response the same either way.

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

### An included to-many is its first page

A paginated to-many renders only the **first page** of its members, whether you include it or
the server renders its linkage anyway. The relationship object carries the links to the other
pages, `first`, `next` and, on a counted page, `last`, and a countable relation's `meta.total`.
So `album.tracks` may be the first two of twelve tracks: read its size from `$count`, not
`length`, and don't treat the array as the whole set.

```ts
// GET /albums/1?include=tracks&withCount=tracks
const album = await client.albums.get('1', { include: ['tracks'], withCount: ['tracks'] })

album.tracks.length       // 2, the first page
album.tracks.$count       // 12, the relationship's meta.total
album.tracks.$page.links  // { first, next, last }

const more = await album.tracks.$next() // the second page, as Track resources
const all = await loadAll(album.tracks) // every track, following each next link
```

`$next()` and `$prev()` return the page in the shape the array has. The page links address the
relationship endpoint, which answers with identifiers, so an included array reads its next page
from the related endpoint instead, with the same page query, and gets resources. That page carries
none of the original request's nested includes. An array of identifiers reads its next page as
linkage. `loadAll`, from `@haddowg/json-api-client`, follows `next` from any collection until the
last page, and takes a `signal` and a `maxPages` guard.

This is exactly what the spotify-clone's album page does — the album, its artist, and the first
page of its tracklist in a single compound read, then the rest of the tracklist with `loadAll`:

```ts
// examples/spotify-clone/src/pages/AlbumDetailPage.tsx
const albumQuery = useQuery(reads.albums.get(id, { include: ['artist', 'tracks'] }))
const album = albumQuery.data
// album.artist.name and each album.tracks[i].title are typed off the client, no cast.
const tracklistQuery = useQuery({
  queryKey: ['albums', id, 'tracklist'],
  queryFn: () => loadAll(album!.tracks),
  enabled: album !== undefined,
  structuralSharing: false,
})
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
  constrains what `include` accepts, and its `included` list of the types a compound document
  can carry, which types the generated `Included<T>` union.

## Next

- [Materialisation](materialisation.md) — how the compound document becomes a hydrated graph.
- [Reading](reads.md) — the `list` / `get` surface these options ride on.
- [Filtering and sorting](filtering-and-sorting.md) — shaping the collection itself.
