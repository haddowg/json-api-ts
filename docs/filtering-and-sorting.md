# Filtering and sorting

Collection reads accept a typed `filter` object and a `sort` string. Both are narrowed at compile time to exactly what the server advertises for that type — so a filter key or sort field the API does not support is a type error, not a runtime `400`.

## Sorting a collection

Pass `sort` on a `list(...)` call. The value is a comma list of signed field names: a bare name sorts ascending, a `-` prefix sorts descending. The classic case is "newest first":

```ts
const albums = await client.albums.list({
  sort: '-releasedAt',
})
```

`sort` is typed against the type's advertised sort tokens. For the catalogue's `albums`, that union is `title | -title | releasedAt | -releasedAt | status | -status`, so `sort: '-releasedAt'` type-checks while `sort: 'plays'` does not. You can also pass a tuple to sort by several fields in priority order:

```ts
await client.albums.list({ sort: ['-releasedAt', 'title'] })
```

The runtime joins a tuple with `,` on the wire (`sort=-releasedAt,title`).

### Sort families

A server can accept a whole family of sort keys by prefix, such as `value.<cap>` where the caps are data and can't be listed. The OpenAPI document lists each family under the `sort` parameter's `x-sort-families`, and the codegen copies them into the descriptor as `sortFamilies`. Each family adds two template literal types to the type's sort union, `` `value.${string}` `` and `` `-value.${string}` ``, beside the fixed keys:

```ts
const cap = 'energy'
await client.tracks.list({ sort: [`-value.${cap}`, 'title'] })
```

The type checks the prefix and the dot, so `valu.energy` and a bare `value` don't compile. It doesn't check the suffix. The descriptor carries each family's `suffixPattern`, the regular expression the server matches the suffix against, if you want to check a key yourself before sending it. A key that fails it comes back as the server's `400`.

A template literal only keeps its type where TypeScript reads it against the sort union, as in the call above. One built earlier into a plain variable or a returned object widens to `string`, so build it at the call, or type the variable as `SortToken<ResourceMap, 'tracks'>`. `SortToken` comes from `@haddowg/json-api-client` and `ResourceMap` from the generated module.

### Deprecated filters and sorts

A server can mark a filter, a sort key or a sort family deprecated. It still accepts them, so they stay in the filter and sort types and compile as before. A member of a string literal union can't carry TSDoc, so your editor won't strike one through. The generated `resourceMap` names them in the TSDoc on the type's `filterable`, `sortable` and `sortFamilies` entries instead. See [deprecation](codegen.md#deprecation).

!!! note "No sorting advertised? `sort` is a compile error."
    If a type advertises no `sortable` set (the OpenAPI document declares no sort parameter), its `sort` value is typed `never` — the key cannot be supplied at all. That is a compile-time mirror of the server's `400 SORTING_UNSUPPORTED`. In the example app, `playlists` advertises no sort, so [BrowsePage.tsx](../examples/spotify-clone/src/pages/BrowsePage.tsx) lists them without a `sort`.

## Filtering a collection

Pass `filter` as an object keyed by the type's advertised filter params. The keys are narrowed; values stay `unknown` (value shapes and operators vary per filter).

```ts
const albums = await client.albums.list({
  filter: { title: 'OK' },
  sort: '-releasedAt',
})
```

Here `filter.title` is valid because `albums` advertises `title` (alongside `q`, `releasedAt`, `artist.name`, `rating`, `tracks`). A key the server does not advertise — `filter: { colour: 'blue' }` — fails to compile.

!!! note "No filters advertised? `filter` is a compile error."
    Just like `sort`, a type with no `filterable` set types its `filter` as `never`. Supplying one is rejected at compile time — the static twin of `400 FILTERING_UNRECOGNIZED`.

### Free-text search with `filter[q]`

The catalogue exposes a full-text `q` filter on `albums`, `artists`, and `tracks`. The example [SearchPage.tsx](../examples/spotify-clone/src/pages/SearchPage.tsx) drives one text box into `filter[q]` across all three typed reads at once:

```ts
const q = term.trim()
// Keep the key ABSENT when the term is empty (the read query is
// exactOptionalPropertyTypes, so an explicit `undefined` is rejected).
const qFilter = q ? { filter: { q } } : {}

const albumsQuery = useQuery(
  reads.albums.list({ ...qFilter, sort: '-releasedAt', include: ['artist'] }),
)
const artistsQuery = useQuery(reads.artists.list({ ...qFilter, sort: 'name' }))
const tracksQuery = useQuery(reads.tracks.list({ ...qFilter, include: ['album'] }))
```

An empty term simply omits `filter`, so the reads return the full catalogue.

!!! tip "Spread optional query keys, don't set them to `undefined`."
    The read-query types are `exactOptionalPropertyTypes` — an explicit `filter: undefined` is a type error. Build the optional part conditionally (`const qFilter = q ? { filter: { q } } : {}`) and spread it, as `SearchPage` does.

## How the wire is serialised

The runtime serialises the flat `filter`/`sort` into JSON:API's bracketed query families deterministically, so URLs are stable (good for caching). A `filter` object becomes `filter[key]=value`; a `sort` tuple joins with `,`:

```
GET /albums?filter[title]=OK&sort=-releasedAt
```

Only values are percent-encoded; bracketed keys stay literal. Array filter values join with `,`, and a structured value (a `Range`/`DateRange` `{ min, max }`) is expanded into nested bracketed keys (`filter[key][min]=…`) to match the server's deepObject shape.

??? note "Going deeper: how the codegen narrows these types"
    The codegen reads the OpenAPI document your backend emits and records, per type, the exact `sortable` and `filterable` string arrays into the generated descriptor (see [the generated client](../examples/spotify-clone/src/generated/music-catalog.gen.ts)):

    ```ts
    sortable: ['title', '-title', 'releasedAt', '-releasedAt', 'status', '-status'],
    filterable: ['artist.name', 'q', 'rating', 'releasedAt', 'title', 'tracks'],
    ```

    Those literal tuples become the `sort` and `filter`-key unions on the typed read query. A type that advertises no `sortable`/`filterable` array collapses the corresponding value to `never`, so the key cannot be passed — the API's own advertisement is the single source of truth, mirrored on both wire sides.

    Filter *values* stay `unknown` in v0.1: operators and value shapes vary per filter, so the client narrows the keys and leaves the value shapes to the server. See [concepts](concepts.md) and [codegen](codegen.md) for the descriptor model.

## See it in the example app

- [SearchPage.tsx](../examples/spotify-clone/src/pages/SearchPage.tsx) — one search box driving `filter[q]` + `sort` across three typed reads.
- [BrowsePage.tsx](../examples/spotify-clone/src/pages/BrowsePage.tsx) — the `-releasedAt` sort on the albums grid; `playlists` listed with no sort.
- [example.test.ts](../packages/example/src/example.test.ts) — the tested `filter: { title: 'OK' }` + `sort: '-releasedAt'` collection read, asserting the exact serialised URL.

**Next:** [reads](reads.md) · [pagination](pagination.md) · [includes and sparse fieldsets](includes-and-sparse-fieldsets.md)
