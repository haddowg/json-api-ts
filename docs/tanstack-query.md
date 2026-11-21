# TanStack Query

`@haddowg/json-api-query` layers TanStack Query over the typed client: **option factories** you spread into `useQuery` / `useMutation`, a deterministic query-key factory, and bespoke `type:id` write-through cache normalisation — "edit once, updates everywhere".

The binding exposes **option factories, not pre-bound hooks**, over `@tanstack/query-core`. One package therefore covers React / Vue / Svelte / Solid — you pass the returned `{ queryKey, queryFn }` / `MutationOptions` to your framework's own `useQuery` / `useMutation`. Reads keep the client's full static narrowing (`include` widens, sparse `fields` narrows) end to end.

```bash
npm install @haddowg/json-api-query @tanstack/query-core
```

`@tanstack/query-core` (5.89 or later) is a peer dependency (your framework adapter — `@tanstack/react-query` etc. — brings it in).

## Bind the client once

Two bound APIs sit over the generated client, built once at bootstrap. `createQueryApi` gives you per-type read factories; `createMutationApi` gives you the write factories.

The `QueryClient` is built with a `JsonApiMutationCache`, which runs every write's cache upkeep, and the generated `resourceMap` descriptor is installed on it with `installNormalization`:

```ts
import {
  createMutationApi,
  createQueryApi,
  installNormalization,
  JsonApiMutationCache,
} from '@haddowg/json-api-query'
import { QueryClient } from '@tanstack/react-query'
import { createClient, resourceMap } from '../generated/music-catalog.gen'

export const client = createClient({ baseUrl: 'https://music.example' })

export const queryClient = new QueryClient({
  // Runs each mutation's normalisation, invalidation and optimistic rollback.
  mutationCache: new JsonApiMutationCache(),
  defaultOptions: { queries: { staleTime: 30_000, retry: false } },
})

// `type:id` write-through patching (see below) — a change to any resource updates every cached view.
installNormalization(queryClient, resourceMap)

export const reads = createQueryApi(client)
export const writes = createMutationApi(queryClient, client, resourceMap)
```

That is exactly how the example app bootstraps its data layer — see [client.ts](../examples/spotify-clone/src/api/client.ts).

!!! note "Action-agnostic at the query boundary"
    The factories read only a client's resource accessors and its error codes, never its custom-action types (actions aren't cacheable resources), so the generated client passes straight through, as above. If your setup needs to name the client's type, for a context or a prop, keep every `Client` parameter, the generated `ErrorCode` included, or `error` falls back to any string code: `Client<ResourceMap, Attributes, WriteAttributes, ActionTypes, ErrorCode, Links>`, which is the generated `createClient`'s return type.

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

This runs under `pnpm test` in [example.test.ts](../packages/example/src/example.test.ts) (the `TanStack Query bindings` group). It fetches an album with its artist, then reads and writes the cache through the options' key:

```ts
const albumOptions = reads.albums.get('1', { include: ['artist'] })
await queryClient.fetchQuery(albumOptions)

// The key is tagged with the read's result type, so the cache hands back the album view.
const cached = queryClient.getQueryData(albumOptions.queryKey) // the album view | undefined
expect(cached?.title).toBe('OK Computer')
expect(cached?.artist?.name).toBe('Radiohead')

// `old` is the album view too.
queryClient.setQueryData(albumOptions.queryKey, (old) => old)
```

### Typed errors and retries

TanStack types a query's `error` from a typed callback in its options, so each factory's options type declares an optional `retry` typed with what a read rejects with: `ReadError<ErrorCode>`, which is `JsonApiError<ErrorCode> | StructuralGuardError | Error`, `ErrorCode` being the generated client's error-code union. The options never set `retry`, so the `retry` your QueryClient is configured with still applies.

This runs under `pnpm test` in [example.test.ts](../packages/example/src/example.test.ts) (the `TanStack Query bindings` group). It reads an album the server answers with a `404`, through a `QueryObserver` standing in for `useQuery`:

```ts
import { hasErrorCode } from '../generated/music-catalog.gen'

// What `useQuery(reads.albums.get('404'))` holds once the read settles.
const albumQuery = await new QueryObserver(queryClient, reads.albums.get('404')).refetch()
expectTypeOf(albumQuery.error).toEqualTypeOf<ReadError<ErrorCode> | null>()
if (hasErrorCode(albumQuery.error, 'RESOURCE_NOT_FOUND')) {
  const errors: JsonApiErrorObject<ErrorCode>[] = albumQuery.error.errors
  expect(errors[0]?.code).toBe('RESOURCE_NOT_FOUND')
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

This runs under `pnpm test` in [example.test.ts](../packages/example/src/example.test.ts) (the `TanStack Query bindings` group), with a `QueryObserver` per read standing in for `useQuery`, and `skipToken` imported from `@tanstack/query-core` (your framework adapter re-exports it):

```ts
import { skipToken } from '@tanstack/query-core'

const albumQuery = new QueryObserver(queryClient, reads.albums.get(albumId ?? skipToken))
const albumsQuery = new QueryObserver(
  queryClient,
  reads.albums.list(ready ? { include: ['artist'] } : skipToken),
)
const artistQuery = new QueryObserver(
  queryClient,
  reads.albums.related(albumId ?? skipToken, 'artist'),
)

// A skipped read stays idle and sends nothing, under a deterministic key with no params.
expect(requests).toHaveLength(0)
expect(reads.albums.get(albumId ?? skipToken).queryKey).toEqual([
  'albums',
  'fetchOne',
  { $skip: true },
])
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

`reads.<type>.relatedInfinite(id, rel, query)` pages a to-many relation's related collection the same way. A to-one relation is a compile error there, having no pages, as is a to-many whose related read the descriptor records as unpaginated (paginator `'none'`, the relation's own or else its related type's), and a singleton drops the id, as its other reads do. A type whose collection paginator is `'none'` has no `infinite` at all. The standalone forms are `infiniteListQueryOptions(client, type, query)` and `infiniteRelatedQueryOptions(client, type, id, rel, query)`, which refuse the same unpaginated types and relations.

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

Mutation factories return a `MutationOptions`: a `mutationKey`, the `mutationFn`, and a `meta` describing the write's cache upkeep. Pass it to `useMutation` (or Angular's `injectMutation`); the variables mirror the client (`create()` takes the flat create input, `update()` the patch, and so on).

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

You never write cache upkeep by hand: the binding invalidates and patches for you ([the split](#the-patch-vs-invalidate-split) says what each verb does). See [writes.md](writes.md) for the create/update/delete surface, and [relationship-mutation.md](relationship-mutation.md) for `add`/`remove`/`replace`/`set`.

### Your own callbacks

The options carry no lifecycle callbacks, so spread them and add your own:

```ts
const rename = useMutation({
  ...writes.playlists.id(id).update({ optimistic: true }),
  onSuccess: () => toast('Renamed'),
  onError: (error) => toast(`Rename failed: ${String(error)}`),
  onSettled: () => closeDialog(),
})
```

Your `onMutate`, `onSuccess`, `onError` and `onSettled` replace nothing: the upkeep still normalises, invalidates and rolls back. They run after it, against a cache that's already reconciled, and your `onMutate`'s result is the mutation's context, as TanStack always passes it.

### How the upkeep runs

Each factory describes its upkeep as plain data in `meta.jsonApi`: the verb, type, id, relation, and whether it's optimistic.

```ts
writes.albums.id('1').update({ optimistic: true }).meta
// { jsonApi: { verb: 'update', type: 'albums', id: '1', optimistic: true } }
```

`JsonApiMutationCache` reads that plan from its own `onMutate`, `onError`, `onSuccess` and `onSettled` hooks, which TanStack awaits before the mutation's callbacks of the same name. `onMutate` applies the optimistic change, `onError` rolls it back, `onSuccess` normalises the result, and `onSettled` invalidates and returns the promise, so the mutation stays pending until the refetches it starts have finished. A mutation whose `meta` carries no plan, such as one of your own, is left alone.

To add a `meta` of your own, merge it with the factory's rather than replacing it:

```ts
useMutation({ ...options, meta: { ...options.meta, analytics: 'rename' } })
```

`JsonApiMutationCache` takes TanStack's `MutationCache` config, and runs each hook you give it after the upkeep of the same name, for every mutation:

```ts
new QueryClient({
  mutationCache: new JsonApiMutationCache({ onError: (error) => reportError(error) }),
})
```

### When the upkeep can't run

A JSON:API mutation refuses to run where its upkeep would be skipped, rather than leaving the cache stale. Before it sends anything, it throws an `Error` naming the fix when:

- the `QueryClient`'s mutation cache isn't a `JsonApiMutationCache`;
- no descriptor is installed on the `QueryClient` with `installNormalization`;
- its `meta` was replaced, so the plan is gone.

### Mutation keys

Every mutation is keyed `[type, verb, id?, rel?]`, the id left out for a create and for a singleton, as a singleton's read keys leave it out. An atomic batch is keyed `['$atomic']` (`ATOMIC_MUTATION_KEY`). `mutationKeyFor` builds a key, and TanStack's mutation filters match by prefix, so a key can address every write on a type, every update of it, or one resource's:

```ts
import { useIsMutating, useMutationState } from '@tanstack/react-query'
import { mutationKeyFor } from '@haddowg/json-api-query'

useIsMutating({ mutationKey: ['albums'] }) // any write on albums
useIsMutating({ mutationKey: mutationKeyFor({ type: 'albums', verb: 'update', id }) }) // this album's updates
useMutationState({
  filters: { mutationKey: mutationKeyFor({ type: 'playlists', verb: 'add', id, rel: 'orderedTracks' }), status: 'pending' },
  select: (mutation) => mutation.state.variables,
})
```

A key only ever grows by trailing segments, so a filter you write keeps matching.

??? note "Migrating from callbacks on the options"
    The factories used to carry the upkeep in their own `onSuccess`, `onSettled`, `onMutate` and `onError`, which a spread callback silently replaced. Now it runs in the mutation cache, so the one change is how the `QueryClient` is built:

    ```ts
    const queryClient = new QueryClient({ mutationCache: new JsonApiMutationCache() })
    installNormalization(queryClient, resourceMap)
    ```

    A mutation on a `QueryClient` built without it throws. The factories' `queryClient` argument is no longer used, since the upkeep runs on the `QueryClient` the mutation runs on; it stays for now so existing calls compile. The options no longer carry callbacks, so code that called `options.onMutate` or `options.onSuccess` directly runs the mutation through a `QueryClient` instead.

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

When two responses for the same resource race, the one requested later wins, whatever order they arrive in. Each read and write remembers when its request started, and each cached copy of an attribute remembers which request it came from, so an older response that arrives last only fills in attributes the newer one didn't carry, and its own query shows the newer values too. Data hydrated or restored into the cache counts as older than any request the page makes.

The patch matches by `type:id` alone, so one QueryClient holds one descriptor per scope: installing a *different* descriptor in a scope that already has one throws. To share a QueryClient between servers, give each its own scope, as [Several servers](#several-servers) shows.

### The patch-vs-invalidate split

Not every write is a node patch. A write whose response carries a resource or linkage **patches** it into the cache via `normalize` on success, with no refetch; a write that may change what a list or relation holds **invalidates** the reads it affects on settle, success or error, so they refetch (a patch can't insert or remove a member). Each verb does:

| Verb | On success | On settle |
| --- | --- | --- |
| `create()` | patches the new resource (not an `Accepted` job) | invalidates the type's lists |
| `update()` | patches the resource (not an `Accepted` job) | nothing |
| `delete()` | nothing | invalidates the type's lists and the resource's own reads |
| relationship `set()` / `replace()` | patches the returned linkage | invalidates the parent's reads of the relation, and the parent itself |
| relationship `add()` / `remove()` | nothing | invalidates the parent's reads of the relation, and the parent itself |
| `atomic()` | patches every result | nothing |

A relationship write never invalidates the type's collection lists: it never alters which resources a collection holds. The parent itself is invalidated because a read that `include`s the relation embeds its now-stale members.

### Tested: reads via factories, write-through on update

This runs under `pnpm test` in [example.test.ts](../packages/example/src/example.test.ts) (the `TanStack Query bindings` group). It seeds a list and a single-get, then updates the album — both cached reads reflect the fresh title **without a refetch**, because the update patched them by `type:id`:

```ts
const qc = new QueryClient({
  mutationCache: new JsonApiMutationCache(),
  defaultOptions: { queries: { staleTime: Infinity } },
})
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
    For reads alone, you can skip `installNormalization` and call `normalize(queryClient, result, resourceMap)` yourself from a query's success path. It runs the identical write-through patch. The install path is a convenience that subscribes once to the query and mutation caches (guarded against re-entrancy so a patch pass doesn't cascade into a loop). The mutation factories need it: their upkeep reads the installed descriptor, and a mutation on a `QueryClient` without one throws.

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

Under the hood, in `JsonApiMutationCache`: `onMutate` pre-applies the expected change through the normalised patch (an update's attribute keys; a relationship verb's membership transform across every cached page of the `(parent, relation)` read, matched by key prefix) and snapshots the touched queries; `onError` restores the snapshot, before your own `onError` runs; `onSettled` invalidates so the server reconciles (a degraded optimistic member — a bare identifier — is replaced by the fully-hydrated one on the refetch). Because the forward patch preserves per-edge `$pivot` / `$edge`, an optimistic add of a hydrated member renders a rich row immediately.

The example app's playlist detail page wires all four of these — rename, add track, remove track, reorder — see [PlaylistDetailPage.tsx](../examples/spotify-clone/src/pages/PlaylistDetailPage.tsx) and its optimistic helpers in [playlist-tracks.ts](../examples/spotify-clone/src/api/playlist-tracks.ts).

## Several servers

Two servers can share one QueryClient, each in its own **scope**, even where both name a type `users` with different attributes. A scope leads every key the server's reads and writes carry with a `{ $scope }` segment, an object so it can never collide with a type name:

```ts
import {
  createMutationApi,
  createQueryApi,
  installNormalization,
  JsonApiMutationCache,
} from '@haddowg/json-api-query'

const queryClient = new QueryClient({ mutationCache: new JsonApiMutationCache() })

// The main server, unscoped: its keys are as they always are.
installNormalization(queryClient, mainMap)
export const reads = createQueryApi(mainClient)
export const writes = createMutationApi(queryClient, mainClient, mainMap)

// The admin server, in scope `admin`.
installNormalization(queryClient, adminMap, { scope: 'admin' })
export const adminReads = createQueryApi(adminClient, { scope: 'admin' })
export const adminWrites = createMutationApi(queryClient, adminClient, adminMap, { scope: 'admin' })

adminReads.users.list().queryKey // [{ $scope: 'admin' }, 'users', 'fetchMany']
adminWrites.users.id(id).update().mutationKey // [{ $scope: 'admin' }, 'users', 'update', id]
```

Each scope is kept apart:

- an install normalises only the queries keyed in its own scope, and an unscoped install only unscoped ones, so a read of the admin `users:1` never overwrites the main server's cached copy;
- a scoped mutation's plan carries its scope, so the upkeep runs against the descriptor installed for that scope, patches and optimistically edits only that scope's queries, and invalidates only within it;
- one descriptor per scope: installing a different descriptor in a scope that has one throws, and the scope is released once its last install is torn down.

The client-wide defaults `installNormalization` sets, the dehydrate predicate and `jsonApiRetry`, are installed by the first install on a QueryClient, of any scope, and removed with the last teardown. The [SSR guard](#server-side-rendering) judges a scoped read by its data like any other, and its browser-side check recognises a key led by `{ $scope }` as a binding read's, each scope's install checking only that scope's queries.

The standalone factories take no scope argument; scope their options with `withScope`, which leads the `queryKey` or `mutationKey` with the scope segment and, for a mutation, puts the scope in its plan:

```ts
import { listQueryOptions, updateMutationOptions, withScope } from '@haddowg/json-api-query'

useQuery(withScope('admin', listQueryOptions(adminClient, 'users')))
useMutation(withScope('admin', updateMutationOptions(queryClient, adminClient, adminMap, 'users', id)))
```

Every key helper takes the scope as its last argument, so you can target one server's queries: `typeKey('users', 'admin')`, `operationKey('users', 'fetchMany', 'admin')`, `resourceKey('users', id, 'admin')`, `relationKey(…, 'admin')`, `relationReadKeys(…, 'admin')`, and `scope` on `keyFor`, `infiniteKeyFor` and `mutationKeyFor`'s targets. TanStack matches by prefix, so an unscoped prefix such as `['users']` never reaches into a scope, and `[{ $scope: 'admin' }]` matches every query or mutation in it:

```ts
queryClient.invalidateQueries({ queryKey: typeKey('users', 'admin') }) // the admin server's users
useIsMutating({ mutationKey: [{ $scope: 'admin' }] }) // any admin write
```

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
    (query) => defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
  ),
})
```

A query still pending when you dehydrate has no data to judge, so the predicate passes it to yours. When yours includes pending queries, as TanStack's streaming setup does, a pending binding read resolves in the browser without its accessors, so it is reset and refetched there as it resolves, with the same development warning.

The cost is a refetch in the browser, so the first render can differ from the server HTML.

## See it in the example app

The spotify-clone wires the whole binding end to end over a mock transport:

- [client.ts](../examples/spotify-clone/src/api/client.ts) — the `QueryClient` with `JsonApiMutationCache`, `installNormalization`, and `createQueryApi` / `createMutationApi` at bootstrap;
- [main.tsx](../examples/spotify-clone/src/main.tsx) — the `QueryClientProvider` around the app;
- [AlbumDetailPage.tsx](../examples/spotify-clone/src/pages/AlbumDetailPage.tsx) — a read with `include`;
- [PlaylistDetailPage.tsx](../examples/spotify-clone/src/pages/PlaylistDetailPage.tsx) — optimistic update + relationship mutations.

And the tested reference: the `TanStack Query bindings` and `infinite queries` groups in [example.test.ts](../packages/example/src/example.test.ts), plus the package's own [README](../packages/query/README.md).

**Next:** [reads.md](reads.md) · [writes.md](writes.md) · [relationship-mutation.md](relationship-mutation.md)
