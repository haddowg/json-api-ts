# Reading

The client's read surface is a small fluent API over the generated descriptor: pick a
type, list or get, and — where you need it — follow a relationship. Every call is typed
end to end, so the shape you `await` is the shape the server sent.

## The four read shapes

Given a client built from a generated descriptor, each wire type hangs off the client by
name (`client.albums`, `client.artists`, …) and exposes:

```ts
// A collection.
const albums = await client.albums.list({ /* filter/sort/include/fields/page */ })

// One resource, by id.
const album = await client.albums.get('1', { include: ['artist'] })

// The same single read via an id-scoped handle.
const album = await client.albums.id('1').get({ include: ['artist'] })

// Following a relationship off a handle.
const tracks = await client.albums.id('1').rel('tracks').related() // the related collection
const linkage = await client.albums.id('1').rel('tracks').get()    // linkage (identifiers only)
```

`client.<type>.get(id, query)` and `client.<type>.id(id).get(query)` read the same
endpoint (`GET /{type}/{id}`) — the handle form is handy when you already hold an id and
want to chain into a relationship or a write. See [client.ts](../packages/client/src/client.ts).

!!! note "`.get()` vs `.id(id)`"
    `client.albums.get('1')` performs the request immediately. `client.albums.id('1')`
    returns a *handle* — no request yet — from which `.get()`, `.update()`, `.delete()`,
    `.rel(name)` and `.actions` all read the same `{id}`.

## A minimal typed list

The simplest correct read. The result is an augmented array of materialised resources —
plain objects whose attributes are own enumerable properties, typed from the generated
attribute map.

```ts
const albums = await client.albums.list()

albums.length          // it's a real array
albums[0]!.title       // typed — the album's attributes are flat props
albums.$page.kind      // pagination rides a non-enumerable accessor
```

Attributes are flattened onto the resource; the JSON:API envelope (self link, meta,
pagination) rides non-enumerable `$`-accessors so it never collides with your data. That
materialisation model — one flat object, envelope on the side — is covered in
[materialisation](materialisation.md).

## Get one, with an include

`include` hydrates the requested relations into the result *type*, not just the value —
the included relation is a full resource you can read straight off the parent, no cast.

```ts
const ok = await client.albums.get('1', { include: ['artist', 'tracks'] })

ok.title            // 'OK Computer'
ok.artist?.name     // 'Radiohead' — the to-one `artist` is hydrated
ok.tracks[0]!.title // 'Airbag' — the to-many `tracks` is an augmented array
ok.$self            // the resource's self link (non-enumerable)
```

This is exactly what the example app's [AlbumDetailPage.tsx](../examples/spotify-clone/src/pages/AlbumDetailPage.tsx)
does: one compound read pulls the album, its artist, and its tracklist so
`album.artist.name` and each `track.title` are typed with no second request.

!!! tip "Keep an included relation in the fieldset"
    A sparse `fields` selection narrows attributes *and* relations. If you `include` a
    relation, keep its name in that type's fieldset — otherwise it's statically absent
    from the result even though you asked to hydrate it. See
    [includes and sparse fieldsets](includes-and-sparse-fieldsets.md).

## Following a relationship

From an id-scoped handle, `.rel(name)` opens a relationship accessor with two reads:

- `.related(query?)` reads `GET /{type}/{id}/{rel}` — the related **resources** (full
  objects), paginated like any collection.
- `.get(query?)` reads `GET /{type}/{id}/relationships/{rel}` — the **linkage** (resource
  identifiers only).

```ts
// The related collection — full track resources, narrowed to a typed Collection<track>.
const tracks = await client.albums.id('1').rel('tracks').related({ page: { size: 2 } })
tracks.map((t) => t.title)  // t.title is typed
tracks.$page.kind           // 'page' — pagination rides the array

// The linkage — resource identifiers only.
const refs = await client.albums.id('1').rel('tracks').get()
```

A literal relation name (`'tracks'`) narrows the return to the related type, so the members
are typed without a cast. `.related()` and `.get()` accept the same query families as a
collection read (`filter`/`sort`/`include`/`fields`/`page`/`withCount`) — the related and
relationship endpoints advertise their own vocabulary.

??? note "Going deeper: `.rel(name)` vs direct property access, and suppressed endpoints"
    On a handle you can also reach a relation by property — `client.albums.id('1').tracks`
    — but a relation whose name collides with a reserved handle member (`get`, `update`,
    `delete`, `rel`, `actions`, `type`, `id`, `then`) is shadowed; route those through the
    explicit `.rel(name)` form. The reserved set is `HANDLE_RESERVED` in
    [client.ts](../packages/client/src/client.ts).

    If the server suppressed an endpoint (`withoutRelatedEndpoint()` /
    `withoutRelationshipEndpoint()` in the bundle), that read is *absent* — the static type
    is `never`, so calling it is a compile error rather than a `404` round-trip. Likewise a
    to-many relation carries pivot data on each member's typed `$pivot` accessor (see the
    `orderedTracks` case in [example.test.ts](../packages/example/src/example.test.ts)).

## How the query families compose

A collection read (`list`) accepts the full set; a single read (`get`/`id(id).get`) accepts
only `include` and `fields` (a single resource has no collection to filter, sort or page):

| Family      | What it does                                        | Deep dive |
|-------------|-----------------------------------------------------|-----------|
| `filter`    | narrow the collection; keys are the advertised params | [filtering and sorting](filtering-and-sorting.md) |
| `sort`      | order the collection; signed field tokens            | [filtering and sorting](filtering-and-sorting.md) |
| `include`   | hydrate relations into the result type               | [includes and sparse fieldsets](includes-and-sparse-fieldsets.md) |
| `fields`    | narrow which members each type returns               | [includes and sparse fieldsets](includes-and-sparse-fieldsets.md) |
| `page`      | window the collection                                | [pagination](pagination.md) |
| `withCount` | ask for relationship counts (Countable profile)      | [pagination](pagination.md) |

They compose freely on a `list`. This is a real, tested call combining all of them:

```ts
const albums = await client.albums.list({
  filter: { title: 'OK' },
  sort: '-releasedAt',
  include: ['artist'],
  fields: { albums: ['title', 'status', 'artist'] },
  page: { number: 1 },
})
```

The client serialises this flat query into JSON:API bracketed parameters deterministically
(so URLs are cache-stable) — `?filter[title]=OK&sort=-releasedAt&include=artist&fields[albums]=title,status,artist&page[number]=1`.
The serialiser lives in [request.ts](../packages/client/src/request.ts); the tested
assertion is the first case in [example.test.ts](../packages/example/src/example.test.ts).

!!! note "Keys and values are constrained to what the server advertises"
    `filter` keys, `sort` tokens, `include` paths, `fields` member names and `withCount`
    tokens are all narrowed to the descriptor's declared vocabulary. Asking for something
    the server doesn't advertise is a compile error — a static mirror of the server's
    `400` (e.g. `SORTING_UNSUPPORTED`, `INCLUSION_NOT_ALLOWED`). See
    [concepts](concepts.md).

## What a read resolves to

Every read materialises the wire document into flat resource objects:

- a **collection** read (`list`, `.related()`) resolves to an augmented, read-only array —
  a `Collection<T>` carrying `$page`, `$links`, `$meta` and `$next()`/`$prev()` navigation;
- a **single** read (`get`) resolves to one materialised resource, with `$self`, `$meta`,
  `$links` and `$rel(name)` on the side;
- a **linkage** read (`.rel(name).get()`) resolves to resource identifiers (a `Collection`
  of identifiers for to-many, a single identifier or `null` for to-one).

A `204`/empty response resolves to `undefined`. The full materialisation model — flat props,
`$`-accessors, augmented arrays, link-driven navigation — is
[its own page](materialisation.md).

## See it in the example app

- [BrowsePage.tsx](../examples/spotify-clone/src/pages/BrowsePage.tsx) — three list reads
  (albums with an `include`d artist narrowed by `fields`, artists, playlists), each through
  the bound query API.
- [AlbumDetailPage.tsx](../examples/spotify-clone/src/pages/AlbumDetailPage.tsx) — a
  single `get` with `include: ['artist', 'tracks']` hydrating a whole compound view.
- [ArtistDetailPage.tsx](../examples/spotify-clone/src/pages/ArtistDetailPage.tsx) — a
  `get` with `include: ['albums']` hydrating a to-many discography.
- The tested `describe('reads', …)` block in
  [example.test.ts](../packages/example/src/example.test.ts) — list-with-include-and-fields,
  get-one, `.related()`, and reading pivot data via `$pivot`.

## Next

- [Includes and sparse fieldsets](includes-and-sparse-fieldsets.md) — hydrate relations and narrow members.
- [Filtering and sorting](filtering-and-sorting.md) — the typed collection query vocabulary.
- [Materialisation](materialisation.md) — how the wire document becomes flat objects.
