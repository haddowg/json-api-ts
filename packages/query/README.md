# @haddowg/json-api-query

> **Part of the [jsonapi.rest](https://jsonapi.rest) suite** — a complete, spec-compliant
> JSON:API 1.1 stack: a framework-agnostic PHP [core](https://github.com/haddowg/json-api), a
> [Symfony bundle](https://github.com/haddowg/json-api-symfony), a
> [Laravel package](https://github.com/haddowg/json-api-laravel), and this **typed TypeScript
> client**, bound together by one conformance-tested OpenAPI 3.1 contract.
> Full documentation: **[haddowg.github.io/json-api-ts](https://haddowg.github.io/json-api-ts/)**.

TanStack Query bindings for the [`@haddowg/json-api-client`](../client) runtime: query/mutation
**option factories** (not pre-bound hooks), a deterministic query-key factory, and bespoke
`type:id` write-through cache normalization.

Because the surface is option factories over `@tanstack/query-core`, one binding covers
React / Vue / Svelte / Solid — you pass the returned `{ queryKey, queryFn }` / `MutationOptions`
to your framework's `useQuery` / `useMutation`.

## Install

```bash
pnpm add @haddowg/json-api-query @tanstack/query-core
```

`@tanstack/query-core` (5.89 or later) is a peer dependency.

## Binding the client

The factories read only a client's resource accessors and its error codes, never its
custom-action types (actions aren't cacheable resources), so the generated client passes straight
through. When you need to name its type, for a context or a prop, keep every `Client` parameter,
the generated `ErrorCode` included, so `error` keeps the server's codes rather than any string:

```ts
import type { Client } from '@haddowg/json-api-client'
import { createClient } from './api/music.gen'
import type {
  ActionTypes,
  Attributes,
  ErrorCode,
  Links,
  ResourceMap,
  WriteAttributes,
} from './api/music.gen'

// The generated `createClient`'s return type.
type ApiClient = Client<ResourceMap, Attributes, WriteAttributes, ActionTypes, ErrorCode, Links>

const client: ApiClient = createClient({ baseUrl: 'https://music.example' })
```

## Reads — query option factories

Each factory returns a plain `{ queryKey, queryFn }`, structurally compatible with query-core's
`QueryOptions`, preserving the client's full static narrowing (`include` widens, `fields`
narrows). Two equivalent forms:

```ts
import { createQueryApi, listQueryOptions } from '@haddowg/json-api-query'

// Bound API — the cleanest per-type call shape.
const reads = createQueryApi(client)
const listOpts = reads.albums.list({ include: ['artist'] })
const getOpts = reads.albums.get('1')
const relOpts = reads.albums.relationship('1', 'tracks') // linkage
const relatedOpts = reads.albums.related('1', 'tracks') // related collection

// Standalone factories — equivalent, with `client`/`type` passed explicitly.
const listOpts2 = listQueryOptions(client, 'albums', {
  include: ['artist'],
})

// Pass to your framework's useQuery, or fetch directly:
const albums = await queryClient.fetchQuery(listOpts)
```

The standalone factories are `listQueryOptions`, `getQueryOptions`, `relationshipQueryOptions`,
`relatedQueryOptions`.

Each key is tagged with the read's result, so `queryClient.getQueryData(getOpts.queryKey)` is
typed, and the options' type declares a `retry` that types the query's `error` as
`ReadError<ErrorCode>` without setting one, so your QueryClient's `retry` still applies. When you
configure none, `installNormalization` installs `jsonApiRetry`, which doesn't retry a 4xx
JSON:API error or a response that isn't a JSON:API document. An id (or a list's query) accepts
`skipToken`.

Infinite reads page a list, or a to-many relation's related collection, through its `next`/`prev`
links: `reads.albums.infinite(query)` and `reads.albums.relatedInfinite('1', 'tracks', query)`
(standalone, `infiniteListQueryOptions` and `infiniteRelatedQueryOptions`) return options for
`useInfiniteQuery` or `fetchInfiniteQuery`. Their key is the plain read's key plus `'$infinite'`,
and normalisation patches every cached page. A type or to-many relation whose paginator is
`'none'` has no infinite read: it is a compile error.

## The query-key factory

Keys are stable, hierarchical readonly tuples — `[type, operation, id?, rel?, params?]`. The
hierarchy is the contract targeted invalidation leans on (TanStack matches by prefix): `[type]`
invalidates a whole type, `[type, operation]` an operation's subtree, `[type, 'fetchOne', id]` a
single resource. Params ride the last segment as a normalised object, so two semantically-equal
queries (keys reordered, equal values) share one key.

```ts
import { keyFor, operationKey, resourceKey, typeKey } from '@haddowg/json-api-query'

keyFor({ type: 'albums', operation: 'fetchOne', id: '1' }) // ['albums', 'fetchOne', '1']
typeKey('albums') // ['albums']
operationKey('albums', 'fetchMany') // ['albums', 'fetchMany']
resourceKey('albums', '1') // ['albums', 'fetchOne', '1']

queryClient.invalidateQueries({ queryKey: typeKey('albums') }) // every albums read
```

Also exported: `infiniteKeyFor`, `relationKey`, `normalizeParams`, and the helpers for reading and scoping keys (`keyHasPrefix`, `parentRelationReadKeys`, `scopedKey`, `scopeSegment`, `scopeOf`, `isScopeSegment`, `INFINITE_SEGMENT`, `SKIPPED_SEGMENT`), described in the [TanStack Query guide](https://haddowg.github.io/json-api-ts/tanstack-query/#reading-and-building-keys-yourself).

A singleton type's keys leave out the id (`['inboxes', 'fetchOne']`). Its factories take
`undefined` for the id, which the types allow only for a singleton, and the bound API drops the
argument: `reads.inboxes.get()`, `writes.inboxes.update()`, whose variables carry the resource's
`id` for the request body.

## Normalization (`type:id` write-through patching)

TanStack keeps denormalized results; this package indexes every resource (`data` + `included`) by
`type:id` and, on a change, **patches every cached query holding that `type:id` in place** — "edit
once, updates everywhere". Patching replaces a node's _attributes_ (the descriptor knows attributes
vs relations) while preserving edge-local `$pivot` / `$edge`. Each touched query then gets a new
root reference over the same value, so components observing it re-render. The read factories set
`structuralSharing: false`, since structural sharing would rebuild a refetched value as plain arrays
and objects without its `$page`, `$next()` or `$self`; set it on any query you build yourself.

`installNormalization` auto-runs the patch on every successful query/mutation. Build the
QueryClient with a `JsonApiMutationCache`, which runs each write's cache upkeep:

```ts
import { installNormalization, JsonApiMutationCache } from '@haddowg/json-api-query'
import { resourceMap } from './api/music.gen'
import { QueryClient } from '@tanstack/query-core'

const queryClient = new QueryClient({ mutationCache: new JsonApiMutationCache() })
const teardown = installNormalization(queryClient, resourceMap)
// … later: teardown() removes the subscriptions.
```

> **One descriptor per scope.** The patch matches by `type:id` alone, so installing a _different_
> descriptor in a scope that already has one throws. Several servers share a QueryClient in their
> own scopes: `installNormalization(queryClient, adminMap, { scope: 'admin' })`,
> `createQueryApi(adminClient, { scope: 'admin' })` and
> `createMutationApi(queryClient, adminClient, adminMap, { scope: 'admin' })` lead every key with
> `{ $scope: 'admin' }`, and each scope is normalised, patched and invalidated apart from the
> others. `withScope(scope, options)` scopes a standalone factory's options.

For reads alone you can skip the install and call `normalize(queryClient, result, resourceMap)`
yourself — the same write-through patch. The mutation factories need the descriptor installed.

## Writes — mutation option factories

Each returns a `MutationOptions` — `{ mutationKey, mutationFn, meta }` — structurally compatible
with query-core. `meta.jsonApi` is a plain-data plan of the write's cache upkeep, which
`JsonApiMutationCache` runs from its awaited hooks, before the mutation's own callbacks. The
options carry no callbacks, so spread them and add your own `onMutate` / `onSuccess` / `onError` /
`onSettled` freely: they run after the upkeep and never replace it. A mutation on a QueryClient
without `JsonApiMutationCache`, or without an installed descriptor, throws before it writes. The
**patch-vs-invalidate split**:

- an **update** patches the resource via `normalize` on success (no refetch);
- a **create** patches the new resource on success and invalidates the type's lists on settle; a
  **delete** removes the resource's own reads on success and invalidates the type's lists, and
  every other query that held it, on settle;
- a relationship **set** / **replace** patches the returned linkage on success, and every
  relationship write invalidates the parent's reads of the relation, and the parent, on settle.

```ts
import { createMutationApi } from '@haddowg/json-api-query'

const writes = createMutationApi(queryClient, client, resourceMap)

// Create — invalidates the type's lists on settle; normalizes the new resource on success.
const createOpts = writes.albums.create()

// Update — patches across the cache on success. `{ optimistic: true }` applies the patch (its
// attributes and relations) before the write and rolls it back on error.
const updateOpts = writes.albums.id('1').update({ optimistic: true })

// Delete — removes the resource's own reads, and invalidates the type's lists.
const deleteOpts = writes.albums.id('1').delete()

// Relationship mutations — invalidate the parent's relation reads (never the type's lists).
const addOpts = writes.albums.id('1').rel('tracks').add()
const setOpts = writes.albums.id('1').rel('artist').set()
```

Every mutation is keyed `[type, verb, id?, rel?]` (`['$atomic']` for a batch), built by
`mutationKeyFor`, so mutation filters find writes by prefix:

```ts
import { mutationKeyFor } from '@haddowg/json-api-query'

queryClient.isMutating({ mutationKey: ['albums'] }) // any write on albums
queryClient.isMutating({ mutationKey: mutationKeyFor({ type: 'albums', verb: 'update', id: '1' }) })
```

The variables a mutation takes mirror the client: `create()` takes the flat create input,
`update()` the patch, `add/remove/replace()` the linkage refs, `set()` a ref or `null`.

The standalone factories are `createMutationOptions`, `updateMutationOptions`,
`deleteMutationOptions`, `addRelationshipMutationOptions`, `removeRelationshipMutationOptions`,
`replaceRelationshipMutationOptions`, `setRelationshipMutationOptions`, and a thin
`atomicMutationOptions` passthrough.

### Worked example (query-core directly)

```ts
const reads = createQueryApi(client)
const writes = createMutationApi(queryClient, client, resourceMap)

const listOpts = reads.albums.list()
const getOpts = reads.albums.get('1')
await queryClient.fetchQuery(listOpts)
await queryClient.fetchQuery(getOpts)

const updateOpts = writes.albums.id('1').update()
await queryClient
  .getMutationCache()
  .build(queryClient, updateOpts as never)
  .execute({ title: 'Fresh title' })

// Both the cached list AND the cached get now reflect the fresh title — patched by `type:id`,
// not refetched.
queryClient.getQueryData(listOpts.queryKey)
queryClient.getQueryData(getOpts.queryKey)
```

## License

MIT
