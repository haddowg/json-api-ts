# SSR and persistence for the TanStack bindings: follow-on design

Status: potential follow-on to the TanStack Query bindings (`docs/tanstack-query.md`,
`docs/angular.md`). Not scheduled; nothing is built. The estimates are relative and rough, not
measured.

**Goal.** Server-side rendering and persisted query caches work for both frameworks that use
`@haddowg/json-api-query`: React through `@tanstack/react-query` (classic SSR, and streaming with
React Server Components) and Angular through `@tanstack/angular-query` (Angular SSR with
`TransferState`). Optionally, queued offline writes resume after a reload.

## Why it doesn't work today

TanStack moves a cache between environments with `dehydrate` and `hydrate`: to the browser for
SSR, and to storage for persistence. A materialised value doesn't survive that trip. Its
`$`-accessors (`$page`, `$next()`, `$self`, `$document`, `$rel()`, `$count()`) are
non-enumerable, so JSON drops them. On top of that, `hydrate` emits only the query cache's `added`
event, so the normaliser never indexes hydrated queries. A prototype confirmed both. A dehydrated
mutation keeps only its `mutationKey`, `state` (variables and context), `scope` and `meta`: its
`mutationFn` and every callback are dropped, and `meta` goes through JSON.

Verified in `query-core` 5.108.1:

- `dehydrate` and `hydrate` fall back to the client's default `serializeData`, `deserializeData`
  and `shouldDehydrate*` when called without options. Angular's `provideTanStackQuery` calls
  `dehydrate(queryClient)` without options, so the support below is a set of defaults, with no
  TanStack internals and no API change.
- `dehydrateQuery` applies `serializeData` to a pending query's promise when it resolves, so
  streamed queries take the same path.
- A restored mutation gets its `mutationFn` from `setMutationDefaults`, matched by key prefix.

The shipped bindings already hold to the constraints that keep this additive:

1. **The upkeep plan in a mutation's `meta` is plain data** (verb, type, id, rel,
   include/fields/withCount/wait, policy name). Closures (`optimistic` functions, `into`
   placements, request-`meta` functions) live on the factory and are looked up by `mutationKey`,
   the way TanStack restores `mutationFn`.
2. **Optimistic changes are deterministic from plan plus variables**, so a resumed mutation can
   re-derive its draft.
3. **A generated or temporary id lives in the variables**, so a resumed create doesn't mint a
   second one: the id the client generated for a type whose server requires client ids, or the
   `$tempId` every other type's create carries.
4. **Mutation keys grow only by trailing segments**, so prefix matching keeps an app's existing
   filters working.

## Shared core (both frameworks)

### S1. `dematerialise` and `rematerialise` in the client

`dematerialise(value)` rebuilds a JSON:API document, plus the surface it was read from, from the
**current** graph. It inverts the client's `materialise.ts` (674 lines, 19 functions), so it covers:

- every result shape: a single resource, a collection, a related collection, to-one and to-many
  linkage;
- included graphs, including cycles;
- per-edge `$pivot` and link-local meta;
- attributes narrowed to some of their keys (`$keySelection`);
- polymorphic relations;
- relation slots that are included, identifier-only or links-only;
- the document envelope (`jsonapi`, `meta`, `links`);
- `$page`, including the arm a MultiPaginator read picked;
- current attribute values rather than `$raw`, so a patch survives.

Top-level results gain a non-enumerable record of their surface (linkage flag, primary type,
paginator, fieldsets), which is additive. `client.rematerialise(snapshot)` calls `materialise` with
that record and binds `navigate`, so `$next()` works after the trip.

The test is a round-trip property: `rematerialise(dematerialise(x))` equals `x`, accessors
included, across generated documents.

### S2. Hydration support in `json-api-query`

- `jsonApiDehydrateOptions(client)` and `jsonApiHydrateOptions(client)`: `serializeData` and
  `deserializeData` that apply only to queries whose key has the binding's shape, including each
  page of an infinite query.
- `installNormalization` indexes queries arriving through the `added` event with data.
- **Freshness stamps across machines.** Normalisation compares the client's request stamps, a per-process counter. Data
  rendered on a server or restored from storage carries a timestamp from another machine or an
  earlier session, and clock skew could make it look newer than a fresh browser read. Hydrated and
  restored nodes are therefore stamped as the oldest possible, so any read made in the browser
  replaces them.
- **A cache-busting key derived from the descriptor**, passed as the persister's `buster`, so a
  cache written by an older generated client is discarded rather than misread.
- Error states aren't dehydrated (TanStack's default dehydrates successful queries only), so the
  typed error classes never need serialising.

## Per framework

### Angular

- `provideJsonApiQuery` installs the S2 defaults on the injected `QueryClient`.
- **Angular's HTTP transfer cache.** Our transport goes through `HttpClient`, whose transfer cache
  also replays GET responses during hydration. Decide whether the binding's requests opt out of it
  (TanStack's transferred cache already carries them) or rely on it.
- The repo has no Angular SSR setup, so this needs a server-render-then-hydrate test harness and an
  SSR variant of `examples/angular-catalog`.
- Persistence through `@tanstack/angular-query-persist-client`.

### React

- **Classic SSR:** `dehydrate` on the server, `<HydrationBoundary>` on the client, with the S2
  defaults on the `QueryClient`. Cheap once the shared core exists.
- **Streaming and React Server Components** (Next.js App Router): queries prefetched in a server
  component are dehydrated while pending and streamed; the serialiser runs when each resolves, and
  its output is plain JSON, so it crosses the server-component boundary. One caveat can't be fixed:
  a client result passed from a server component as a prop, rather than through the query cache,
  loses its accessors. The docs say so.
- `examples/spotify-clone` is a client-only Vite app on React 18, so this needs a new server-render
  test harness (`renderToPipeableStream` plus `HydrationBoundary`). A Next.js App Router example
  app is optional.
- Persistence through `PersistQueryClientProvider` with a storage persister.

## Optional: resuming queued offline writes

The hard part, and almost all shared:

- **Optimistic state isn't re-applied after a reload.** TanStack doesn't re-run `onMutate` for a
  restored mutation, so drafts are rebuilt from plan plus variables on resume. The persisted cache
  must hold the confirmed view, without unconfirmed optimistic edits.
- **Writes that depend on each other.** "Create a playlist, then add a track to it" queued offline
  means the second write names the first's temporary id. On resume, ids are remapped in order as
  the server assigns them, like atomic operations' `lid`. The online design has no such machinery.
- **Conflicts after a long time offline.** A resource deleted or changed on the server in the
  meantime: queued writes fail with a 404, a 409 or a validation error, and each needs a
  rollback-and-report pattern.
- **Restoring user callbacks.** `registerJsonApiMutationDefaults(queryClient, client)` registers a
  `mutationFn` for every type and verb by mutation key; user-supplied functions (`optimistic`,
  `into`, request `meta`) are re-registered by key too.
- **Framework wiring is thin:** calling `resumePausedMutations` at the right moment through each
  framework's persistence provider.

## Effort, relative to the TanStack bindings pass

The pass that built the TanStack bindings was about 20 units:

| Phase                                                  | Units |
| ------------------------------------------------------ | ----- |
| Signal fix                                             | 0.5   |
| Typing and infinite queries                            | 3     |
| Mutation cache, keys, scopes                           | 3     |
| Read coherence, optimistic draft, targeting, lifecycle | 10    |
| Angular entry point, docs, ADR, example                | 4     |

This follow-on:

| Piece                               | Units                 |
| ----------------------------------- | --------------------- |
| S1 round trip (shared)              | 4                     |
| S2 hydration support (shared)       | 1.5                   |
| Angular SSR wiring and harness      | 3                     |
| React SSR wiring and harness        | 2.5                   |
| Persisted queries, both frameworks  | 1                     |
| **SSR plus persisted queries**      | **~12 (+60%)**        |
| Optional Next.js App Router example | +1.5 (+68% in total)  |
| Optional offline write resumption   | +5–6 (~+90% in total) |

## Recommendation

- The shared core costs the same for one framework or both, so if SSR becomes likely for either,
  plan both together as one phase. Build S1 and the stamp rule first, then each framework's wiring;
  React's classic path is the cheapest.
- S1's round trip must agree with the request stamps and optimistic markers the bindings already
  carry, so it is built against them rather than alongside them.
- Offline write resumption stays its own project, only if offline-first editing becomes a
  requirement.

## Until then: the SSR guard

`installNormalization` ships an SSR guard for React and Angular alike: on the server, any query
whose data is a client result is left out of dehydration, and a binding query that reaches the
browser without its accessors is reset, refetched and warned about. SSR apps refetch in the browser rather than
render values without their accessors. This follow-on replaces the guard: S2's serialise and
deserialise defaults take the place of its exclusion, and its browser check stays as a safety net
for apps whose explicit `dehydrate` options skip the serialiser.
