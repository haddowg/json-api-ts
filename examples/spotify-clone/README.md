# Spotify-clone example

A Spotify-style **catalogue browser + playlist manager** that showcases how a real React app
consumes the generated JSON:API client through the TanStack bindings
([`@haddowg/json-api-query`](../../packages/query)).

It is intentionally **backend-free** by default: a seeded **in-memory mock** (a focused JSON:API
handler over a small store) sits behind the client's transport seam, so `pnpm dev` runs with no
server. Point it at a real server by setting `VITE_API_URL`.

## Run

```bash
pnpm install            # from the repo root
pnpm --filter @haddowg/json-api-spotify-clone dev
```

Open the printed URL. To run against a live JSON:API server (e.g. the FrankenPHP bundle example):

```bash
VITE_API_URL=http://localhost:8080 pnpm --filter @haddowg/json-api-spotify-clone dev
```

## What it demonstrates

- **Typed reads** — collection lists with `filter` / `sort` / `page`, `include` (hydrated
  relations) and sparse `fields`, get-one with a compound document, and related/relationship reads.
- **Search** — one text box driving `filter[q]` + `sort` + sparse fieldsets across the typed
  read surface (albums / artists / tracks).
- **Playlist management** — create a playlist, add / remove tracks, and reorder them using the
  **writable pivot** `position`. A playlist's ordered tracks carry their per-edge `position`
  (`$pivot`); a reorder is a relationship `replace` that carries the new `$pivot.position` on each
  member, so the order persists server-side.
- **Optimistic + write-through normalization** — mutations update the cache immediately and
  reconcile on settle; `installNormalization` does `type:id` write-through patching, so an edit on
  the detail page (e.g. renaming a playlist) reflects in the Playlists list and Browse with **no
  refetch** ("edit once, updates everywhere").
- **TanStack Query** — `useQuery` / `useMutation` over the `@haddowg/json-api-query`
  option / mutation factories (`reads.<type>.list(...)`, `writes.<type>.create()`,
  `writes.<type>.id(id).rel('orderedTracks').add()`, …).
- **Deterministic art** — there are no real images; cover art is a CSS gradient derived from a
  stable hash of the resource (`GradientArt`).

## How it's wired

`src/api/client.ts` builds the descriptor-bound `createClient` (mock or fetch transport), a
`QueryClient` with normalization installed, and the bound `reads` / `writes` APIs. Views call
`useQuery(reads.<type>.list(query))` / `useMutation(writes.<type>...())`.

The generated client (`src/generated/*.gen.ts`) is committed — the same artifact
`@haddowg/json-api-codegen` emits from the music-catalogue OpenAPI document.

The mock lives in `src/mock/`: `seed.ts` (the dataset), `store.ts` (rows → JSON:API resources +
write methods), `handler.ts` (the focused request handler), `transport.ts` (the transport adapter).

Playlist mutations live in `src/api/playlist-tracks.ts` — thin wrappers over the relationship
mutation factories that add an optimistic patch of the related-tracks cache (add appends, remove
filters, reorder maps the new order back through `$pivot.position`), then let the factory's own
`onSettled` invalidate so the read reconciles against the mock.
