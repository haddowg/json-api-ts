# Angular on TanStack Query: design

Status: proposed. Decisions D1–D12 are accepted; nothing is built yet.

**Goal.** Angular single-page apps get TanStack Query's feature set over the generated client:

- queries, infinite queries, parallel queries and prefetching;
- mutations and their state, plus devtools;
- first-class optimistic updates;
- the `type:id` normalised cache from `@haddowg/json-api-query` working on every shape those
  produce;
- an interface that reads like Angular.

**Out of scope.** SSR and persisted caches. Both go through TanStack's dehydrate/hydrate, which a
materialised value doesn't survive (a prototype showed `$page`, `$self` and `$next()` are lost,
and hydrated queries never reach the normaliser). In a client-only app nothing is ever transferred,
so this is safe. The docs say SSR is unsupported, and the work stays recorded in the appendix for
later.

**Baseline.** `@tanstack/angular-query` 5.108.1 is the stable `latest` (peers Angular >= 20.1 and
TypeScript ^5.8 || ^6). `@tanstack/angular-query-devtools` is stable at the same version. ADR 0005
rejected TanStack for Angular only because its adapter was experimental.

## Principles

1. **Users call TanStack's own `inject*` functions.** We ship option factories, providers, keys,
   typing and a template pipe, never a wrapper around `injectQuery`/`injectMutation`.
2. **Framework-agnostic work lands in `json-api-query`**, so React and the others get every fix.
   The Angular entry is DI, typing and template sugar.
3. **The normalised cache covers every data shape TanStack caches here**: plain and infinite
   queries.
4. **A spread never breaks cache upkeep or optimism.**
   `{ ...writes.albums.create(), onSuccess: … }` is the idiomatic call, so upkeep can't live in
   callbacks a spread overwrites.

## What a prototype established

A throwaway prototype (8 tests, `tsc` clean, not committed) ran the real
`HttpClient` transport, the `json-api-query` factories and `@tanstack/angular-query` 5.108.1.
Findings marked † are read from the code rather than tested.

| Area            | Works today                                                                                              | Broken or missing                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Read typing     | include/fieldset narrowing reaches `data()`; sparse-field misuse fails to compile                        | `error()` is `Error`; `getQueryData(key)` is `unknown`                                                  |
| Normalisation   | an update patches a cached `injectQuery` with no refetch; the republished proxy root re-fires the signal | infinite data (`{ pages }`) is never indexed or patched                                                 |
| Cancellation    | the transport cancels `HttpClient` when given a signal                                                   | factories ignore TanStack's `signal`; a key change leaves the old request running                       |
| Mutation upkeep | invalidation and rollback work                                                                           | they live in `onSuccess`/`onSettled`/`onError`, and a spread callback removes them †; no `mutationKey`  |
| Several servers | —                                                                                                        | `injectQuery` always injects one `QueryClient`, but normalisation allows one descriptor per QueryClient |
| `skipToken`     | works with a typed factory                                                                               | factories don't accept it                                                                               |

Facts from `query-core` that shape the design:

- A `DataTag`'d `queryKey` types `getQueryData`/`setQueryData` (>= 5.62).
- `error()` is typed only by a typed callback in the options (`retry`, `throwOnError`), never by
  the key tag (tested).
- `MutationCache` config hooks (`onMutate`, `onSuccess`, `onError`, `onSettled`) are **awaited**
  and run **before** the mutation's own callbacks (`mutation.js`). `MutationFunctionContext`
  (>= 5.89) hands every hook the `QueryClient`.
- A fetch cancelled with `revert` restores its pre-fetch state **asynchronously** (`query.js`), so
  an optimistic edit applied before that cancel settles can be overwritten.

## Part A: `@haddowg/json-api-query` (all frameworks)

### A1. Forward the abort signal (fix)

Every read `queryFn` passes TanStack's `signal` to the client call. Ship first, alone, as
`fix(query)`.

### A2. Typed options

- `queryKey` is `DataTag<QueryKey, R, E>`.
- `E` is `JsonApiError<ErrorCode> | StructuralGuardError | Error`, carried into `error()` by a typed
  `retry` (D3).
- Ids and queries accept `skipToken`, as in `reads.albums.get(this.id() ?? skipToken)`.

### A3. Infinite queries

`reads.albums.infinite(query)` and `reads.albums.relatedInfinite(id, rel, query)`.

- `initialPageParam` is the query's `page`.
- `getNextPageParam` and `getPreviousPageParam` read the params from the page's `next`/`prev`
  link, through `nextPageParams`/`prevPageParams`, which move from `json-api-angular` into the
  client. The param type stays `PageParamsOf<$page>`.
- Key: the list key plus `'$infinite'`. The shared `[type, 'fetchMany']` prefix keeps
  invalidation reaching it. `maxPages` and `fetchPreviousPage` come from TanStack.

### A4. Normalisation covers infinite data

`walkResources` walks `InfiniteData.pages`, and `republish` rebuilds `{ pages, pageParams }` around
republished page roots.

### A5. Upkeep rides `meta`, run by an awaited mutation cache (D1)

- Each factory returns `{ mutationKey, mutationFn, meta: { [JSON_API]: plan } }`. The plan names
  the write: its verb, type, id and rel, the predicted change, the keys it affects, and its
  optimistic policy.
- `new JsonApiMutationCache(config?)`, passed as `new QueryClient({ mutationCache })`, executes
  plans from its config hooks. It chains any hooks the app's own `config` gives it. The hooks are
  awaited, so the mutation stays `isPending()` until reconciliation finishes, as it does today.
- User `onMutate`/`onSuccess`/`onError`/`onSettled` are entirely the user's, and run after ours,
  against an already-reconciled cache.
- `mutationKey` is `[type, verb, id?, rel?]`, exported as `mutationKeys.albums.update('1')`, so
  `injectIsMutating` and `injectMutationState` can target writes.
- Normalising query successes stays the `installNormalization` subscription.

### A6. Several servers on one QueryClient (D2)

- A `scope` option prefixes keys with a `{ $scope: 'admin' }` segment, an object, so it can't
  collide with a type name.
- Normalisation and optimism act per `(QueryClient, scope)`.
- Unscoped behaviour is unchanged. The "one descriptor per QueryClient" throw becomes "one per
  scope".

### A7. Reads keep every cached copy coherent

**Today** (confirmed by prototype tests): every successful read patches the
**attributes** of each resource it carries into every other cached copy, included copies too, and
sparse reads merge. It doesn't propagate **linkage** or **membership**. The last response to
arrive wins, even an older one. A read landing during a pending optimistic write overwrites the
prediction with the server's old value.

- **R1. Newer data wins.** The read factories' `queryFn` wrapper stamps each result with its
  request's start time (non-enumerable), and mutations stamp theirs. Each node records the stamp
  of the data it holds (a `WeakMap`). A patch writes a node only when its stamp is no older.
- **R2. Optimistic fields take precedence while their write is pending.** A read landing on a
  field an open draft owns doesn't change what's shown: it updates the draft's recorded server
  value. A rollback then restores the newest server value; on success the write's response wins.
- **R3. Reads propagate relationships, under B1a's fit rules** (D12).
  - **To-one linkage:** a read carrying it updates the slot on the resource's other cached copies
    when the target fits each view.
  - **Complete to-many linkage** (no `next`): it replaces the members of identifier views, and of
    hydrated views where every member fits.
  - **Windowed linkage:** never treated as the whole list.
  - **A view whose relationship would change but can't be filled:** it's invalidated (active
    queries refetch, the rest go stale).

  R1 prevents refetch loops: a refetched query is newer, so it updates the others and is never
  overwritten by them.

**Invalidation happens in exactly three places:**

1. a write settling (every candidate, by the last overlapping write);
2. R3, where a changed relationship can't be filled in place;
3. a delete's own resource, which is removed rather than invalidated.

**A patch never invalidates.** It republishes data only, leaving `isInvalidated` and `dataUpdatedAt`
as they were. A patched query goes stale on its original schedule, because patching some fields of
some resources doesn't make the whole query fresh.

### A8. SSR guard, for every framework

SSR is unsupported in this pass (see [SSR and persistence](ssr-and-persistence.md)). Today an
SSR app using `json-api-query`, in React or Angular, silently renders results whose `$page`,
`$next()` and other accessors are missing after hydration. The guard turns that into a refetch and
a warning, and lives in `json-api-query`, so both frameworks get it.

- **Server side: a dehydrate default.** `installNormalization` adds a `shouldDehydrateQuery`
  default that excludes queries whose key has the binding's shape, and composes with any default
  the app already set. Angular's `provideTanStackQuery` calls `dehydrate` without options, so it
  always applies there.
- **Browser side: a hydration check.** A `dehydrate()` call with explicit options overrides the
  defaults (verified in `query-core`), as the usual Next.js streaming setup does. So
  `installNormalization` also watches the query cache's `added` event. A binding-keyed query that
  arrives with data that isn't a materialised value is reset, so it refetches, and a dev-mode
  warning names the query and points to the docs. The client exports `isMaterialised(value)`
  (a `WeakSet` brand on its results) for that check, which is additive.
- **Composing with app options.** `jsonApiShouldDehydrateQuery(next?)` wraps an app's own
  predicate, so an app passing explicit options can keep its pending-query streaming without
  tripping the browser check.

The cost to an SSR app is a refetch in the browser, so the first render can differ from the server
HTML. That's the honest state until real support lands and replaces the guard as a strict
improvement.

## Part B: first-class optimistic updates

### B0. Where it stands

Optimism is opt-in per mutation (`{ optimistic: true }`) on two kinds of write:

- `update`, for attributes only;
- relationship `add`/`remove`/`replace`/`set`.

`update` patches attributes in place everywhere a resource is cached, rolled back
compare-and-swap. The relationship verbs swap the arrays of the parent's
`fetchRelated`/`fetchRelationship` reads, rolled back by restoring the previous array.

Gaps, read from the code:

1. **`create`** has no optimistic insert.
2. **`delete`** has no optimistic removal. On settle it also invalidates the deleted resource's
   own reads, which refetch into a 404.
3. **`update`** drops the relation members of its input from the optimistic patch.
4. **Relationship verbs** edit only the parent's relation _reads_. A cached copy of the parent
   that carries the relation, such as `album.artist` in a `get(…, { include: ['artist'] })`, keeps
   showing the old value until the settle refetch.
5. **Optimistic members are bare identifiers** even when the resource is already cached.
6. **No `cancelQueries`** runs before applying. An in-flight refetch, or the revert of a cancelled
   one, lands after the optimistic edit and overwrites it.
7. **Membership rollback restores the old array wholesale.** That discards changes normalised in
   the meantime and a concurrent optimistic edit on the same relation.
8. **Overlapping mutations:** the first one to settle invalidates and refetches. That replaces the
   still-pending second one's optimistic state with server state that doesn't include it yet, so
   the UI flickers back.
9. **Infinite reads** are not covered.
10. **No pending marker** a template can use to style an unconfirmed row.
11. **No way to be optimistic** about a custom action or an atomic batch.

### B1. One primitive: the optimistic draft

Every optimistic change, built-in or user-written, goes through a typed transaction over the
normalised cache:

```ts
interface OptimisticDraft<D> {
  /** Attributes and relation slots on every cached copy of type:id. */
  patch<T>(type: T, id: string, change: UpdateVariables<D, W, T>): void
  /** To-one: relation reads and the slot on every cached copy of the parent. */
  link<T>(type: T, id: string, rel: RelationOf<D, T>, ref: Ref | null): void
  /** To-many: relation reads, infinite pages and slots on every cached parent copy. */
  attach<T>(type: T, id: string, rel: RelationOf<D, T>, refs: Ref[], at?: 'start' | 'end'): void
  detach<T>(type: T, id: string, rel: RelationOf<D, T>, refs: Ref[]): void
  replaceMembers<T>(type: T, id: string, rel: RelationOf<D, T>, refs: Ref[]): void
  /** Into the cached collections of type that `where` selects (default: none). */
  insert<T>(
    type: T,
    resource: CreateVariables<D, W, T> & { id: string },
    where?: Placement<D, T>,
  ): void
  /** From every collection, related read, to-many slot and infinite page; to-one slots go null. */
  evict<T>(type: T, id: string): void
  /** The richest cached copy of type:id, else its identifier. */
  resolve<T>(type: T, id: string): ResourceView<D, T> | Identifier<T>
}
```

Rules:

- **Refs resolve automatically.** `attach`/`link`/`insert` put the richest cached copy in place
  (the `resolve` step), so a row renders with its attributes, not a bare identifier (gap 5).
- **Rollback replays inverse operations in reverse order** (D7), each compare-and-swap. A removed
  member is re-added only if it's still absent, and an added one removed only if it's still
  present. A rollback therefore never discards a change normalised meanwhile or another draft's
  edit (gap 7).
- **One republish per transaction.** Each query the draft touches is republished once, so a
  signal fires once per optimistic change.
- **The draft knows the keys it touched**, which the lifecycle (B3) cancels and later invalidates.

### B1a. A member enters a view only in the shape that view's type promises

This governs every optimistic `attach`, `link`, `replaceMembers`, `insert` and `create attachTo`,
and the success patch too.

**Every cached place a member can go has a known shape:**

| Destination                                      | Shape its type promises                                                                                                 | Example                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Relationship read (`fetchRelationship`)          | identifiers (plus `$pivot`)                                                                                             | `GET /albums/1/relationships/tracks`                                   |
| Parent slot, relation **not included**           | identifiers                                                                                                             | `album.tracks` in `get('1')`                                           |
| Parent slot, relation **included**               | resources with the query's `fields[type]` (all declared attributes when none), and the included paths below it hydrated | `album.tracks` in `get('1', { include: ['tracks', 'tracks.artist'] })` |
| Related read (`fetchRelated`, plain or infinite) | resources with that query's fieldset and includes                                                                       | `GET /albums/1/tracks?fields[tracks]=title`                            |
| Parent slot with no linkage (links-only)         | nothing known                                                                                                           | `album.tracks` is `undefined`                                          |

**For each destination, the draft resolves the member from, in order:**

1. what the caller passed in the variables (a full member, such as the track the user just picked
   from a search result);
2. the richest cached copy of that `type:id` in the normalised index.

The member **satisfies** a destination when it holds every attribute key the destination's
fieldset selects, and, recursively, every included relation below that destination is itself
satisfied. Identifier destinations are always satisfied by `{ type, id }`.

**Then, per destination:**

- **Satisfied:** the member goes in, as a per-edge view, with any `$pivot` the variables gave.
- **Not satisfied:** the member does **not** go in. That view keeps its current members, and the
  identifier is recorded as **deferred** on the parent node.
- **Links-only slot:** left alone. Nothing is known of its membership, so adding one member would
  fabricate a partial list.

`detach`, `evict` and `link(…, null)` never need resolving: removal is by `type:id`, so they apply
everywhere.

**What the UI sees for a deferred member:**

- `parent.$pending(rel)` returns the deferred identifiers for that relation
  (`readonly Identifier[]`, non-enumerable, read from the draft registry). It's empty when there
  are none.
- `parent.$optimistic` is `'pending'` while any draft touches the parent.
- A template can render a placeholder row without any type lying about the members:

  ```html
  @for (t of album.tracks; track t.id) {
  <li>{{ t.title }}</li>
  } @for (ref of album.$pending('tracks'); track ref.id) {
  <li class="skeleton"></li>
  }
  ```

**Reconciliation: membership changes are confirmed by refetch.**

- **On error:** deferred entries are dropped with the rest of the draft.
- **On settle:** every candidate query for the write (B1b) is invalidated, whether the member
  entered it, was deferred, or was never placed. TanStack refetches the active ones with their own
  include and fields and marks the rest stale. The server fills each list in its own order and
  paging, and `$pending` clears.
- **Not at mutate time.** Invalidating at mutate time would race the write: the refetch would
  likely return the pre-write membership, replace the draft's in-place edits, and normalise those
  stale values into every other query.
- **Overlapping writes:** only the last one to settle invalidates (B3).
- **Latency:** a deferred member appears after the write plus one refetch.

**Counts:** the draft adjusts `parent.$count(rel)` by the members added and removed when the
parent carried a count, through the same registry. The success patch replaces it.

**Rejected alternatives:**

- Inserting a bare identifier into a hydrated slot: the template reads `t.title` as `undefined`
  while the type says `string`.
- Widening every included slot's type to `Resource | Unresolved`: breaking for every reader of an
  include.
- Fetching the member before showing anything: the optimistic update then waits on the network,
  which defeats its purpose.
- Fetching each deferred member alongside the write (`fetchMissing`): it only closes the window
  before settle, costs a request per member, and adds draft states. It's additive later if asked
  for.

**Writing attributes a copy doesn't hold.** The same rule covers attribute patches: an optimistic
or success patch writes only keys the cached copy already holds, or keys its query's fieldset
selects. A sparse copy never gains an attribute its type says is absent. This tightens today's
`patchNode`, which also adds new keys.

### B1b. How a write targets queries

A write can always find the queries it might affect. Only some can be patched with certainty.

**1. Candidates (always automatic, exact).** Every cached query key decodes into a typed
description: operation, id, relation, and `filter`/`sort`/`page`/`include`/`fields`. The
materialised value says whether a view is complete: no `next` link on its `$page`, and an included
to-many can itself be a first page only.

| Write                                    | Candidate queries                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| relationship verb on `albums/1` `tracks` | album 1's `tracks` relationship and related reads, by key prefix, plus the `tracks` slot on every cached copy of `albums:1` |
| `create` albums                          | every cached `albums` list (`[albums, fetchMany, …]`), plus `attachTo`'s parent as above                                    |
| `delete` tracks `t7`                     | every query holding `tracks:t7` anywhere                                                                                    |
| `update` with relations                  | the changed relations' candidates, as for the relationship verbs                                                            |

**2. Applied automatically only where certain.**

- **Removals** (`detach`, `evict`, `link(…, null)`) apply to every candidate. A member that left a
  relation, or a deleted resource, is gone from every view, whatever its filter, sort or page.
- **Additions** to a relation apply automatically, at the end, only to a view that is all three
  of:
  - **unfiltered** (a filtered related read may not match the member);
  - **unsorted** (an explicit sort places by values only the server compares);
  - **complete** (in a windowed or partly loaded view the member may belong on an unloaded page).

  "At the end" reflects most servers' linkage order, and the settle refetch corrects it.
  `new JsonApiMutationCache({ optimistic: { autoPlace: false } })` turns this off client-wide
  (D11).

- **Creates never place automatically.** Whether a new resource belongs in a filtered, sorted,
  paged list is a query only the server can run.
- **Never automatic:** inverse relations (the descriptor has no inverse metadata), lists that
  encode a relation as a filter (`tracks.list({ filter: { album: '1' } })`), and counts on other
  resources.

**3. Explicit placement: `into`.** Every adding policy takes `into(q, member)`. It's called once per
candidate the defaults didn't cover, with `q` the typed decoded description (filter keys and sort
tokens typed from the type's read queries) and `member` the resolved member. It returns one of:

- `'start'`, `'end'` or an index;
- `(members) => index`;
- `false` to leave the view alone.

```ts
writes.albums.create({
  optimistic: {
    into: (q) =>
      q.operation === 'fetchMany' && !q.params.filter && q.params.sort === '-createdAt'
        ? 'start'
        : false,
  },
})
writes.playlists
  .id(pid)
  .rel('tracks')
  .add({
    optimistic: {
      into: (q, member) =>
        q.params.sort === 'position'
          ? (members) => members.findIndex((m) => m.$pivot.position > member.$pivot.position)
          : false,
    },
  })
```

`'start'` targets the first page and `'end'` only a view with no `next` link; otherwise the
placement is skipped. Inverse relations and filter-encoded lists go through
`optimistic: (draft, vars) => …` with `invalidates`.

**4. The safety net.** Every candidate is invalidated at settle (B1a reconciliation). The
optimistic layer only changes what's shown before the server answers.

### B2. Built-in policies

`{ optimistic: true }` on any write factory builds its draft from the variables.

| Write                          | Optimistic change                                                                                | On success                                                    | On settle                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------- |
| `update`                       | `patch`, relations included (gap 3)                                                              | normalise                                                     | invalidate the changed relations' candidates |
| `delete`                       | `evict`                                                                                          | `removeQueries` for the resource's own reads (D8; gap 2)      | invalidate every candidate                   |
| `add`/`remove`/`replace`/`set` | `attach`/`detach`/`replaceMembers`/`link`, reaching cached parent copies (gap 4), placed per B1b | normalise linkage                                             | invalidate every candidate                   |
| `create`                       | `insert`, with the id from D6 and placement from `into` only                                     | swap a temporary id for the server's in place, then normalise | invalidate every candidate                   |

**`create` options:**

- `into` places the new row (B1b). With none, it goes into no list.
- `attachTo: { type, id, rel }` also attaches the new resource to a parent relation, placed by the
  B1b rules. That's the common "add a track to this playlist" flow.

**One mutation for many rows:** besides the id-bound form
(`writes.tracks.id(id).update()`), each type gets `writes.tracks.update()` and
`writes.tracks.delete()`, which take the id in the variables
(`mutate({ id, title })`, `mutate({ id })`), as singletons already do. One `injectMutation` then
serves a whole list, and its mutation key gains the id per call through the plan.

**Infinite lists:** `attach` and `insert` with `'end'` go to the last loaded page, and `'start'`
to the first. `detach` and `evict` remove from whichever page holds the member (gap 9).

### B3. Lifecycle, all inside `JsonApiMutationCache` and awaited

1. **`onMutate`:** `await cancelQueries` on the keys the plan affects (gap 6), then open the
   draft, apply the policy and any `optimistic(draft, vars)` callback (B4), and keep the
   transaction in a `WeakMap<Mutation, Draft>`.
2. **`onError`:** roll the draft back.
3. **`onSuccess`:** normalise the result; for a create, swap the temporary id; for a delete,
   remove the resource's queries.
4. **`onSettled`:** invalidate every candidate (B1b) **only if no other JSON:API mutation touching
   an overlapping key is still pending**. The last one to settle invalidates for all (gap 8). The
   promise is returned, so `isPending()` covers the refetch.
5. **A `202 Accepted` with no `wait`:** keep the optimistic state and skip the invalidation. With
   `wait`, reconcile when the job resolves (D9).

### B4. Optimism for anything

Every factory takes `optimistic` as `true` (the built-in policy) or a function. A function either
replaces the policy or extends it: it receives `(draft, variables)`, and calls
`draft.applyDefault()` to keep the built-in step.

A generic `jsonApiMutationOptions({ mutationFn, optimistic, invalidates })` brings the same
lifecycle to custom actions and `client.atomic(...)`:

```ts
injectMutation(() =>
  jsonApiMutationOptions({
    mutationFn: (albumId: string) => client.albums.id(albumId).actions.publish(),
    optimistic: (draft, albumId) => draft.patch('albums', albumId, { status: 'published' }),
    invalidates: (albumId) => [resourceKey('albums', albumId)],
  }),
)
```

`jsonApiMutationCache({ optimistic: true })` turns optimism on by default for a whole client, and
each factory can still say `false` (D5).

### B5. Pending state in the UI

- **Per-row marker:** every node an open draft touched carries a non-enumerable `$optimistic`
  (`'pending' | undefined`), read from a registry the draft maintains and cleared on reconcile.
  Templates use `[class.pending]="track.$optimistic"`, and the republished root makes the signal
  re-render.
- **Per-write state:** mutation keys make the TanStack-native "render the variables" approach
  work. `injectMutationState(() => ({ filters: { mutationKey: mutationKeys.playlists.rel('1',
'tracks').add(), status: 'pending' }, select: (m) => m.state.variables }))` renders pending adds
  without touching the cache, for apps that prefer it.
- **Errors after rollback:** the error stays on `mutation.error()`, narrowed in templates by the
  `jsonApiError` pipe. The docs show the toast-and-rollback pattern.

## Part C: `@haddowg/json-api-angular/query`

The root entry is unchanged. The new subpath has `@tanstack/angular-query` as an optional peer and
`@haddowg/json-api-query` as a dependency (D4).

```ts
export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withInterceptors([authInterceptor])),
    provideJsonApiClient(createClient, { baseUrl: '/api/v5' }),
    provideTanStackQuery(
      () =>
        new QueryClient({
          mutationCache: new JsonApiMutationCache({ optimistic: true }),
          defaultOptions: { queries: { staleTime: 30_000 } },
        }),
      withDevtools(),
    ),
    provideJsonApiQuery(resourceMap),
  ],
}
```

`provideJsonApiQuery(resourceMap, { client?: token, scope? })` is an environment initializer. It:

- installs normalisation on the injected `QueryClient`, torn down by `DestroyRef`;
- registers the scope;
- **fails fast** if `provideTanStackQuery` is missing or the client's mutation cache isn't a
  `JsonApiMutationCache`.

It doesn't use TanStack's `/internal` `queryFeature()`, which "may change without notice". A
second server is `provideJsonApiClient(…, ADMIN_API)` plus
`provideJsonApiQuery(adminMap, { client: ADMIN_API, scope: 'admin' })`.

```ts
export class PlaylistPage {
  private readonly reads = injectJsonApiReads()
  private readonly writes = injectJsonApiWrites()
  readonly id = input.required<string>()

  readonly playlist = injectQuery(() =>
    this.reads.playlists.get(this.id(), { include: ['tracks'] }),
  )
  readonly tracks = injectInfiniteQuery(() =>
    this.reads.playlists.relatedInfinite(this.id(), 'tracks', { page: { size: 50 } }),
  )

  readonly rename = injectMutation(() => ({
    ...this.writes.playlists.id(this.id()).update({ optimistic: true }),
    onSuccess: () => this.toast.show('Saved'), // upkeep and optimism are unaffected
  }))
  readonly addTrack = injectMutation(() =>
    this.writes.playlists.id(this.id()).rel('tracks').add({ optimistic: true }),
  )
  readonly remove = injectMutation(() =>
    this.writes.playlists.id(this.id()).delete({ optimistic: true }),
  )
}
```

```html
@for (track of tracks.data()?.pages; track $index) { @for (t of track; track t.id) {
<li [class.pending]="t.$optimistic">{{ t.title }}</li>
} } @if (rename.error() | jsonApiError; as error) { {{ error.byPath()['name']?.[0]?.detail }} }
```

- `injectJsonApiReads(token?)`/`injectJsonApiWrites(token?)` return the bound factory sets, typed
  through `Register`.
- `JsonApiErrorPipe` (`jsonApiError`) is a standalone pure pipe narrowing to
  `JsonApiError<ErrorCode> | undefined`. `asJsonApiError()` does the same in code.
- Prefetching is documented, not wrapped: a `ResolveFn` calls
  `inject(QueryClient).ensureQueryData(injectJsonApiReads().albums.get(id))`, and hover prefetch
  uses `prefetchQuery`.
- Plain TanStack covers the rest: `injectQueries`, `select`, `placeholderData: keepPreviousData`
  for numbered pages, `injectIsFetching`.
- `toResource()` stays out of our API while TanStack marks it experimental.

## Decisions (accepted: every recommendation below, plus ids carried in the variables)

|     | Question                            | Recommendation                                                                                                                                                                                                   | Alternative and trade-off                                                                                                                                                                                                                                                |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Where upkeep runs                   | Plans in `meta`, run by `JsonApiMutationCache`'s awaited hooks (A5)                                                                                                                                              | Keep per-mutation callbacks and compose user callbacks passed in as options. No setup line, but the idiomatic spread still breaks upkeep. Cost of the recommendation: every app builds its QueryClient with our mutation cache, including React apps (a migration step). |
| D2  | Several servers                     | Scoped keys on one QueryClient (A6)                                                                                                                                                                              | One QueryClient per server in separate injector scopes. Angular can't put two in one component.                                                                                                                                                                          |
| D3  | Typing `error()`                    | A typed `retry` that defers to the app's configured `retry`, else never retries a 4xx                                                                                                                            | `Register { defaultError }`: app-wide and single-server. Behaviour change in the recommendation: 4xx reads stop retrying three times when the app set no `retry`.                                                                                                        |
| D4  | Packaging                           | `@haddowg/json-api-angular/query` subpath (Angular >= 20.1, TypeScript >= 5.8 there)                                                                                                                             | A separate package: own versioning, but a split `Register`/token story.                                                                                                                                                                                                  |
| D5  | Optimism default                    | Opt-in per write, with a client-wide default on `JsonApiMutationCache`                                                                                                                                           | On by default: snappier out of the box, but a surprising flicker-back on validation errors for apps that didn't ask.                                                                                                                                                     |
| D6  | Ids for optimistic creates          | `optional`/`required` client-id types get a generated id (`crypto.randomUUID()`, overridable), sent with the create, so there's no swap; `forbidden` types get a marked temporary id swapped in place on success | Offer optimistic create only where client ids are allowed. Simpler, but no optimism for most servers' types.                                                                                                                                                             |
| D7  | Rollback mechanism                  | Inverse operations, compare-and-swap (B1)                                                                                                                                                                        | Snapshot each touched query's data and compare-and-swap whole values. Simpler, but a concurrent change makes the rollback skip entirely rather than undo just its own edit.                                                                                              |
| D8  | Deleted resource's own reads        | `removeQueries` on success instead of invalidating                                                                                                                                                               | Today's invalidation refetches into a 404. Behaviour change.                                                                                                                                                                                                             |
| D9  | Optimism on a `202 Accepted`        | Keep the optimistic state; reconcile when `wait` resolves, else on the next natural refetch                                                                                                                      | Roll back on `202`: honest, but undoes what the server accepted.                                                                                                                                                                                                         |
| D10 | `jsonApiResource`/`jsonApiMutation` | Keep as the light, cache-less path                                                                                                                                                                               | Deprecate: forces TanStack onto apps that don't want a cache.                                                                                                                                                                                                            |
| D11 | Automatic placement of additions    | On, only for unfiltered, unsorted, complete views, at the end; `autoPlace: false` turns it off client-wide (B1b)                                                                                                 | Fully explicit: nothing added anywhere without `into`.                                                                                                                                                                                                                   |
| D12 | Reads propagate relationships       | Yes, under the fit rules, invalidating where a slot can't be filled (A7 R3)                                                                                                                                      | Attributes only, documented: relationship changes show only after each query refetches.                                                                                                                                                                                  |

## Phasing (one release pass, json-api-ts only, no contract change)

1. `fix(query)`: forward the abort signal (A1).
2. `feat(client)`: `nextPageParams`/`prevPageParams`. `feat(query)`: typed keys/errors and
   `skipToken` (A2), infinite factories and normalisation (A3, A4). `feat(client)` +
   `feat(query)`: `isMaterialised` and the SSR guard (A8).
3. `feat(query)!` or `feat(query)` depending on D1's migration: `JsonApiMutationCache`, plans in
   `meta`, mutation keys and scopes (A5, A6).
4. `feat(query)`: read coherence (A7 R1–R3), then the optimistic draft, targeting and lifecycle
   (B1–B5). This is the largest piece and needs a concurrency-focused test suite:
   - overlapping writes;
   - rollback under interleaved normalisation;
   - a read landing during a pending write (reproduced in the prototype);
   - out-of-order responses;
   - refetches not looping;
   - cancel and revert;
   - temporary-id swap;
   - infinite pages.

   Tested examples for React land in the same phase (see "Tested examples" below).

5. `feat(angular)`: the `/query` entry, docs (`angular.md` in two paths, `tanstack-query.md`
   naming Angular, an optimistic-updates page), an ADR superseding 0005, and
   `examples/angular-catalog` moved to TanStack with devtools and optimistic writes, with the
   Angular tested examples below.

### Tested examples (a requirement of phases 2, 4 and 5)

Every new snippet in the docs is drawn from code that runs in CI, as the client's already are
(`packages/example/src/example.test.ts`, whose `describe` groups the docs cite by name). Today
`angular.md` is the exception: `examples/angular-catalog` is typechecked but has no tests, and its
inline snippets aren't drawn from tested code.

**React and `json-api-query`:**

- `example.test.ts` gains tested blocks, each cited by the docs page it backs:
  - `infinite queries` (phase 2): an infinite list read, `fetchNextPage`, and normalisation reaching
    its pages;
  - `optimistic updates` (phase 4): a draft with the built-in policies, explicit placement with
    `into`, a deferred member and `$pending`, rollback on failure, and a read landing during a
    pending write;
  - `mutation cache` (phase 3): spreading user callbacks over a factory without losing upkeep, and
    finding pending mutations by mutation key (`useMutationState` and
    `injectMutationState` both filter this way).
- `examples/spotify-clone`'s playlist page, already the optimistic showcase, moves onto the draft,
  explicit placement and `$pending` rows, and its render smoke test (`App.test.tsx`) drives one
  optimistic add through to settle.

**Angular:**

- `examples/angular-catalog` becomes a root Vitest project (jsdom and TestBed, as
  `packages/angular` already runs), with a render smoke test that drives a read, an infinite page,
  an optimistic write and its rollback through the real components.
- The snippets in the new `angular.md` are drawn from that app or from a tested
  `angular-catalog/src/app/*.spec.ts`, and the page cites them the way the client docs cite
  `example.test.ts` blocks.

A docs snippet with no tested source fails review.

Multi-package PRs are rebase-merged, one Conventional Commit per package (client, query, angular).

ADRs:

- TanStack for Angular (supersedes 0005);
- upkeep rides mutation `meta` through an awaited mutation cache (D1);
- scoped keys (D2, amends 0003);
- the optimistic draft and inverse-operation rollback (D7).

Changelog-kept behaviour changes:

- reads cancel on key change;
- 4xx reads stop retrying by default (D3);
- the QueryClient needs `JsonApiMutationCache` (D1);
- deleted resources' reads are removed rather than refetched (D8);
- infinite queries are normalised;
- under SSR, binding queries are no longer dehydrated and refetch in the browser, with a dev-mode
  warning (A8).

## Open risks to verify during build

- In-place patching under an `OnPush`, zoneless component: the prototype proved the signal re-fires,
  not a rendered template.
- `$optimistic` on a per-edge view must read through to the node registry, as the other
  `$`-accessors do.
- Temporary-id swap and `@for … track t.id`: Angular recreates the row when the id changes. Track
  by a stable key, or document `track $index` for optimistic lists.
- Typed `where` predicates over normalised list params must stay assignable from the client's
  read-query types without widening.
- pnpm must resolve one `@tanstack/query-core` for both `json-api-query` and
  `@tanstack/angular-query`, which pins an exact version.

## Keeping SSR and persistence additive

Verified in `query-core` 5.108.1:

- Angular's provider calls `dehydrate(queryClient)` with no options, and `dehydrate`/`hydrate`
  fall back to the client's default `serializeData`, `deserializeData` and `shouldDehydrate*`. So
  later support is a set of defaults `provideJsonApiQuery` installs, with no TanStack internals and
  no API change.
- A dehydrated mutation keeps only `mutationKey`, `state` (variables, context), `scope` and
  `meta`. `mutationFn` and every callback are dropped, and `meta` goes through JSON. Resuming uses
  `setMutationDefaults`, matched by key **prefix**, as mutation filters match by default.

Constraints adopted now, so the later work adds rather than changes:

1. **The plan in `meta` is plain data** (verb, type, id, rel, include/fields/withCount/wait,
   policy name). Closures (`optimistic` functions, `where` predicates, request-`meta` functions)
   live on the factory and are looked up by `mutationKey`, the same way TanStack restores
   `mutationFn`.
2. **Optimistic policies are deterministic from plan plus variables**, so a resumed mutation can
   re-derive its draft.
3. **A generated or temporary id lives where it's persisted.** It can't stay only in the draft: a
   resumed create would mint a second id. Proposal: a create's variables carry the id the client
   generated (`optional`/`required` types) or a stripped `$tempId` (`forbidden` types), which also
   shows in `injectMutationState`.
4. **Mutation keys grow only by trailing segments.** Prefix matching keeps any filter an app has
   already written working.
5. **SSR guard, now (A8):** binding queries are excluded from dehydration, and any that reach the
   browser without being materialised are reset and warned about, in React and Angular alike. An
   SSR app then refetches instead of rendering values that lack their `$`-accessors. Real support
   replaces the guard later as a strict improvement.

## Appendix: SSR and persistence, deferred

Designed and estimated separately, for React and Angular together, in
[SSR and persistence](ssr-and-persistence.md).
