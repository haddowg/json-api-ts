# Optimistic updates

An optimistic write shows its change before the server answers. Every write factory of [`@haddowg/json-api-query`](tanstack-query.md) can be optimistic: the cache predicts the change, marks what it touched as pending, rolls it back if the write fails, and refetches what it may have changed once the write settles.

Every snippet on this page runs under `pnpm test`: in [example.test.ts](../packages/example/src/example.test.ts), in the `optimistic updates` group, and in the query package's [policies](../packages/query/src/policies.test.ts), [lifecycle](../packages/query/src/lifecycle.test.ts) and [read-during-write](../packages/query/src/r2.test.ts) tests.

## Turning it on

Pass `{ optimistic: true }` to a write factory:

```ts
const rename = useMutation(writes.albums.id('1').update({ optimistic: true }))
rename.mutate({ title: 'OK Computer OKNOTOK' })
// Every cached copy of album 1 shows the new title at once, marked pending.
```

Or turn it on for every write when you build the `QueryClient`, and off for one write with `false`:

```ts
const queryClient = new QueryClient({
  mutationCache: new JsonApiMutationCache({ optimistic: true }),
})

writes.albums.id('1').update() // optimistic
writes.albums.id('1').update({ optimistic: false }) // waits for the server
```

`new JsonApiMutationCache({ optimistic: { autoPlace: false } })` turns optimism on and stops additions being placed automatically (see [Placement](#placement)).

## What each write does

| Write                          | Before the write                                                                     | When it succeeds                                                         | When it settles                                          |
| ------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| `update`                       | Patches the attributes on every cached copy, and links or replaces its relations     | Normalises the response                                                  | Refetches the reads of the relations it changed          |
| `delete`                       | Removes the resource from every list, relation and slot; a to-one holding it is `null` | Removes the resource's own queries, so they don't refetch into a `404` | Refetches every query that held it                       |
| `add` / `remove` / `replace` / `set` | Attaches, detaches, replaces or links members, in the relation's reads and its slot on every cached copy of the parent | Normalises the linkage (`replace`, `set`) | Refetches the relation's reads and the parent            |
| `create`                       | Inserts the new resource where `into` places it, and into `attachTo`'s relation      | Swaps a temporary id for the server's, then normalises the response      | Refetches the type's lists and `attachTo`'s relation     |

A write that fails rolls its change back. Each step undoes only what the write itself did: a value another write or a response changed since is left alone.

`writes.<type>.update()` and `writes.<type>.delete()` take the resource's id in the variables, so one mutation serves a whole list:

```ts
const rename = useMutation(writes.tracks.update({ optimistic: true }))
rename.mutate({ id: track.id, title })

const remove = useMutation(writes.tracks.delete({ optimistic: true }))
remove.mutate({ id: track.id })
```

Their mutation key is `[type, verb]`, without the id, so to find one resource's pending writes, filter on the variables: `useMutationState({ filters: { mutationKey: ['tracks', 'update'], predicate: (m) => m.state.variables?.id === id } })`.

## Where a change shows

A change reaches every cached copy of a resource: lists, single reads, related reads, infinite pages, and the copies included in other resources. A relation change reaches the relation's related and relationship reads and the relation's slot on every cached copy of its parent, so `album.artist` in `get('1', { include: ['artist'] })` follows a `set` on `artist`.

A member only goes where it fits the shape that view promises. A relationship read and a slot that isn't included hold identifiers, so any member goes in. An included slot and a related read hold resources with the attributes their `fields` select, so a member goes in only when the variables or a cached copy hold every one of them. A member that fits nowhere it was to go is **deferred**: the view keeps its members, and the parent reports it.

```ts
const album = reads.albums.get('1', { include: ['tracks'] })
add.mutate([{ type: 'tracks', id: '4' }]) // track 4 isn't cached
// album.tracks is unchanged; album.$pending('tracks') is [{ type: 'tracks', id: '4' }]
```

Render pending rows from `$pending(rel)`, and style unconfirmed ones with `$optimistic`, which is `'pending'` on every resource a pending write touched:

```tsx
{album.tracks.map((t) => (
  <li key={t.id} className={t.$optimistic ? 'pending' : undefined}>
    {t.title}
  </li>
))}
{album.$pending('tracks').map((ref) => (
  <li key={ref.id} className="skeleton" />
))}
```

A parent's `$count(rel)` moves by the members a pending write added and removed. Both markers clear when the write settles, after its refetch.

## Placement

A removal applies everywhere: a member that left a relation, or a deleted resource, leaves every view whatever its filter, sort or page.

An addition is placed automatically, at the end, only in a view that is unfiltered, unsorted and complete (no `next` link). Every other view is offered to `into`, which returns where the member goes: `'start'` (on a first page), `'end'` (on a complete view), an index, a function of the loaded members returning an index, or `false` to leave the view alone. Its query argument is typed by the view's filters and sort tokens:

```ts
writes.albums.create({
  optimistic: { into: (q) => (q.params.sort === '-title' ? 'start' : false) },
})
// q.params.sort === '-createdAt' fails to compile where albums' lists take no such sort.
```

`autoPlace: false` on the mutation cache places additions only through `into`. Whatever the placement, the write's settle refetches every view it considered, so the server's own order and paging win.

## Creates

A create is never placed automatically: whether a new resource belongs in a filtered, sorted or paged list is a question only the server can answer. Place it with `into`:

```ts
const create = writes.albums.create({
  optimistic: { into: (q) => (q.operation === 'fetchMany' ? 'start' : false) },
})
```

The row needs an id before the server assigns one:

- For a type that takes client ids (`clientId` is `optional` or `required`), the create generates one with `crypto.randomUUID()`, or your `clientId: () => string` option, writes it into the variables, and sends it, so the row already has its final id.
- For a type that doesn't, the row carries a temporary id, `$tmp:<uuid>`, kept in the variables as `$tempId` and never sent. When the write succeeds it is swapped for the server's id in place: on every cached copy, in `$pending`, and in the key of any cached query keyed by it. A query still observed under the temporary id is left for you to move to the result's id.

Because the id lives in the variables, it also shows in `useMutationState`, and a create that resumes keeps the id it had.

`attachTo: { type, id, rel }` also attaches the new resource to a parent relation, placed by the relation's rules, with its own `into`. It is the "add a new track to this playlist" flow:

```ts
writes.tracks.create({
  optimistic: true,
  attachTo: { type: 'albums', id: '1', rel: 'tracks' },
})
```

In a framework that tracks list rows by id, a swapped id recreates the row. Track optimistic rows by index, or by a key of your own, when that matters.

## Custom actions and atomic batches

`optimistic` also takes a function. It receives the draft, a transaction over the normalised cache, and the variables, and replaces the built-in change unless it calls `draft.applyDefault()`:

```ts
writes.albums.id('1').update({
  optimistic: (draft) => {
    draft.applyDefault() // the patch itself
    draft.patch('albums', '1', { year: 1999 }) // and a change of your own
  },
})
```

`jsonApiMutationOptions` brings the same lifecycle to any write, such as a custom action or `client.atomic(...)`:

```ts
const reissue = useMutation(
  jsonApiMutationOptions({
    descriptor: resourceMap, // types the draft
    mutationFn: (albumId: string) =>
      client.albums.id(albumId).actions.reissue({ releasedAt: '2001-10-01T00:00:00+00:00' }),
    optimistic: (draft, albumId) => draft.patch('albums', albumId, { status: 'released' }),
    invalidates: (albumId) => [resourceKey('albums', albumId)],
  }),
)
```

Its result is normalised when it succeeds, and the keys `invalidates` returns are refetched when it settles.

??? note "The draft"
    | Method                                       | What it does                                                                                      |
    | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
    | `patch(type, id, change)`                    | Writes attributes onto every copy that holds them or whose fieldset selects them; links or replaces relations in `change` |
    | `link(type, id, rel, ref \| null, { into })` | Points a to-one at `ref`, or clears it                                                            |
    | `attach(type, id, rel, refs, { at, into })`  | Adds to-many members                                                                              |
    | `detach(type, id, rel, refs)`                | Removes to-many members everywhere                                                                |
    | `replaceMembers(type, id, rel, refs, { into })` | Makes `refs` the members                                                                      |
    | `insert(type, resource, into)`               | Puts a new resource in the lists `into` places it in                                              |
    | `evict(type, id)`                            | Removes a resource from every list, relation and slot                                             |
    | `resolve(type, id)`                          | The richest cached copy, else the identifier                                                      |

    A ref may be an identifier or a whole resource value, such as the row the user picked; a whole value is tried first when the member has to fill a slot of resources. Every query the draft touches is published once.

## Reconciliation

**Cancelling first.** Before the change is applied, the reads in flight for the queries it touches are cancelled, so a response that left before the write can't land over the prediction. When one is in flight, the change shows once the cancellation has finished, a moment later; otherwise it shows as `mutate()` is called. Cancelled reads are refetched when the write settles.

**The last write refetches.** When the write settles, whether it succeeded or failed, the queries it may have changed are invalidated: active ones refetch and the others go stale. While another write touching any of the same queries is still pending, nothing is refetched yet; the last of them to settle refetches the queries of all of them. So an earlier write's refetch never replaces a later write's prediction with server data that doesn't include it yet. The mutation stays pending until that refetch has finished.

**Reads during a pending write.** A read that lands on a value a pending write predicts doesn't change what's shown: it records the server's value instead. If the write fails, the rollback shows the newest value the server sent, not the one from before the write. If it succeeds, its own response wins, even over a read that started after it.

**Rollback.** A failed write undoes only its own steps: a member it added is removed only if still there, one it removed is restored only if still absent, a value it predicted is reverted only if still showing. Another pending write's change, and a value a response wrote since, are kept.

**Accepted for later.** A write the server answers with `202 Accepted` keeps its prediction and refetches nothing of its own, since the server hasn't done the work yet; its pending markers clear when it settles. With `wait`, the write resolves when the job does, and reconciles as any other write.

## Your own callbacks

The upkeep runs in the mutation cache, before your callbacks, so spreading your own over a factory's options never loses it:

```ts
const rename = useMutation({
  ...writes.albums.id('1').update({ optimistic: true }),
  onMutate: () => console.log(title()), // 'OK Computer OKNOTOK', the prediction
  onError: () => console.log(title()), // 'OK Computer', already rolled back
})
```

The error stays on `rename.error`, typed as a `JsonApiError` carrying the client's error codes, a structural guard error, or any other `Error`.
