# TanStack Query

`@haddowg/json-api-query` layers TanStack Query over the typed client: **option factories** you spread into `useQuery` / `useMutation`, a deterministic query-key factory, and bespoke `type:id` write-through cache normalisation — "edit once, updates everywhere".

The binding exposes **option factories, not pre-bound hooks**, over `@tanstack/query-core`. One package therefore covers React / Vue / Svelte / Solid — you pass the returned `{ queryKey, queryFn }` / `MutationOptions` to your framework's own `useQuery` / `useMutation`. Reads keep the client's full static narrowing (`include` widens, sparse `fields` narrows) end to end.

```bash
pnpm add @haddowg/json-api-query @tanstack/query-core
```

`@tanstack/query-core` is a peer dependency (your framework adapter — `@tanstack/react-query` etc. — brings it in).

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

Each read factory returns a plain `{ queryKey, queryFn }`, structurally compatible with query-core's `QueryOptions`. Spread it into `useQuery` — the result type is the client's own materialised view, so `include` and `fields` narrow it exactly as a direct client call would.

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

See [reads.md](reads.md), [includes-and-sparse-fieldsets.md](includes-and-sparse-fieldsets.md), and [pagination.md](pagination.md) for the underlying read surface these factories wrap.

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

You never write cache upkeep by hand: the binding invalidates and patches for you (next section). See [writes.md](writes.md) for the create/update/delete surface, and [relationship-mutation.md](relationship-mutation.md) for `add`/`remove`/`replace`/`set`.

## Deterministic query keys

Keys are stable, hierarchical readonly tuples — `[type, operation, id?, rel?, params?]`. The hierarchy is a contract: TanStack matches by prefix, so `[type]` addresses a whole type, `[type, 'fetchOne', id]` a single resource. The trailing `params` segment is **normalised** (object keys sorted recursively, absent params dropped), so two semantically-equal queries share one key — and `list()` and `list({})` collapse to the same key.

```ts
import { typeKey, resourceKey } from '@haddowg/json-api-query'

queryClient.invalidateQueries({ queryKey: typeKey('albums') }) // every albums read
queryClient.invalidateQueries({ queryKey: resourceKey('albums', '1') }) // one album's reads
```

You rarely build a key yourself — the factories embed the right key, and normalisation drives invalidation from mutations. The helpers (`keyFor`, `typeKey`, `operationKey`, `resourceKey`, `relationKey`, `relationReadKeys`, `normalizeParams`) are exported for the cases where you need a targeted invalidation of your own.

## Normalisation: `type:id` write-through patching

TanStack Query is not a normalised cache — it keeps each result denormalised under its own key. JSON:API's guarantee that every resource carries `type`+`id` lets this package normalise with **zero configuration** (ADR 0003, Strategy 2). On every successful response it indexes each resource (`data` + `included`) by `type:id` and **patches every cached query holding that `type:id` in place**. Edit an album's title once, and every cached list, single-get, and included copy reflects it — no refetch.

`installNormalization` wires this to fire automatically on every successful query and mutation:

```ts
const teardown = installNormalization(queryClient, resourceMap)
// … later, e.g. in a test teardown: teardown() removes the subscriptions.
```

A patch replaces a node's **attributes** (the descriptor knows attributes from relations) while **preserving** each materialised object's edge-local `$pivot` / `$edge` and its identity — the same Track in two playlists keeps its own per-edge pivot data while its shared attributes update.

!!! warning "One descriptor per QueryClient"
    The patch matches by `type:id` alone, so two descriptors sharing a QueryClient would cross-contaminate attributes (e.g. a `default` and an `admin` server whose `users` differ). Installing a *different* descriptor on the same QueryClient throws. Give each typed client/server its own QueryClient.

### The patch-vs-invalidate split

Not every write is a node patch. The binding splits by what the write changes (ADR 0003):

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

## See it in the example app

The spotify-clone wires the whole binding end to end over a mock transport:

- [client.ts](../examples/spotify-clone/src/api/client.ts) — `installNormalization` + `createQueryApi` / `createMutationApi` at bootstrap;
- [main.tsx](../examples/spotify-clone/src/main.tsx) — the `QueryClientProvider` around the app;
- [AlbumDetailPage.tsx](../examples/spotify-clone/src/pages/AlbumDetailPage.tsx) — a read with `include`;
- [PlaylistDetailPage.tsx](../examples/spotify-clone/src/pages/PlaylistDetailPage.tsx) — optimistic update + relationship mutations.

And the tested reference: the `TanStack Query bindings` group in [example.test.ts](../packages/example/src/example.test.ts), plus the package's own [README](../packages/query/README.md).

**Next:** [reads.md](reads.md) · [writes.md](writes.md) · [relationship-mutation.md](relationship-mutation.md)
