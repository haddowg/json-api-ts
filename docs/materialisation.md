# Materialisation

Materialisation is how the client turns a JSON:API response — the nested `data` /
`attributes` / `relationships` / `included` envelope — into flat, ergonomic result
objects you can read directly. It runs on every read (and on every write that echoes a
resource back), so most of the time you never think about it: you just read fields.

## The newcomer path: just read fields

A materialised resource is a plain object. `type` and `id` are ordinary properties, and
every attribute is flattened straight onto the object — no `.attributes.` in sight:

```ts
const ok = await client.albums.get('1')

ok.type          // 'albums'
ok.id            // '1'
ok.title         // 'OK Computer'  — an attribute, flat on the object
ok.status        // 'released'
```

A collection read returns an array of these same objects:

```ts
const albums = await client.albums.list()

albums[0]!.title // 'OK Computer'
albums.length    // a real array — map/filter/find all work
```

Because the data is stored as own **enumerable** properties, `{ ...ok }` and
`JSON.stringify(ok)` are clean — they contain exactly `type`, `id`, and the attributes
and relations, and nothing else. All the envelope machinery is hidden (see
[Going deeper: the `$`-accessors](#going-deeper-the--accessors) below).

!!! tip "Types follow the data"
    The result is precisely typed from the generated descriptor: `ok.title` is a
    `string`, `ok.status` is the `AlbumStatus` enum — no casts. A sparse
    [`fields`](includes-and-sparse-fieldsets.md) selection narrows the result so an
    unrequested attribute is statically **absent** from the type, matching what the
    server actually sent.

## Hydration: included relations become nested resources

The powerful part is what happens to relationships. When you ask for a relation with
[`include`](includes-and-sparse-fieldsets.md), the client stitches the matching entries
from the response's `included` array into the relation slot as **full nested resource
objects** — the same flat shape as a top-level resource:

```ts
const ok = await client.albums.get('1', { include: ['artist', 'tracks'] })

// A to-one, included -> a full resource. `name` is typed, no cast.
ok.artist?.name          // 'Radiohead'

// A to-many, included -> an augmented array of full resources.
ok.tracks[0]!.title      // 'Airbag'
ok.tracks.length         // 3
```

This is **hydration**: the wire ships resources once in a shared `included` block and
references them by `type`/`id`; materialisation resolves those references into a
self-contained nested graph you can walk directly.

A relation you did **not** include stays as a bare resource identifier — `{ type, id }`
— never a full resource:

```ts
const ok = await client.albums.get('1')  // no include

ok.artist            // { type: 'artists', id: '2' } — an identifier, no attributes
ok.artist?.name      // statically absent: you didn't ask for it
```

The return type mirrors this exactly: an included relation is typed as the hydrated
resource, an excluded one as an identifier. See
[Includes and sparse fieldsets](includes-and-sparse-fieldsets.md) for the full
narrowing story.

!!! note "Relations are one hop deep"
    A hydrated related resource's own relations stay as identifiers — the read API
    hydrates the relations you named at the top level, not their children. Fetch the
    nested resource directly, or use a dotted include path (`tracks.album`) which brings
    the child into `included` so the top-level relation still hydrates.

### Empty and links-only relations

- An **empty to-one** (`data: null` on the wire) materialises to `null`, even when it
  was included.
- A **to-one** that was neither present nor included reads as `undefined`.
- A declared **to-many** always reads as an array — even a lazy, count-free relation
  with no linkage yet materialises as an empty augmented array, so you can iterate
  without a guard.
- A **links-only** relation (a relationship object carrying `links`/`meta` but no
  `data`) has no value to hydrate, so the slot is `undefined`; reach its links via
  `$rel(name)` (below).

## Augmented arrays

Every to-many value — a top-level collection, a `.related()` collection, or a hydrated
to-many relation — is a real, read-only `T[]`. You can `map`/`filter`/`find`/spread it
like any array. It additionally carries a non-enumerable **relationship-level
envelope** so pagination and links ride along with the members:

```ts
const albums = await client.albums.list({ page: { number: 1 } })

albums.length            // real array
albums.map((a) => a.id)  // real array method

albums.$page.kind        // 'page' — normalised pagination discriminant
albums.$meta?.['page']   // the raw meta.page block
const next = await albums.$next()  // fetch the next page (or undefined)
```

The same `$page` / `$links` / `$meta` / `$next()` / `$prev()` model backs all three
to-many surfaces — "one model, three surfaces". The full navigation semantics live in
[Pagination](pagination.md).

## Reading many-to-many edge data via `$pivot`

A `belongsToMany` relationship can carry **edge** data — attributes of the *membership*
itself, not of either resource. The classic example is a playlist's ordered tracks: the
same track can appear in many playlists, and its **position** belongs to the
playlist-track edge, not to the track. Materialisation exposes it per-member under the
typed `$pivot` accessor:

```ts
const ordered = await client.playlists
  .id(PLAYLIST)
  .rel('orderedTracks')
  .related({ page: { size: 2 } })

// Each member is a Track...
ordered[0]!.title            // 'Airbag'
// ...carrying its per-edge pivot. The SAME track in another playlist
// would report a different position.
ordered[0]!.$pivot?.['position']  // 2
```

`$pivot` is typed from the relation's declared pivot fields — for `orderedTracks` that
is `{ addedAt: string; position: number; weight: number }` — so `member.$pivot?.position`
is a `number`, not `unknown`. It is **graceful**: present only when the endpoint actually rendered
`meta.pivot` (the relationship / related endpoints do), `undefined` otherwise.

The [spotify-clone](../examples/spotify-clone/src/api/playlist-tracks.ts) app shows the
write side of the same shape: it sends the writable pivot fields back on a to-many
membership ref (`{ ...track, $pivot: { position, weight } }`) to reorder a playlist. See
[Relationship mutation](relationship-mutation.md) for that path.

??? note "Going deeper: per-edge views and identity by type:id"
    Each materialised related value is a *per-edge view* — a distinct wrapper per
    membership. It reads through to one shared, canonical node for the resource's
    attributes, but owns its own edge-local `$edge` / `$pivot`. That is why the same
    track in two different playlists carries two different pivots while sharing one set
    of attributes.

    The consequence: **identity is by `type:id`, never object reference**.
    `playlist.tracks[0]` is not `===` to the same track fetched standalone, even though
    both carry the same `title`. Compare on `type` + `id`, not reference. (This is also
    what lets the TanStack layer patch every cached view of a resource at once — see
    [normalisation in the architecture page](architecture.md).)

## Going deeper: the `$`-accessors

Everything beyond the flat data — links, meta, the raw wire object — rides
**non-enumerable, `$`-prefixed accessors**. The `$` prefix is collision-proof (`$` is
forbidden in JSON:API member names), and being non-enumerable keeps spreads and
`JSON.stringify` clean.

```ts
const ok = await client.albums.get('1')

ok.$self        // 'https://music.example/albums/1' — the resource self link
ok.$links       // the full resource-level links object
ok.$meta        // resource-level meta (or undefined)
ok.$document    // the shared top-level { jsonapi, meta, links } envelope
ok.$raw         // the original wire resource object (escape hatch)
ok.$rel('tags') // { data, links, meta } for any relationship, incl. links-only
```

??? note "The full accessor set"
    | Accessor | On | What it returns |
    | --- | --- | --- |
    | `$self` | every resource | the resource `self` link (`$links.self` shorthand) |
    | `$links` | every resource | the resource-level links object |
    | `$meta` | every resource / every array | resource- or relationship-level meta |
    | `$document` | every resource | the shared, by-reference `{ jsonapi, meta, links }` top-level envelope — identical identity for every resource from one response |
    | `$raw` | every resource | the original JSON:API resource object |
    | `$rel(name)` | the parent resource | `{ data?, links?, meta? }` for a relationship — the way to reach a **links-only** relation's envelope |
    | `$edge` | every related value | the relationship-instance envelope for *this* membership (to-one: `{ links: { self, related }, meta }`; to-many member: meta such as `pivot`) |
    | `$pivot` | pivot to-many members | typed sugar over `$edge.meta.pivot` |
    | `$page` / `$links` / `$meta` / `$next()` / `$prev()` | augmented arrays | the relationship-level pagination + navigation envelope ([Pagination](pagination.md)) |

    `$edge` is distinct from a resource's own `$links`/`$meta`: it describes the
    *edge* (the membership) rather than the resource. For a to-one, the edge carries
    the relationship object's `self`/`related` links — so you rarely need to go via the
    parent's `$rel` for a to-one.

## See it in the example app

- The tested reference:
  [example.test.ts](../packages/example/src/example.test.ts) — the `reads` block
  covers flat fields, hydrated `include`, `.related()` collections, and the `$pivot`
  edge read; every snippet runs under `pnpm test`.
- The pivot write shape:
  [playlist-tracks.ts](../examples/spotify-clone/src/api/playlist-tracks.ts) — the
  ordered-track ref builders that ship `$pivot` back to the server.

## Next

- [Reads](reads.md) — the read surface that produces these materialised values.
- [Includes and sparse fieldsets](includes-and-sparse-fieldsets.md) — how `include`
  drives hydration and `fields` narrows the result.
- [Concepts](concepts.md) — the underlying resource / edge / augmented-array model.
