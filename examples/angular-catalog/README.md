# Angular catalogue example

A small standalone Angular 21 app that reads and writes the music catalogue through
[`@haddowg/json-api-angular`](../../packages/angular). It uses the client generated from the
music-catalog OpenAPI fixture (`src/generated/music-catalog.gen.ts`, kept in step by
`pnpm codegen:check`).

## Run

```bash
pnpm install                 # from the repo root
pnpm build                   # builds the packages the app imports
pnpm --filter @haddowg/json-api-angular-catalog start
```

Open <http://localhost:4200>. By default an in-memory mock answers the requests, so no server is
needed. Add `?live` to the URL to talk to a real server instead: the dev server proxies `/api/*` to
`http://localhost:8080` (see `proxy.conf.json`), for example the bundle's FrankenPHP example.

## What it shows

- `provideJsonApiClient(createClient, { baseUrl: '/api' })` in `src/app/app.config.ts`, with a
  `Register` declaration so the client is typed everywhere without a token.
- An ordinary interceptor, `src/app/request-tracker.ts`, that stamps a header and counts requests.
  The counts in the header bar move on every read and write, because the client sends through
  `HttpClient`.
- `jsonApiResource` for the album list (`src/app/album-list.ts`), with `include` and sparse
  `fields`. The template is type-checked with `strictTemplates`, so reading a field the fieldset
  left out is a build error.
- Cancellation: type quickly in the filter box and the "cancelled" count goes up, because each
  new filter value aborts the request still in flight.
- `nextPage`/`prevPage` driving a page signal, and a detail resource that stays idle until an
  album is picked.
- `jsonApiMutation` renaming an album, with the 422 for a blank title shown from
  `jsonApiError().byPath()`, and `reload()` refreshing the reads afterwards.

`pnpm --filter @haddowg/json-api-angular-catalog typecheck` runs `ngc` over the app, which checks
the templates as well as the TypeScript.
