# Pagination

Paginated collections carry their page state on the array itself. A collection you read back is a real `T[]` — you map, index and destructure it as usual — but it also carries a non-enumerable `$page` accessor and link-driven `$next()` / `$prev()` navigation, so paging never needs a second, differently-shaped return value.

The model is **count-free-safe**: you can page forward and back without the server ever sending a total. Navigation is driven purely by the presence of `next`/`prev` links, so a server that omits counts still pages correctly.

## Reading a page

Pass a `page` object to any collection read. Its keys are the paginator's wire keys, typed per collection from the descriptor: counts (`number`, `size`, `offset`, `limit`) are numbers, cursors (`after`, `before`) are strings. For page-based pagination with the default keys, that's `number` and `size`:

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
albums.$page.meta?.currentPage       // number, from the meta.page block
albums.$page.meta?.total             // number | undefined (present when the server counts)
```

A key the collection doesn't accept is a compile error, and so is a `page` on an unpaginated collection:

```ts
client.albums.list({ page: { numbr: 1 } })   // error: not a page key
client.albums.list({ page: { size: '20' } }) // error: a size is a number
```

The generated `pageLimits` holds each collection's page defaults and largest page size, as
`pageLimits.albums.size` → `{ default: 15, minimum: 1, maximum: 50 }`. The client doesn't clamp
`page` to them; see [codegen](codegen.md#page-defaults-and-caps).

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
| `fixed`  | page-number pagination where the server fixes the size (only `page[number]`) |
| `none`   | the endpoint is not paginated                       |

A `fixed` collection reads like a `page` one, except you can only pick the page number: `client.albums.list({ page: { number: 2 } })`. Its `$page.meta` carries `currentPage`, plus `total` and `lastPage` when the server counts.

`$page.meta` is typed per kind, following what `haddowg/json-api`'s paginators render:

| `kind`   | `$page.meta` |
| -------- | ------------ |
| `page`   | `currentPage`, `perPage`, `from`, and `to`, `total`, `lastPage` when known |
| `fixed`  | `currentPage`, and `total`, `lastPage` when counted |
| `offset` | `offset`, `limit`, `from`, and `to`, `total` when known |
| `cursor` | `perPage`, `hasMore`, and the `from`/`to` row ids on a non-empty page |

## Renamed page keys

A server can rename any page key (`PagePaginator::make()->withPageKey('p')`). The server stamps the names it uses into the OpenAPI document, the codegen carries them in the descriptor, and the `page` argument takes the real wire keys:

```ts
// paginator: { strategy: 'page', keys: { number: 'p', size: 'size' } }
const albums = await client.albums.list({ page: { p: 2, size: 20 } }) // ?page[p]=2&page[size]=20
albums.$page.keys // { number: 'p', size: 'size' }
```

`$page.keys` maps each role (`number`, `size`, `offset`, `limit`, `after`, `before`) to its wire key, for code that builds page arguments generically.

## Choosing a strategy (MultiPaginator)

A collection backed by a `MultiPaginator` offers a menu of strategies. Each one has a `kind`, and the server answers with its default when a request names none. The `page` argument is a union: pick a strategy by its `kind` and pass that strategy's members, or leave `kind` out and pass the default's members.

```ts
// paginator: { strategy: 'multi', default: 'page', arms: { page: 'page', cursor: 'cursor' } }

const byCursor = await client.events.list({ page: { kind: 'cursor', after: 'abc', size: 50 } })
// sends ?page[kind]=cursor&page[after]=abc&page[size]=50
byCursor.$page.kind // 'cursor' (typed as 'cursor')
byCursor.$page.arm  // 'cursor'

const byDefault = await client.events.list({ page: { number: 2 } })
byDefault.$page.kind // 'page' (typed as the default arm's strategy)
```

`$page` is typed by the strategy that will answer: the arm you picked, or the default when you picked none. A member only another arm reads, such as `after` without `kind: 'cursor'`, is a compile error, because the server would pick that other arm by it while the response is typed as the default. An arm's `kind` can differ from its strategy (`withKind()` on the server); the client sends the `kind` and types the response by the strategy.

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
      kind: 'page' | 'offset' | 'cursor' | 'fixed' | 'none'
      keys: { number?; size?; offset?; limit?; after?; before? } // role -> wire key
      arm?: string                            // the menu arm the read picked, if any
      meta?: Record<string, unknown>          // the raw meta.page block, when present
      links: { first?; prev?; next?; last? }  // navigation links, when present
    }
    ```

    That is the runtime shape. On a generated client each read's `$page` is the narrower `TypedPage<kind, keys, arm>`, whose `meta` is typed for its kind (see the table above). `$page.meta` is the untouched `meta.page` block from the wire, and `$page.links` are the extracted navigation hrefs `$next()`/`$prev()` follow. Both are optional: a count-free paginator may carry only links, and the last page may carry no `next`.

## Paginating a related collection

A related collection paginates the same way. Fetch a to-many relation with `.related()` and pass `page`; the returned array carries its own `$page`, and it reports the **relation's** paginator — which the spec may declare differently from the related type's own top-level collection. The `page` argument is typed from that paginator too, and a to-one relation takes no `page`:

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
