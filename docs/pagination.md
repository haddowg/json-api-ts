# Pagination

Paginated collections carry their page state on the array itself. A collection you read back is a real `T[]` — you map, index and destructure it as usual — but it also carries a non-enumerable `$page` accessor and link-driven `$next()` / `$prev()` navigation, so paging never needs a second, differently-shaped return value.

The model is **count-free-safe**: you can page forward and back without the server ever sending a total. Navigation is driven purely by the presence of `next`/`prev` links, so a server that omits counts still pages correctly.

## Reading a page

Pass a `page` object to any collection read. Its keys are the paginator's knobs — for page-based pagination, `number` and `size`:

```ts
const albums = await client.albums.list({
  sort: '-releasedAt',
  page: { number: 1 },
})

// `albums` is an ordinary read-only array — map/index it directly.
albums.length         // 2
albums[0]!.title      // 'OK Computer'
```

The page state rides the array as `$page`:

```ts
albums.$page.kind                    // 'page'
albums.$meta?.['page']               // the raw meta.page block, e.g. { currentPage: 1, ... }
```

!!! note "`$page` is non-enumerable"
    `$page`, `$next`, `$prev`, `$links` and `$meta` are non-enumerable accessors, so `[...albums]`, `albums.map(...)` and `JSON.stringify(albums)` stay clean — they see only the resource elements. See [materialisation](materialisation.md) for how the envelope is layered onto the array.

## Turning the page

`$next()` and `$prev()` follow the collection's `next` / `prev` links and re-materialise the result as the same kind of collection — so you can keep calling `$next()` to walk forward:

```ts
const first = await client.albums.list({ page: { size: 20 } })

const second = await first.$next() // Collection<...> | undefined
const back = second && (await second.$prev())
```

When there is no link to follow (you are on the last page, or the first), the accessor resolves to `undefined` rather than issuing a request — so a simple loop terminates naturally:

```ts
let page = await client.albums.list({ page: { size: 20 } })
const all = [...page]
while (page) {
  const next = await page.$next()
  if (!next) break
  all.push(...next)
  page = next
}
```

!!! tip "No total required"
    `$next()` / `$prev()` are wired from `links.next` / `links.prev` alone. A server using a count-free paginator (no `meta.page.total`) still navigates correctly — that is the point of driving navigation off links rather than arithmetic over a total.

## Paginator kind

`$page.kind` reports which kind of paginator the endpoint uses. It is one of:

| `kind`   | Meaning                                              |
| -------- | --------------------------------------------------- |
| `page`   | page-number pagination (`page[number]` / `page[size]`) |
| `offset` | offset/limit pagination                             |
| `cursor` | opaque-cursor pagination                            |
| `none`   | the endpoint is not paginated                       |

The kind is **declared per resource (and per relation) in the spec** and baked into the generated descriptor — the client reads it from there, it never guesses from the response. That is what makes it reliable even for an empty page: an empty collection carries no member to sniff a type from, but the descriptor still knows the collection's real kind, so `$page.kind` is correct rather than falling back to `none`.

!!! note "Why the client knows which knobs exist"
    Because the paginator kind travels in the descriptor, the client (and your editor) know up front which `page` knobs an endpoint accepts. Look at the generated descriptor to see it declared — e.g. [the generated client](../examples/spotify-clone/src/generated/music-catalog.gen.ts) carries a `paginator: "page"` on each paginated resource and `paginator: "none"` where an endpoint does not paginate.

## Cursor pagination (advanced)

Cursor pagination works exactly the same way at the call site — the difference is entirely in `$page.kind` and the knobs you pass. Instead of a page number you supply a cursor, and you follow `$next()` rather than incrementing:

!!! note "Illustrative"
    The music-catalog example only declares `page` pagination, so this snippet uses a hypothetical `events` collection to show the cursor shape. Whether an endpoint is `page`- or `cursor`-paginated is fixed by your API's spec and baked into the descriptor.

```ts
// A cursor-paginated collection — kind reflects the descriptor, not the response.
const firstPage = await client.events.list({ page: { size: 50 } })
firstPage.$page.kind // 'cursor'

// You don't hand-build the next cursor — follow the link.
const nextPage = await firstPage.$next()
```

Because navigation is link-driven, cursor pagination needs no special handling: `$next()` follows the server's opaque `next` link, and there is no total to reconcile. The paginator kind is the signal that tells you (and your types) that a cursor is the right knob — you never mix a `page[number]` into a cursor endpoint by accident, because the descriptor said `cursor`.

??? note "Going deeper: the `Page` shape"
    A collection's `$page` is a small normalised value discriminated by `kind`:

    ```ts
    interface Page {
      kind: 'page' | 'offset' | 'cursor' | 'none'
      meta?: Record<string, unknown>          // the raw meta.page block, when present
      links: { first?; prev?; next?; last? }  // navigation links, when present
    }
    ```

    `$page.meta` is the untouched `meta.page` block from the wire (its shape varies by paginator — `currentPage`, `total`, a cursor value, etc.), and `$page.links` are the extracted navigation hrefs `$next()`/`$prev()` follow. Both are optional: a count-free paginator may carry only links, and the last page may carry no `next`.

## Paginating a related collection

A related collection paginates the same way. Fetch a to-many relation with `.related()` and pass `page`; the returned array carries its own `$page`, and it reports the **relation's** paginator kind — which the spec may declare differently from the related type's own top-level collection:

```ts
const tracks = await client.albums
  .id('1')
  .rel('tracks')
  .related({ page: { size: 2 } })

tracks.length     // 2
tracks.$page.kind // 'page'
```

`$next()` / `$prev()` work on a related collection too, following the relation-endpoint links. See [reads](reads.md) for the full related-read surface and [includes-and-sparse-fieldsets](includes-and-sparse-fieldsets.md) for hydrating relations in one round-trip instead.

!!! warning "One model, three surfaces"
    The same augmented-array model backs top-level collections, related-endpoint collections, and to-many relation values hydrated in a compound document. So `$page` behaves consistently wherever a to-many array appears — but a related array reports the *relation's* declared paginator, which can diverge from the related type's collection paginator. The descriptor carries the per-relation kind precisely so the discriminant is right on every surface.

## See it in the example app

- [BrowsePage.tsx](../examples/spotify-clone/src/pages/BrowsePage.tsx) and [SearchPage.tsx](../examples/spotify-clone/src/pages/SearchPage.tsx) request bounded pages (`page: { size: PAGE_SIZE }`) on every collection read.
- [PlaylistDetailPage.tsx](../examples/spotify-clone/src/pages/PlaylistDetailPage.tsx) pages a related to-many (`orderedTracks`).
- The tested reference snippets — a paginated collection (`$page.kind`) and a paginated related collection — live in [example.test.ts](../packages/example/src/example.test.ts) under the `reads` group.

## Next

- [reads.md](reads.md) — the full read surface `page` rides on.
- [materialisation.md](materialisation.md) — how `$page` and the augmented array are assembled.
