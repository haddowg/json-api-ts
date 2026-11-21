# Spotify-clone example

A Spotify-style **catalogue browser + playlist manager** that showcases how a real React app
consumes the generated JSON:API client through the TanStack bindings
([`@haddowg/json-api-query`](../../packages/query)).

It is intentionally **backend-free** by default: a seeded **in-memory mock** (a focused JSON:API
handler over a small store) sits behind the client's transport seam, so `pnpm dev` runs with no
server. Point it at a real server by setting `VITE_API_URL`.

## Run

```bash
pnpm install            # from the repo root (needs a GitHub Packages token, see the root README)
pnpm generate           # writes the generated client from the pinned document
pnpm --filter @haddowg/json-api-spotify-clone dev
```

Open the printed URL. To run against the **live** bundle server (e.g. the FrankenPHP example on
`:8080`), set `VITE_API_URL=/api` — the app then talks to the server through Vite's dev-proxy, so
the browser stays same-origin and no CORS is needed (the proxy forwards `/api/*` to
`VITE_API_PROXY_TARGET`, default `http://localhost:8080`). The example secures playlist writes
behind a Bearer firewall where the token _is_ the user id, so set `VITE_API_TOKEN=ada@example.com`
(the seeded "Morning Mix" owner) to edit live; reads work without it:

```bash
# backend first: docker run --rm -p 8080:80 json-api-symfony-example   (from the bundle repo)
VITE_API_URL=/api VITE_API_TOKEN=ada@example.com pnpm --filter @haddowg/json-api-spotify-clone dev
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
- **Optimistic writes through the draft** — rename, add, remove, reorder and create pass
  `{ optimistic: true }` (or `{ into }` to place a new playlist at the top of the newest-first
  list) and the mutation cache does the rest: it predicts the change on every cached copy, rolls
  it back if the server refuses, and refetches on settle. The pages only render the markers:
  `track.$optimistic` (a `data-optimistic="pending"` attribute) on rows a pending write touched,
  and `playlist.$pending('orderedTracks')` as skeleton rows for tracks added from the picker, which
  no cached view can render yet. A created playlist carries a temporary id until the server's
  replaces it. See [`docs/optimistic-updates.md`](../../docs/optimistic-updates.md).
- **Write-through normalization** — `installNormalization` does `type:id` write-through patching,
  so an edit on the detail page (e.g. renaming a playlist) reflects in the Playlists list and
  Browse with **no refetch** ("edit once, updates everywhere").
- **A singleton** — the caller's account at `/me`, read with `reads.accounts.get()` and renamed
  with `writes.accounts.update()`, whose input carries the id the read returned.
- **Polymorphic and boolean-set filters** — the Liked page filters favorites by the type they
  favor (`WhereMorph`) and by whether they are dated (`WhereSet`, defaulting to dated only).
- **TanStack Query** — `useQuery` / `useMutation` over the `@haddowg/json-api-query`
  option / mutation factories (`reads.<type>.list(...)`, `writes.<type>.create()`,
  `writes.<type>.id(id).rel('orderedTracks').add()`, …).
- **Deterministic art** — there are no real images; cover art is a CSS gradient derived from a
  stable hash of the resource (`GradientArt`).

## How it's wired

`src/api/client.ts` builds the descriptor-bound `createClient` (mock or fetch transport), a
`QueryClient` with normalization installed, and the bound `reads` / `writes` APIs. Views call
`useQuery(reads.<type>.list(query))` / `useMutation(writes.<type>...())`.

The generated client (`src/generated/*.gen.ts`) is the artifact `@haddowg/json-api-codegen`
emits from the music-catalogue OpenAPI document. It is not committed: `pnpm generate` at the repo
root writes it from the pinned `@haddowg/json-api-symfony-specs`.

The mock lives in `src/mock/`: `seed.ts` (the dataset), `store.ts` (rows → JSON:API resources +
write methods), `handler.ts` (the focused request handler), `transport.ts` (the transport adapter).

The playlist pages call the mutation factories directly, with `optimistic` set. What
`src/api/playlist-tracks.ts` keeps is the domain shape of the refs they send: a track carrying its
`$pivot.{position,weight}`, built per add and per reorder.

The mock can refuse a write on demand: `mockStore.failNextWrite(403, 'detail')` fails the next
non-GET request, which is how the render smoke test (`src/App.test.tsx`) drives an optimistic
write through to its rollback.
