# @haddowg/json-api-query

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

`@tanstack/query-core` is a peer dependency.

## Binding the client

The read factories accept `Client<D, A>` and the write factories `Client<D, A, W>` — neither
carries the client's custom-action types (actions aren't cacheable resources). The generated
`createClient` returns a client that _also_ carries action types, so view it through the
action-agnostic `Client` types at the query boundary — one cast per surface:

```ts
import type { Client } from '@haddowg/json-api-client'
import { createClient } from './api/music.gen'
import type { Attributes, ResourceMap, WriteAttributes } from './api/music.gen'

const client = createClient({ baseUrl: 'https://music.example' })

type ReadClient = Client<ResourceMap, Attributes>
type WriteClient = Client<ResourceMap, Attributes, WriteAttributes>
```

## Reads — query option factories

Each factory returns a plain `{ queryKey, queryFn }`, structurally compatible with query-core's
`QueryOptions`, preserving the client's full static narrowing (`include` widens, `fields`
narrows). Two equivalent forms:

```ts
import { createQueryApi, listQueryOptions } from '@haddowg/json-api-query'

// Bound API — the cleanest per-type call shape.
const reads = createQueryApi(client as unknown as ReadClient)
const listOpts = reads.albums.list({ include: ['artist'] })
const getOpts = reads.albums.get('1')
const relOpts = reads.albums.relationship('1', 'tracks') // linkage
const relatedOpts = reads.albums.related('1', 'tracks') // related collection

// Standalone factories — equivalent, with `client`/`type` passed explicitly.
const listOpts2 = listQueryOptions(client as unknown as ReadClient, 'albums', {
  include: ['artist'],
})

// Pass to your framework's useQuery, or fetch directly:
const albums = await queryClient.fetchQuery(listOpts)
```

The standalone factories are `listQueryOptions`, `getQueryOptions`, `relationshipQueryOptions`,
`relatedQueryOptions`.

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

Also exported: `relationKey`, `normalizeParams`.

## Normalization (`type:id` write-through patching)

TanStack keeps denormalized results; this package indexes every resource (`data` + `included`) by
`type:id` and, on a change, **patches every cached query holding that `type:id` in place** — "edit
once, updates everywhere". Patching replaces a node's _attributes_ (the descriptor knows attributes
vs relations) while preserving edge-local `$pivot` / `$edge`.

`installNormalization` auto-runs the patch on every successful query/mutation:

```ts
import { installNormalization } from '@haddowg/json-api-query'
import { resourceMap } from './api/music.gen'
import { QueryClient } from '@tanstack/query-core'

const queryClient = new QueryClient()
const teardown = installNormalization(queryClient, resourceMap)
// … later: teardown() removes the subscriptions.
```

> **One descriptor per QueryClient.** The patch matches by `type:id` alone, so two descriptors
> sharing a QueryClient would cross-contaminate attributes. Installing a _different_ descriptor on
> the same QueryClient throws. Give each typed client/server its own QueryClient.

Prefer explicit control? Skip the install and call `normalize(queryClient, result, resourceMap)`
from an option factory's `onSuccess` — same write-through patch.

## Writes — mutation option factories

Each returns a `MutationOptions` (`mutationFn` + the lifecycle callbacks the binding wires for
normalization / invalidation / optimism), structurally compatible with query-core. The
**patch-vs-invalidate split**:

- an **update** (or a relationship `set` / `replace`) only changes a node's attributes/linkage →
  on success it patches via `normalize` (no refetch);
- a **create** / **delete** changes collection membership → on settle it invalidates the relevant
  list / relationship subtrees so they refetch.

```ts
import { createMutationApi } from '@haddowg/json-api-query'

const writes = createMutationApi(queryClient, client as unknown as WriteClient, resourceMap)

// Create — invalidates the type's lists on settle; normalizes the new resource on success.
const createOpts = writes.albums.create()

// Update — patches across the cache on success. `{ optimistic: true }` pre-applies the patch's
// attributes through the normalized patch and rolls back on error.
const updateOpts = writes.albums.id('1').update({ optimistic: true })

// Delete — invalidates the type's lists + the resource's own reads.
const deleteOpts = writes.albums.id('1').delete()

// Relationship mutations — invalidate the parent's relation reads (never the type's lists).
const addOpts = writes.albums.id('1').rel('tracks').add()
const setOpts = writes.albums.id('1').rel('artist').set()
```

The variables a mutation takes mirror the client: `create()` takes the flat create input,
`update()` the patch, `add/remove/replace()` the linkage refs, `set()` a ref or `null`.

The standalone factories are `createMutationOptions`, `updateMutationOptions`,
`deleteMutationOptions`, `addRelationshipMutationOptions`, `removeRelationshipMutationOptions`,
`replaceRelationshipMutationOptions`, `setRelationshipMutationOptions`, and a thin
`atomicMutationOptions` passthrough.

### Worked example (query-core directly)

```ts
const reads = createQueryApi(client as unknown as ReadClient)
const writes = createMutationApi(queryClient, client as unknown as WriteClient, resourceMap)

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
