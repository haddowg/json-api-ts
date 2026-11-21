# The example app

[`examples/spotify-clone`](../examples/spotify-clone) is a full React + TanStack Query app — a Spotify-style catalogue browser and playlist manager — built entirely on the generated client. It is the place to see every feature of this project wired together in one running app, rather than in isolated snippets.

It is **backend-free by default**: a seeded in-memory mock sits behind the client's transport seam, so it runs with no server. You can also point it at a real bundle server.

!!! example "Try it live"
    A build of the app in mock mode is hosted on this site at **[/spotify-clone/](https://haddowg.github.io/json-api-ts/spotify-clone/)** — no install required. It is rebuilt from the current `client`/`query` package source on every docs deploy.

!!! tip "Two example surfaces, two jobs"
    The spotify-clone shows the whole thing working together in a real UI. [`packages/example/src/example.test.ts`](../packages/example/src/example.test.ts) is the other reference — every code snippet across these docs is a real, typed call from that file, run under `pnpm test`. When you want to copy a signature, that test is the source of truth; when you want to see it in context, this app is.

## Running it

Full instructions live in the app's [README](../examples/spotify-clone/README.md). The short version, from the repo root:

```bash
pnpm install
pnpm --filter @haddowg/json-api-spotify-clone dev
```

Open the printed URL and it runs against the seeded mock — no server required. To run against a live bundle server instead (e.g. the FrankenPHP example on `:8080`), set `VITE_API_URL=/api`; because playlist writes are secured, set `VITE_API_TOKEN` to a seeded owner. See the [README](../examples/spotify-clone/README.md) for the exact commands.

## How it is wired

Everything the app needs is bootstrapped in one file, [`src/api/client.ts`](../examples/spotify-clone/src/api/client.ts): it builds the descriptor-bound client, picks a transport, installs cache normalisation, and exposes the bound TanStack read/write APIs the views call.

```ts
import { fetchTransport } from '@haddowg/json-api-client'
import {
  createMutationApi,
  createQueryApi,
  installNormalization,
  JsonApiMutationCache,
} from '@haddowg/json-api-query'
import { QueryClient } from '@tanstack/react-query'
import { createClient, resourceMap } from '../generated/music-catalog.gen'

export const client = createClient({ baseUrl, transport })

const queryClient = new QueryClient({ mutationCache: new JsonApiMutationCache() /* , ... */ })
installNormalization(queryClient, resourceMap) // type:id write-through patching

export const reads = createQueryApi(client)
export const writes = createMutationApi(queryClient, client, resourceMap)
```

- **The generated client** — `src/generated/music-catalog.gen.ts` (+ `.schemas.gen.ts`) is the exact artifact `@haddowg/json-api-codegen` emits from the music-catalogue OpenAPI document, so what you read here is what the codegen produces. A real app commits it; this repo writes it with `pnpm generate` from the pinned `@haddowg/json-api-symfony-specs` document instead, so run that once before starting the app.
- **The transport** — `src/api/client.ts` picks the fetch transport when `VITE_API_URL` is set, otherwise the seeded mock (`createMockTransport`). The rest of the app is identical either way; only the transport changes.
- **The mock** lives under [`src/mock/`](../examples/spotify-clone/src/mock): `seed.ts` (the dataset), `store.ts` (rows → JSON:API resources + write methods), [`handler.ts`](../examples/spotify-clone/src/mock/handler.ts) (a focused JSON:API request handler that understands exactly the query patterns the app uses — list/filter/sort/page/include/fields, get-one, related and relationship reads, and relationship mutations with the pivot `position`), and `transport.ts` (the transport adapter). It returns documents shaped like the real bundle's, so the client sees no difference.

!!! note "TanStack Query throughout"
    Views never call the client directly. They call the bound factories — `useQuery(reads.<type>.list(query))` and `useMutation(writes.<type>...())` — so keying, caching, and cache patching are handled for them. See [TanStack Query bindings](tanstack-query.md) for how those factories work.

## Feature map, page by page

Each screen exercises a distinct part of the API. Follow the link to the page's source and to the docs section it demonstrates.

### Browse and Search — lists, filtering, sorting, sparse fields

[`BrowsePage.tsx`](../examples/spotify-clone/src/pages/BrowsePage.tsx) renders grids of albums, artists, and playlists. The album grid is a single typed list read that also hydrates each album's `artist` via `include` and narrows the payload with a sparse fieldset:

```ts
const albumsQuery = useQuery(
  reads.albums.list({
    include: ['artist'],
    fields: { albums: ['title', 'releasedAt', 'status', 'artist'] },
    sort: '-releasedAt',
    page: { size: PAGE_SIZE },
  }),
)
// album.artist?.name is typed off the client — include hydrated it, fields narrowed the row.
```

[`SearchPage.tsx`](../examples/spotify-clone/src/pages/SearchPage.tsx) drives one text box into a single `filter[q]` shared across three parallel typed reads (albums / artists / tracks), plus a `sort` selector for the album list — the same read surface, narrowed server-side by one filter key.

→ [Reading](reads.md) · [Filtering and sorting](filtering-and-sorting.md) · [Includes and sparse fieldsets](includes-and-sparse-fieldsets.md)

### Album detail — get-one with a compound `include`

[`AlbumDetailPage.tsx`](../examples/spotify-clone/src/pages/AlbumDetailPage.tsx) fetches the album, its artist, and the first page of its tracklist in **one compound read**:

```ts
const albumQuery = useQuery(reads.albums.get(id, { include: ['artist', 'tracks'] }))
// album.artist.name and album.tracks[i].title are typed off the client, no cast, no second request.
```

`include` widens the requested relations into hydrated resources on the result type. The server renders an included to-many as its first page, two tracks for an album, so the page renders those at once and reads the rest with `loadAll(album.tracks)`, which follows the relationship's `next` links. The mock renders included to-manys the same way. See [an included to-many is its first page](includes-and-sparse-fieldsets.md#an-included-to-many-is-its-first-page).

→ [Includes and sparse fieldsets](includes-and-sparse-fieldsets.md) · [Reading](reads.md)

### Artist detail — a related collection

[`ArtistDetailPage.tsx`](../examples/spotify-clone/src/pages/ArtistDetailPage.tsx) reads an artist and their discography as one document — `include: ['albums']` narrows the relation to a typed `Collection` of album resources hydrated straight off the compound document, with no second request.

→ [Reading](reads.md)

### Playlist detail — relationship mutation and the writable pivot

[`PlaylistDetailPage.tsx`](../examples/spotify-clone/src/pages/PlaylistDetailPage.tsx) is where the app writes. It reads the playlist plus its **ordered** tracks (the related endpoint carries the writable pivot `position`), and manages the list through the relationship-mutation factories:

```ts
const relTracks = writes.playlists.id(id).rel('orderedTracks')
const add = useMutation(relTracks.add({ optimistic: true }))
const remove = useMutation(relTracks.remove({ optimistic: true }))
const reorder = useMutation(relTracks.replace({ optimistic: true })) // carries $pivot.position
const rename = useMutation(writes.playlists.id(id).update({ optimistic: true }))
```

- **Reorder** is a wholesale `replace` that carries each member's `$pivot.position`, so the new order persists server-side.
- **Rename** is an attribute update; because normalisation does `type:id` write-through patching, the new title shows up in the Playlists list and Browse with no refetch — "edit once, updates everywhere".
- The ref builders (position → `$pivot`) live in [`api/playlist-tracks.ts`](../examples/spotify-clone/src/api/playlist-tracks.ts); [`components/TrackPicker.tsx`](../examples/spotify-clone/src/components/TrackPicker.tsx) is the add-tracks surface.

!!! note "The optimism is the library's"
    `{ optimistic: true }` makes the mutation cache apply the change through a draft: the parent's related and relationship reads (every page variant) and its relation slot on every cached copy, placed where each member fits, rolled back step by step if the write fails, and refetched by the last overlapping write to settle. The app only shapes the refs. See [Optimistic updates](optimistic-updates.md).

→ [Relationship mutation](relationship-mutation.md) · [Writes](writes.md) · [TanStack Query bindings](tanstack-query.md)

### Account and Liked: a singleton and polymorphic filters

The caller's account is a [singleton](reads.md#singletons) the server serves at `/me`. The sidebar names the caller from `reads.accounts.get()`, which takes no id, and [`AccountPage.tsx`](../examples/spotify-clone/src/pages/AccountPage.tsx) renames them with `writes.accounts.update()`, passing the id the read returned because the request body needs it. The mock answers `409` to a body without that id, as the bundle does.

[`LikedPage.tsx`](../examples/spotify-clone/src/pages/LikedPage.tsx) lists the caller's liked tracks. `filter: { favoritable: { type: 'tracks' } }` is a `WhereMorph` filter on the polymorphic `favoritable` relation, so liked albums and artists stay out. `dated` is a `WhereSet` filter that defaults to dated favorites; the "Include undated likes" box sends `dated: [true, false]` to ask for both. See [list filters](filtering-and-sorting.md#list-filters).

??? note "Going deeper: the routes"
    [`App.tsx`](../examples/spotify-clone/src/App.tsx) wires the routes — `/` (Browse), `/search`, `/playlists`, `/playlists/:id`, `/albums/:id`, `/artists/:id`, `/liked` and `/account`. `PlaylistsPage.tsx` lists playlists and creates new ones; each detail route maps to the page above.

## See it in the example app

- The whole app: [`examples/spotify-clone`](../examples/spotify-clone) — start at [`src/api/client.ts`](../examples/spotify-clone/src/api/client.ts).
- The tested-snippet reference behind these docs: [`packages/example/src/example.test.ts`](../packages/example/src/example.test.ts), grouped by `describe(...)` (reads / writes / relationship mutations / custom actions / atomic operations / TanStack Query bindings / opt-in validation).

## Next

- New here? Start with [getting started](getting-started.md).
- Reading data end to end: [reading](reads.md).
- The write mechanics behind the playlist page: [relationship mutation](relationship-mutation.md) and [TanStack Query bindings](tanstack-query.md).
