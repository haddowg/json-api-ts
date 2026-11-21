# Angular catalogue example

A small standalone Angular 21 app that reads and writes the music catalogue through
[`@haddowg/json-api-angular`](../../packages/angular) on [TanStack Query](https://tanstack.com/query).
It uses the client generated from the music-catalog OpenAPI document
(`src/generated/music-catalog.gen.ts`, written by `pnpm generate` at the repo root from the pinned
`@haddowg/json-api-symfony-specs`, and not committed).

## Run

```bash
pnpm install                 # from the repo root
pnpm build                   # builds the packages the app imports
pnpm generate                # writes the generated client from the pinned document
pnpm --filter @haddowg/json-api-angular-catalog start
```

Open <http://localhost:4200>. By default an in-memory mock answers the requests, so no server is
needed. Add `?live` to the URL to talk to a real server instead: the dev server proxies `/api/*` to
`http://localhost:8080` (see `proxy.conf.json`), for example the bundle's FrankenPHP example.

## What it shows

- `provideJsonApiClient(createClient, { baseUrl: '/api' })`, `provideTanStackQuery(…)` with a
  `JsonApiMutationCache`, and `provideJsonApiQuery(resourceMap)` in `src/app/app.config.ts`, with a
  `Register` declaration so the client is typed everywhere without a token. The query devtools
  attach with `withDevtools()` from `@tanstack/angular-query-devtools`, which the config notes.
- An ordinary interceptor, `src/app/request-tracker.ts`, that stamps a header and counts requests.
  The counts in the header bar move on every read and write, because the client sends through
  `HttpClient`.
- `injectQuery` over `injectJsonApiReads()` for the album list (`src/app/album-list.ts`), with
  `include` and sparse `fields`. The template is type-checked with `strictTemplates`, so reading a
  field the fieldset left out is a build error.
- Cancellation: type quickly in the filter box and the "cancelled" count goes up, because each
  new filter value changes the query key and TanStack aborts the request still in flight. The
  previous page stays on screen (`placeholderData: keepPreviousData`) until the new one arrives.
- `nextPage`/`prevPage` driving a page signal, and a detail query that stays idle (`skipToken`)
  until an album is picked.
- `injectMutation` over `injectJsonApiWrites()` renaming an album with `update({ optimistic: true })`.
  The new title shows at once in the list and the detail, the row is marked while the write is
  pending, a refused write rolls it back, and the 422 for a blank title is shown through the
  `jsonApiError` pipe. On success the server's title patches both in place, with no refetch.
- The caller's account in the header (`src/app/account.ts`), a singleton the server serves at
  `/me`. The read takes no id, and the rename passes the id the read returned, since the request
  body must carry it.

## The lighter alternative

The root entry, `@haddowg/json-api-angular`, needs no TanStack: `jsonApiResource` wraps a read in
Angular's `resource()` and `jsonApiMutation` wraps a write in signals, with no shared cache. This
app used to be written that way. Choose it when an app needs neither a shared cache nor optimistic
writes; the query entry is the choice when it does.

```ts
readonly albums = jsonApiResource({
  params: () => ({ filter: { title: this.search() }, page: this.page() }),
  loader: ({ client, params, abortSignal }) =>
    client.albums.list({ ...params, include: ['artist'], signal: abortSignal }),
})
readonly renaming = jsonApiMutation((client, input: { id: string; title: string }) =>
  client.albums.id(input.id).update({ title: input.title }),
)
```

## Tests

`src/app/app.spec.ts` is a Vitest project (jsdom and TestBed, `vitest.config.ts`) that mounts the
real components against the mock server: the list and its paging, the detail, a filter cancelling
the read it supersedes, an optimistic rename settling on the server's title with no refetch, a
refused rename rolling back, and the account rename.

```bash
pnpm generate                # the tests import the generated client
npx vitest run --project angular-catalog
```

`pnpm --filter @haddowg/json-api-angular-catalog typecheck` runs `ngc` over the app, which checks
the templates as well as the TypeScript.
