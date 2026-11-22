# TanStack Query

`@haddowg/json-api-query` layers TanStack Query over the typed client: **option factories** you spread into `useQuery` / `useMutation`, a deterministic query-key factory, and bespoke `type:id` write-through cache normalisation — "edit once, updates everywhere".

The binding exposes **option factories, not pre-bound hooks**, over `@tanstack/query-core`. One package therefore covers React / Vue / Svelte / Solid — you pass the returned `{ queryKey, queryFn }` / `MutationOptions` to your framework's own `useQuery` / `useMutation`. Reads keep the client's full static narrowing (`include` widens, sparse `fields` narrows) end to end.

```bash
npm install @haddowg/json-api-query @tanstack/query-core
```

`@tanstack/query-core` (5.62 or later) is a peer dependency (your framework adapter — `@tanstack/react-query` etc. — brings it in).

## Bind the client once

Two bound APIs sit over the generated client, built once at bootstrap. `createQueryApi` gives you per-type read factories; `createMutationApi` gives you the write factories (it needs the `QueryClient` and the generated `resourceMap` descriptor for cache patching).

```ts
import { createMutationApi, createQueryApi, installNormalization } from '@haddowg/json-api-query'
import { QueryClient } from '@tanstack/react-query'
import { createClient, resourceMap } from '../generated/music-catalog.gen'

export const client = createClient({ baseUrl: 'https://music.example' })

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: false } },
})

// `type:id` write-through patching (see below) — a change to any resource updates every cached view.
installNormalization(queryClient, resourceMap)

export const reads = createQueryApi(client)
export const writes = createMutationApi(queryClient, client, resourceMap)
```

That is exactly how the example app bootstraps its data layer — see [client.ts](../examples/spotify-clone/src/api/client.ts).

!!! note "Action-agnostic at the query boundary"
    The read factories accept `Client<D, A>` and the write factories `Client<D, A, W>` — neither carries the client's custom-action types (actions aren't cacheable resources). The generated `createClient` returns a client that *also* carries action types; pass it straight through (as above), or view it through the action-agnostic `Client` types with a single cast per surface if your setup needs it.

## A basic query

Each read factory returns a plain `{ queryKey, queryFn }`, structurally compatible with query-core's `QueryOptions`. Spread it into `useQuery` — the result type is the client's own materialised view, so `include`, `fields` and `withCount` narrow it exactly as a direct client call would. The create and update mutation factories take `withCount` and `relatedQuery` in their options too, and `related` takes the `relatedQuery` its client read takes, so it lands in the query key.

```ts
import { useQuery } from '@tanstack/react-query'
import { reads } from '../api/client'

// A single resource, with two relations hydrated by `?include`.
const albumQuery = useQuery(reads.albums.get(id, { include: ['artist', 'tracks'] }))

// A collection list.
const albumsQuery = useQuery(reads.albums.list({ include: ['artist'] }))
```

There are four read factories per type, mirroring the client's read surface:

| Bound call | Endpoint | Resolves |
| --- | --- | --- |
| `reads.albums.list(query)` | `GET /albums` | a typed `Collection` |
| `reads.albums.get(id, query)` | `GET /albums/{id}` | the typed resource view |
| `reads.albums.related(id, rel, query)` | `GET /albums/{id}/{rel}` | the related resource(s) |
| `reads.albums.relationship(id, rel, query)` | `GET /albums/{id}/relationships/{rel}` | the linkage |

Every factory has a standalone form too (`listQueryOptions(client, 'albums', query)`, `getQueryOptions`, `relatedQueryOptions`, `relationshipQueryOptions`) — the bound API is just sugar with `client`/`type` pre-applied.

`list` takes the same typed `page` argument as the client, so the result's `$page` is typed by the strategy that answers, including the arm a [MultiPaginator](pagination.md#choosing-a-strategy-multipaginator) read picks:

```ts
const albumsPage = useQuery(reads.albums.list({ page: { number: 2, size: 20 } }))
albumsPage.data?.$page.kind              // 'page'
albumsPage.data?.$page.meta?.currentPage // number

reads.albums.list({ page: { numbr: 2 } }) // compile error: not a page key
```

A result keeps the [document meta](reads.md#document-meta) the server declares: a list or related collection has it typed on `$meta` beside `$page`, and a single read on `$document.meta`. The create and update mutations resolve the same way, and the delete mutation resolves to the meta its `200` declares.

See [reads.md](reads.md), [includes-and-sparse-fieldsets.md](includes-and-sparse-fieldsets.md), and [pagination.md](pagination.md) for the underlying read surface these factories wrap.

Every read factory sets `structuralSharing: false`. TanStack's structural sharing rebuilds a refetched value that changed as plain arrays and objects, which drops the non-enumerable accessors a materialised value carries, so a refetched collection would lose `$page` and `$next()` and its resources `$self` and `$rel()`. A query you build yourself around a client call needs the same setting:

```ts
useQuery({
  queryKey: ['albums', 'top'],
  queryFn: ({ signal }) => client.albums.list({ signal }),
  structuralSharing: false,
})
```

Every read factory also passes TanStack's abort `signal` to the read. When a query's key changes, or its last observer goes away while a request is in flight, TanStack cancels the query and the request is aborted on the wire, so a search box leaves one request running rather than one per keystroke. The example above does the same with `{ signal }`. See [cancelling a read](reads.md#cancelling-a-read).

### Typed cache reads

Each factory's `queryKey` is tagged with the read's result and error types (TanStack's `DataTag`), so `getQueryData`, `setQueryData` and `getQueryState` are typed without a cast. The tag exists only in the types: the key is the plain tuple described under [deterministic query keys](#deterministic-query-keys).

```ts
const albumOptions = reads.albums.get(id, { include: ['artist'] })
const cached = queryClient.getQueryData(albumOptions.queryKey) // the album view | undefined
cached?.title

queryClient.setQueryData(albumOptions.queryKey, (old) => old) // `old` is the album view too
```

### Typed errors and retries

TanStack types a query's `error` from a typed callback in its options, so each factory's options type declares an optional `retry` typed with what a read rejects with: `ReadError<ErrorCode>`, which is `JsonApiError<ErrorCode> | StructuralGuardError | Error`, `ErrorCode` being the generated client's error-code union. The options never set `retry`, so the `retry` your QueryClient is configured with still applies.

```ts
import { hasErrorCode } from '../generated/music-catalog.gen'

const albumQuery = useQuery(reads.albums.get(id))
albumQuery.error // ReadError<ErrorCode> | null
if (hasErrorCode(albumQuery.error, 'RESOURCE_NOT_FOUND')) {
  albumQuery.error.errors // JsonApiErrorObject<ErrorCode>[]
}
```

See [errors.md](errors.md) for `hasErrorCode` and the other helpers.

When you configure no `retry`, `installNormalization` sets `jsonApiRetry` as the QueryClient's `defaultOptions.queries.retry`, keeping your other defaults, and removes it again on teardown. It never retries a `JsonApiError` below 500 (a 4xx won't change on a retry) or a `StructuralGuardError` (a response that isn't a JSON:API document), and retries anything else, such as a 5xx or a network failure, up to three times, as TanStack does by default. Being a default, it applies to `fetchQuery` and `prefetchQuery` too, which TanStack otherwise runs without retries. A `retry` you configure yourself, such as `retry: false` above, is left as it is.

If you build your QueryClient's defaults without `installNormalization`, set the policy yourself:

```ts
import { jsonApiRetry } from '@haddowg/json-api-query'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: jsonApiRetry } } })
```

A `retry` you spread over a factory's options is used for that query, and its `error` falls back to TanStack's default `Error`.

### Skipping a read with `skipToken`

Pass TanStack's `skipToken` in place of the id, or of a list's whole query, to keep a read disabled until its input exists. The options' `queryFn` is then `skipToken`, which `useQuery` treats as `enabled: false` while keeping the result typed.

```ts
import { skipToken, useQuery } from '@tanstack/react-query'

const albumQuery = useQuery(reads.albums.get(albumId ?? skipToken))
const albumsQuery = useQuery(reads.albums.list(ready ? { include: ['artist'] } : skipToken))
const artistQuery = useQuery(reads.albums.related(albumId ?? skipToken, 'artist'))
```

A singleton takes `skipToken` in place of its query (`reads.inboxes.get(skipToken)`). A skipped read's key carries the object segment `{ $skip: true }` (exported as `SKIPPED_SEGMENT`) where the id would go, `[type, operation, { $skip: true }, rel?]`, with no params, so it is deterministic and never matches a real read: no id or relation name equals an object, and no params object a read builds has a `$skip` member. TanStack and `keyHasPrefix` compare it by value. `useSuspenseQuery` doesn't accept `skipToken`, as TanStack documents.

## Infinite queries

`reads.<type>.infinite(query)` returns options for TanStack's infinite queries. Spread them into `useInfiniteQuery`, and each page is the typed `Collection` that `list(query)` resolves:

```ts
import { useInfiniteQuery } from '@tanstack/react-query'

const albums = useInfiniteQuery(reads.albums.infinite({ include: ['artist'], page: { size: 20 } }))

albums.data?.pages.flatMap((page) => page.map((album) => album.title))
if (albums.hasNextPage) {
  await albums.fetchNextPage()
}
```

The first page is the query's own `page`, or the server's first page when the query has none. Each later or earlier page is read with the `page` params of the current page's `next` or `prev` link, through the client's `nextPageParams` and `prevPageParams` (see [turning the page](pagination.md#turning-the-page)). That works the same for every strategy, cursors included, and `hasNextPage` is `false` on a page with no `next` link. A page param replaces the query's whole `page`, since the server's link carries every page member. `fetchPreviousPage`, `hasPreviousPage` and `maxPages` are TanStack's own.

`reads.<type>.relatedInfinite(id, rel, query)` pages a to-many relation's related collection the same way. A to-one relation is a compile error there, having no pages, and a singleton drops the id, as its other reads do. The standalone forms are `infiniteListQueryOptions(client, type, query)` and `infiniteRelatedQueryOptions(client, type, id, rel, query)`.

The key is the plain read's key plus a trailing `'$infinite'`: `[type, 'fetchMany', params?, '$infinite']` and `[type, 'fetchRelated', id, rel, params?, '$infinite']`. That keeps the cached pages apart from the plain read of the same query, and under the same prefixes, so a create or delete invalidates a type's infinite lists with its other lists, and a relationship write invalidates the parent's infinite related reads. The key is tagged with TanStack's `InfiniteData` of the read's pages and page params, so `getQueryData(options.queryKey)` is typed, and `error` is typed as for a plain read.

`skipToken` in place of the query, or of a related read's id, skips the read, and the key ends `{ $skip: true }, rel?, '$infinite'`:

```ts
const albums = useInfiniteQuery(reads.albums.infinite(ready ? { page: { size: 20 } } : skipToken))
const tracks = useInfiniteQuery(reads.albums.relatedInfinite(albumId ?? skipToken, 'tracks'))
```

[Normalisation](#normalisation-typeid-write-through-patching) reaches every page. A read or write patches a resource on whichever cached page holds it, and the query is published again as a new `{ pages, pageParams }` in which only the touched pages are new roots, so a page nothing changed keeps its reference and each page keeps its `$page` and `$next()`. Fetching another page indexes only that page's resources, so an earlier page's older response never overwrites a fresher copy elsewhere. An optimistic `update` patches infinite pages too, while an optimistic relationship `add`, `remove`, `replace` or `set` leaves them to the refetch its settle invalidation starts.

This runs under `pnpm test` in [example.test.ts](../packages/example/src/example.test.ts) (the `infinite queries` group). It reads the first page with `fetchInfiniteQuery`, the second through the next link as `fetchNextPage` does, then updates an album on the second page:

```ts
const options = reads.albums.infinite({ page: { size: 1 } })
expect(options.queryKey).toEqual(['albums', 'fetchMany', { page: { size: 1 } }, '$infinite'])
const first = await qc.fetchInfiniteQuery(options)
expect(first.pages[0]![0]!.title).toBe('OK Computer')

// The next page's params come from the page's `next` link, which `fetchNextPage` reads.
const observer = new InfiniteQueryObserver(qc, options)
expect(observer.getCurrentResult().hasNextPage).toBe(true)
const result = await observer.fetchNextPage()
expect(result.data?.pages.map((page) => page.map((a) => a.title))).toEqual([
  ['OK Computer'],
  ['Kid A'],
])
expect(result.hasNextPage).toBe(false)

// An update patches the album on whichever cached page holds it, as for any other read.
const writes = createMutationApi(qc, client, resourceMap)
await qc
  .getMutationCache()
  .build(qc, writes.albums.id('2').update() as never)
  .execute({ title: 'Kid A Mnesia' })
expect(qc.getQueryData(options.queryKey)?.pages[1]![0]!.title).toBe('Kid A Mnesia')
```

## A basic mutation

Mutation factories return a `MutationOptions` — the `mutationFn` plus the lifecycle callbacks the binding wires for cache upkeep. Spread it into `useMutation`; the variables mirror the client (`create()` takes the flat create input, `update()` the patch, and so on).

```ts
import { useMutation } from '@tanstack/react-query'
import { writes } from '../api/client'

const rename = useMutation(writes.playlists.id(id).update())
rename.mutate({ name: 'Fresh title' })

const create = useMutation(writes.albums.create())
const remove = useMutation(writes.albums.id(id).delete())
```

A write declaring its request `meta` takes it as the factory's `meta` option, required when a member is. Give it as an object, or as a function of the call's variables when each call sends its own, such as an idempotency key:

```ts
const book = useMutation(writes.bookings.create({ meta: () => ({ idempotencyKey: crypto.randomUUID() }) }))
const cancel = useMutation(writes.bookings.id(id).delete({ meta: { cancellationReason: 'ill' } }))
const add = useMutation(writes.bookings.id(id).rel('rooms').add({ meta: (refs) => ({ changedBy: `desk:${refs.length}` }) }))
```

The resource object's `meta` rides the create or update input as `$meta`.

You never write cache upkeep by hand: the binding invalidates and patches for you (next section). See [writes.md](writes.md) for the create/update/delete surface, and [relationship-mutation.md](relationship-mutation.md) for `add`/`remove`/`replace`/`set`.

## Deterministic query keys

Keys are stable, hierarchical readonly tuples — `[type, operation, id?, rel?, params?]`. The hierarchy is a contract: TanStack matches by prefix, so `[type]` addresses a whole type, `[type, 'fetchOne', id]` a single resource. The trailing `params` segment is **normalised** (object keys sorted recursively, absent params dropped), so two semantically-equal queries share one key — and `list()` and `list({})` collapse to the same key.

```ts
import { typeKey, resourceKey } from '@haddowg/json-api-query'

queryClient.invalidateQueries({ queryKey: typeKey('albums') }) // every albums read
queryClient.invalidateQueries({ queryKey: resourceKey('albums', '1') }) // one album's reads
```

A [singleton](reads.md#singletons) is addressed without an id, so its keys leave it out:
`[type, 'fetchOne', params?]` for its read and `[type, 'fetchRelated', rel, params?]` for a
relation. The factories take `undefined` for its id, which the types allow only for a singleton,
and the bound API drops the argument, as the client does:

```ts
const api = createQueryApi(client)
api.inboxes.get()               // key ['inboxes', 'fetchOne']
api.inboxes.related('owner')    // key ['inboxes', 'fetchRelated', 'owner']
getQueryOptions(client, 'inboxes', undefined) // the same read, standalone

const mutations = createMutationApi(queryClient, client, resourceMap)
mutations.inboxes.update({ optimistic: true }) // mutate({ id: inbox.id, seenUpTo })
```

The update's variables carry the resource's `id`, as the client's singleton update does, and an
optimistic update patches the resource that id names. `singletonRelationReadKeys(type, rel)` gives
a singleton relation's two read prefixes.

A [skipped read](#skipping-a-read-with-skiptoken)'s key is `[type, operation, { $skip: true }, rel?]`, and an [infinite read](#infinite-queries)'s is its plain read's key plus `'$infinite'`.

You rarely build a key yourself — the factories embed the right key, and normalisation drives invalidation from mutations. The helpers (`keyFor`, `infiniteKeyFor`, `typeKey`, `operationKey`, `resourceKey`, `relationKey`, `relationReadKeys`, `normalizeParams`) are exported for the cases where you need a targeted invalidation of your own.

## Normalisation: `type:id` write-through patching

TanStack Query is not a normalised cache — it keeps each result denormalised under its own key. JSON:API's guarantee that every resource carries `type`+`id` lets this package normalise with **zero configuration**. On every successful response it indexes each resource (`data` + `included`) by `type:id` and **patches every cached query holding that `type:id` in place**. Edit an album's title once, and every cached list, single-get, and included copy reflects it — no refetch.

`installNormalization` wires this to fire automatically on every successful query and mutation:

```ts
const teardown = installNormalization(queryClient, resourceMap)
// … later, e.g. in a test teardown: teardown() removes the subscriptions.
```

A patch replaces a node's **attributes** (the descriptor knows attributes from relations) while **preserving** each materialised object's edge-local `$pivot` / `$edge` and its identity — the same Track in two playlists keeps its own per-edge pivot data while its shared attributes update.

A read whose `fields` [selected single keys](includes-and-sparse-fieldsets.md#nested-fieldsets) of an attribute holds only part of that attribute's value. Its keys are merged into each cached copy of the value, and the cached keys it didn't select stay. A path into a nested object, such as `location.geo.lat`, merges into the cached nested object the same way, so the cached `geo.lng` and `postcode` stay. A path through a list, such as `lines.*.qty`, merges each item into the cached item at the same index, but only while the cached list has as many items as the fresh one: a list of another length has gained or lost items since it was cached, so no index pairs an item with its fresh part, and the cached list stays until a read of the whole list replaces it. The narrowed value never stands in for a cached value that isn't an object, or for an attribute a cached copy doesn't hold. A narrowed `null` is the whole value and replaces it, and a read of the whole attribute replaces a narrowed copy, as does a read listing a list as `lines.*`, which names the whole list. A narrowed value of a union only merges into a cached value of the same variant: when the member naming the variant differs, the cached value stays until a read of the whole attribute replaces it. The resource's `$nestedFieldset` tells the patch which attributes were narrowed.

Each query a patch touches is then published again under a new root reference, a transparent proxy over the same materialised value, so its `$page`, `$next()` and the objects inside it are unchanged. React Query's default tracked mode re-renders a component only when a value it read changes reference, so without a new `data` reference a patched read would hold the new title and still show the old one. The new root is set on the query's state directly, which keeps a query you invalidated invalidated and doesn't count as a fresh fetch. An optimistic patch and its rollback publish the same way. An optimistic relationship `add`, `remove` or `replace` swaps the cached to-many for the new members, keeping the array's `$page`, `$links` and `$next()` from the page the server sent until the settle refetch replaces it.

!!! warning "One descriptor per QueryClient"
    The patch matches by `type:id` alone, so two descriptors sharing a QueryClient would cross-contaminate attributes (e.g. a `default` and an `admin` server whose `users` differ). Installing a *different* descriptor on the same QueryClient throws. Give each typed client/server its own QueryClient.

### The patch-vs-invalidate split

Not every write is a node patch. The binding splits by what the write changes:

- an **update** (or a relationship `set` / `replace`) only changes a node's attributes / linkage → on success it **patches** via `normalize`, no refetch;
- a **create** / **delete** (or a relationship `add` / `remove`) changes collection membership → on settle it **invalidates** the relevant list / relationship subtrees so they refetch (a patch can't insert or remove a member).

Concretely: `create()` invalidates the type's lists; `delete()` invalidates the type's lists plus that resource's own reads; a relationship mutation invalidates the parent's relation reads (never the type's collection lists — a relationship change never alters which resources a collection holds).

### Tested: reads via factories, write-through on update

This runs under `pnpm test` in [example.test.ts](../packages/example/src/example.test.ts) (the `TanStack Query bindings` group). It seeds a list and a single-get, then updates the album — both cached reads reflect the fresh title **without a refetch**, because the update patched them by `type:id`:

```ts
const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
const teardown = installNormalization(qc, resourceMap)

const reads = createQueryApi(client)
const listOpts = reads.albums.list()
const getOpts = reads.albums.get('1')
await qc.fetchQuery(listOpts)
await qc.fetchQuery(getOpts)

// An update PATCHES the cache via normalize on success (no refetch).
const writes = createMutationApi(qc, client, resourceMap)
await qc
  .getMutationCache()
  .build(qc, writes.albums.id('1').update() as never)
  .execute({ title: 'Fresh title' })

// Both the cached list AND the cached single-get now reflect the fresh title.
const cachedList = qc.getQueryData(listOpts.queryKey) as Array<{ title: string }>
const cachedGet = qc.getQueryData(getOpts.queryKey) as { title: string }
expect(cachedList[0]!.title).toBe('Fresh title')
expect(cachedGet.title).toBe('Fresh title')

teardown()
```

??? note "Going deeper: explicit normalisation without install"
    Prefer explicit control over the auto-subscription? Skip `installNormalization` and call `normalize(queryClient, result, resourceMap)` yourself from an option factory's `onSuccess` — the mutation factories already do this internally on the patch path. It runs the identical write-through patch. The install path is a convenience that subscribes once to the query and mutation caches (guarded against re-entrancy so a patch pass doesn't cascade into a loop).

## Optimistic updates

Optimism flows through the **same** write-through patch, with a captured snapshot for rollback. Opt in per-mutation with `{ optimistic: true }` — available on the verbs that touch a node or a relation's membership (`update`, and relationship `set` / `replace` / `add` / `remove`; a `create`'s insert into the right sorted list is list-specific, so there is no default optimistic insert).

```ts
// Rename a playlist optimistically — the new name shows instantly, rolls back on error.
const rename = useMutation(writes.playlists.id(id).update({ optimistic: true }))

// Relationship membership, optimistic and reconciled on settle.
const relTracks = writes.playlists.id(id).rel('orderedTracks')
const add = useMutation(relTracks.add({ optimistic: true }))
const remove = useMutation(relTracks.remove({ optimistic: true }))
const reorder = useMutation(relTracks.replace({ optimistic: true }))
```

Under the hood: `onMutate` pre-applies the expected change through the normalised patch (an update's attribute keys; a relationship verb's membership transform across every cached page of the `(parent, relation)` read, matched by key prefix) and snapshots the touched queries; `onError` restores the snapshot; `onSettled` invalidates so the server reconciles (a degraded optimistic member — a bare identifier — is replaced by the fully-hydrated one on the refetch). Because the forward patch preserves per-edge `$pivot` / `$edge`, an optimistic add of a hydrated member renders a rich row immediately.

The example app's playlist detail page wires all four of these — rename, add track, remove track, reorder — see [PlaylistDetailPage.tsx](../examples/spotify-clone/src/pages/PlaylistDetailPage.tsx) and its optimistic helpers in [playlist-tracks.ts](../examples/spotify-clone/src/api/playlist-tracks.ts).

## Server-side rendering

Server-side rendering is not supported yet. TanStack's `dehydrate`, JSON and `hydrate` round trip strips the non-enumerable `$`-accessors from a materialised result, so a hydrated read would render without its `$page`, `$next()` and the rest.

`installNormalization` guards against that for every framework binding:

- A query holding a client result, whether a binding read, an infinite read or a query you build yourself around a client call, is left out of `dehydrate()` through a `shouldDehydrateQuery` default, composed with any default you set before installing, so it fetches in the browser. A query holding plain data is dehydrated as usual, whatever its key.
- A query with the binding's key shape (a type, then `fetchMany`, `fetchOne`, `fetchRelated` or `fetchRelationship`) that still arrives hydrated without its accessors is reset, so it refetches, and a development warning names its key. Stripped data looks like plain data, so this check goes by key shape. A reset query that nothing is observing is left empty, and fetches when a component first uses it.

A `dehydrate()` call with explicit options overrides the defaults. Wrap your own predicate in `jsonApiShouldDehydrateQuery` to keep the exclusion. It judges each query by its data, so it needs no descriptor:

```ts
import { defaultShouldDehydrateQuery } from '@tanstack/query-core'
import { jsonApiShouldDehydrateQuery } from '@haddowg/json-api-query'

dehydrate(queryClient, {
  shouldDehydrateQuery: jsonApiShouldDehydrateQuery(
    (query) => defaultShouldDehydrateQuery(query) && query.queryKey[0] !== 'session',
  ),
})
```

A query still pending when you dehydrate has no data to judge, so the predicate passes it to yours. Including pending queries, as TanStack's streaming setup does, sends a pending client read's result through JSON without its accessors.

The cost is a refetch in the browser, so the first render can differ from the server HTML.

## See it in the example app

The spotify-clone wires the whole binding end to end over a mock transport:

- [client.ts](../examples/spotify-clone/src/api/client.ts) — `installNormalization` + `createQueryApi` / `createMutationApi` at bootstrap;
- [main.tsx](../examples/spotify-clone/src/main.tsx) — the `QueryClientProvider` around the app;
- [AlbumDetailPage.tsx](../examples/spotify-clone/src/pages/AlbumDetailPage.tsx) — a read with `include`;
- [PlaylistDetailPage.tsx](../examples/spotify-clone/src/pages/PlaylistDetailPage.tsx) — optimistic update + relationship mutations.

And the tested reference: the `TanStack Query bindings` and `infinite queries` groups in [example.test.ts](../packages/example/src/example.test.ts), plus the package's own [README](../packages/query/README.md).

**Next:** [reads.md](reads.md) · [writes.md](writes.md) · [relationship-mutation.md](relationship-mutation.md)
