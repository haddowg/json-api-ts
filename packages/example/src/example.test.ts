/**
 * The worked, end-to-end example — and the canonical usage reference — for the JSON:API
 * TypeScript client, exercised against the music-catalog fixture.
 *
 * Every snippet below is a real, TYPED call against the GENERATED client
 * (`src/generated/music-catalog.gen.ts`, emitted by `@haddowg/json-api-codegen` from the
 * music-catalog OpenAPI document) wired to a MOCK TRANSPORT that replays the captured response
 * fixtures in `../fixtures`. Because it runs under `pnpm test`, it doubles as a compile-and-run
 * smoke: a snippet that stops type-checking or stops behaving fails the suite, so the reference
 * cannot rot.
 *
 * The flow mirrors how you'd actually use the client:
 *   1. generate a typed client (here: the committed `.gen.ts`) and point it at a transport;
 *   2. read — list with include + sparse fields, get one, follow a relationship;
 *   3. write — create / update / delete, mutate a relationship;
 *   4. call a custom action;
 *   5. run an atomic batch with a cross-op `lid` reference;
 *   6. bind it to TanStack Query (option factories + write-through normalization), and page a
 *      list as an infinite query;
 *   7. opt into per-field validation with ajv.
 *
 * It also reads and updates the caller's account, a singleton served at `/me` with no id, and
 * filters favorites by a polymorphic relation and a set of booleans.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  fieldErrors,
  type JsonApiError,
  type JsonApiErrorObject,
  loadAll,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { createAjvValidator } from '@haddowg/json-api-client/ajv'
import {
  createMutationApi,
  createQueryApi,
  installNormalization,
  JsonApiMutationCache,
  jsonApiMutationOptions,
  mutationKeyFor,
  type ReadError,
  resourceKey,
  withPending,
} from '@haddowg/json-api-query'
import { InfiniteQueryObserver, QueryClient, QueryObserver, skipToken } from '@tanstack/query-core'
import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
// The generated artifacts — exactly what `json-api-codegen --input … --output … --schemas …`
// writes. `createClient` is the descriptor-bound factory; `resourceMap` is the runtime
// descriptor TanStack normalization needs; `schemas` is the per-type JSON Schema map for ajv;
// `Attributes`/`WriteAttributes`/`ResourceMap` are the generated type maps.
import {
  createClient,
  type ErrorCodeByOperation,
  hasErrorCode,
  resourceMap,
} from './generated/music-catalog.gen'
import { schemas } from './generated/music-catalog.schemas.gen'

/**
 * The TanStack-Query bindings are action-agnostic — they accept the generated client directly
 * (the factories take the minimal read/write accessor shape, so a client that also carries the
 * custom-action and atomic surfaces binds with no cast).
 */
const BASE = 'https://music.example'
const PLAYLIST = '00000000-0000-4000-8000-000000000001'

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')

/**
 * A mock transport: maps an already-built request `url` to a captured fixture body (or a
 * caller-supplied JSON), and records every request so we can assert the URL / method / headers
 * the client produced. In a real app you'd omit `transport` entirely and the client uses global
 * `fetch`; the seam exists precisely so a test (or an axios/undici adapter) can stand in.
 */
function mockTransport(routes: Record<string, string | object>): {
  transport: (req: TransportRequest) => Promise<TransportResponse>
  requests: TransportRequest[]
} {
  const requests: TransportRequest[] = []
  return {
    requests,
    transport: async (req) => {
      requests.push(req)
      // Match on method+url first (lets a route reuse a URL across verbs), then bare url.
      const route = routes[`${req.method} ${req.url}`] ?? routes[req.url]
      if (route === undefined) {
        throw new Error(`unmapped request: ${req.method} ${req.url}`)
      }
      const status = req.method === 'DELETE' ? 204 : req.method === 'POST' ? 201 : 200
      return {
        status,
        headers: {},
        body: typeof route === 'string' ? route : JSON.stringify(route),
      }
    },
  }
}

// A small resource-body helper for write responses (create/update echo the resource back).
const album = (id: string, attributes: Record<string, unknown>) => ({
  data: { type: 'albums', id, attributes },
})

// A playlist's resource object, every attribute present, as a collection page carries it.
const playlistObject = (id: string, title: string) => ({
  type: 'playlists',
  id,
  attributes: { title, slug: slugOf(title), public: true, externalId: null },
})

// A slug as a server might make one from a title.
const slugOf = (title: string): string => title.toLowerCase().replace(/ /g, '-')

// A released album's resource object, as a collection page carries it.
const albumObject = (id: string, title: string) => ({
  type: 'albums',
  id,
  attributes: { title, status: 'released' },
})

describe('reads', () => {
  it('lists a collection with include + sparse fields, typed end to end', async () => {
    const { transport, requests } = mockTransport({
      // The client serialises the flat query into JSON:API bracketed params, deterministically
      // (multi-value families like `fields` join with a `,`, percent-encoded as `%2C`).
      [`${BASE}/albums?filter[title]=OK&sort=-releasedAt&include=artist&fields[albums]=title%2Cstatus%2Cartist&page[number]=1`]:
        fixture('albums-collection.json'),
    })
    const client = createClient({ baseUrl: BASE, transport })

    // `include` widens `artist` to a hydrated resource; `fields[albums]` narrows the result to
    // exactly `title`/`status`/`artist` (any other attribute is statically ABSENT from the type).
    // A relation kept in `include` must also be kept in the fieldset to stay on the type.
    const albums = await client.albums.list({
      filter: { title: 'OK' },
      sort: '-releasedAt',
      include: ['artist'],
      fields: { albums: ['title', 'status', 'artist'] },
      page: { number: 1 },
    })

    // `albums` is an augmented array of materialised resources. The selected attributes are own
    // enumerable props; the hydrated `artist` is a full resource (its `name` is typed, no cast).
    expect(albums).toHaveLength(2)
    expect(albums[0]!.title).toBe('OK Computer')
    expect(albums[0]!.status).toBe('released')
    expect(albums[0]!.artist?.name).toBe('Radiohead')

    // Pagination rides the array as a non-enumerable `$page` accessor (count-free-safe).
    expect(albums.$page.kind).toBe('page')
    expect(albums.$meta?.['page']).toMatchObject({ currentPage: 1 })

    // The request the client actually sent.
    expect(requests[0]!.method).toBe('GET')
    expect(requests[0]!.headers['Accept']).toBe('application/vnd.api+json')
  })

  it('gets one resource, with its compound document hydrated', async () => {
    const { transport, requests } = mockTransport({
      [`${BASE}/albums/1?include=artist%2Ctracks`]: fixture('album-compound.json'),
      [`${BASE}/albums/1/tracks?page%5Bnumber%5D=2&page%5Bsize%5D=2`]: fixture(
        'album-tracks-related-page-2.json',
      ),
    })
    const client = createClient({ baseUrl: BASE, transport })

    const ok = await client.albums.get('1', { include: ['artist', 'tracks'] })

    expect(ok.title).toBe('OK Computer')
    // Resource-level envelope accessors hang off the materialised object (non-enumerable).
    expect(ok.$self).toBe(`${BASE}/albums/1`)
    // The to-many `tracks` relation is hydrated to an augmented array of track resources, holding
    // the first page the related endpoint serves: two tracks a page.
    expect(ok.tracks.map((t) => t.title)).toEqual(['Airbag', 'Exit Music (For a Film)'])
    expect(ok.tracks.$page.links.next).toBe(
      `${BASE}/albums/1/relationships/tracks?page%5Bnumber%5D=2&page%5Bsize%5D=2`,
    )

    // `loadAll` follows the next link, reading the page from the related endpoint as resources.
    const all = await loadAll(ok.tracks)
    expect(all.map((t) => t.title)).toEqual([
      'Airbag',
      'Exit Music (For a Film)',
      'Paranoid Android',
    ])
    expect(requests[1]!.url).toBe(`${BASE}/albums/1/tracks?page%5Bnumber%5D=2&page%5Bsize%5D=2`)
  })

  it('follows a relationship with .related() — the related collection, paginated', async () => {
    const { transport, requests } = mockTransport({
      [`${BASE}/albums/1/tracks?page[size]=2`]: fixture('album-tracks-related.json'),
    })
    const client = createClient({ baseUrl: BASE, transport })

    // `.related()` reads GET /albums/1/tracks — the related RESOURCES (full objects), not linkage.
    // A literal relation name (`.rel('tracks')`) narrows the result to a typed Collection of
    // tracks, so `t.title` is typed (no cast); pagination still rides `$page`.
    const tracks = await client.albums
      .id('1')
      .rel('tracks')
      .related({ page: { size: 2 } })

    expect(tracks).toHaveLength(2)
    expect(tracks.map((t) => t.title)).toEqual(['Airbag', 'Exit Music (For a Film)'])
    expect(tracks.$page.kind).toBe('page')
    expect(requests[0]!.url).toBe(`${BASE}/albums/1/tracks?page[size]=2`)
  })

  it('reads pivot data off a many-to-many edge via $pivot', async () => {
    const { transport } = mockTransport({
      [`${BASE}/playlists/${PLAYLIST}/orderedTracks?page[size]=2`]: fixture(
        'playlist-orderedtracks-related.json',
      ),
    })
    const client = createClient({ baseUrl: BASE, transport })

    const ordered = await client.playlists
      .id(PLAYLIST)
      .rel('orderedTracks')
      .related({ page: { size: 2 } })

    // Each member is a Track, but carries its per-edge pivot (`meta.pivot`) under the typed
    // `$pivot` accessor — the same Track in another playlist would carry a different position.
    expect(ordered[0]!.title).toBe('Airbag')
    expect(ordered[0]!.$pivot?.['position']).toBe(2)
  })
})

describe('a singleton', () => {
  // The caller's account is served at /me. The resource still carries its id.
  const account = (displayName: string) => ({
    data: {
      type: 'accounts',
      id: '1',
      attributes: { email: 'ada@example.com', displayName },
      relationships: {
        playlists: { data: [{ type: 'playlists', id: PLAYLIST }] },
      },
    },
  })

  it("reads and updates the caller's account with no id in the path", async () => {
    const { transport, requests } = mockTransport({
      [`GET ${BASE}/me`]: account('Ada'),
      [`PATCH ${BASE}/me`]: account('Ada Lovelace'),
    })
    const client = createClient({ baseUrl: BASE, transport })

    // `client.accounts` is a singleton accessor: no `list`, `create`, `id()` or `delete`.
    const me = await client.accounts.get()
    expect(me.id).toBe('1')
    expect(me.displayName).toBe('Ada')

    // The PATCH body must carry the id, so the input takes the one the read returned.
    const renamed = await client.accounts.update({ id: me.id, displayName: 'Ada Lovelace' })
    expect(renamed.displayName).toBe('Ada Lovelace')
    expect(JSON.parse(requests[1]!.body!)).toEqual({
      data: { type: 'accounts', id: '1', attributes: { displayName: 'Ada Lovelace' } },
    })
  })

  it('follows its relations under its own path', async () => {
    const { transport } = mockTransport({
      [`${BASE}/me/playlists`]: {
        data: [{ type: 'playlists', id: PLAYLIST, attributes: { name: 'Road trip' } }],
      },
    })
    const client = createClient({ baseUrl: BASE, transport })
    const playlists = await client.accounts.playlists.related()
    expect(playlists.map((playlist) => playlist.id)).toEqual([PLAYLIST])
  })
})

describe('filtering by a polymorphic relation and a set of booleans', () => {
  it('sends WhereMorph as nested keys and WhereSet once per member', async () => {
    const { transport, requests } = mockTransport({
      [`${BASE}/favorites?filter[favoritable][type]=tracks&filter[favoritable][id]=1%2C2&filter[dated][]=true&filter[dated][]=false`]:
        { data: [] },
    })
    const client = createClient({ baseUrl: BASE, transport })
    // `dated` has a default of [true]; sending both values asks for every favorite.
    const favorites = await client.favorites.list({
      filter: { favoritable: { type: 'tracks', id: ['1', '2'] }, dated: [true, false] },
    })
    expect(favorites).toHaveLength(0)
    expect(requests).toHaveLength(1)
  })
})

describe('writes', () => {
  it('creates a resource (POST) and materialises the 201 response', async () => {
    const { transport, requests } = mockTransport({
      [`POST ${BASE}/albums`]: album('10', { title: 'Kid A', status: 'released' }),
    })
    const client = createClient({ baseUrl: BASE, transport })

    // Flat input — the client wraps it into a JSON:API document. `title` is required by the
    // generated `AlbumsCreateAttributes`; `status` is the enum `AlbumStatus`.
    const created = await client.albums.create({ title: 'Kid A', status: 'released' })

    expect(created.id).toBe('10')
    expect(created.title).toBe('Kid A')
    // The wire body is the JSON:API create envelope (attributes nested under data).
    const sent = JSON.parse(requests[0]!.body!) as { data: { attributes: Record<string, unknown> } }
    expect(sent.data.attributes).toEqual({ title: 'Kid A', status: 'released' })
  })

  it('updates a resource (PATCH) with a partial patch', async () => {
    const { transport } = mockTransport({
      [`PATCH ${BASE}/albums/1`]: album('1', {
        title: 'OK Computer (Remaster)',
        status: 'released',
      }),
    })
    const client = createClient({ baseUrl: BASE, transport })

    const updated = await client.albums.id('1').update({ title: 'OK Computer (Remaster)' })
    expect(updated.title).toBe('OK Computer (Remaster)')
  })

  it('deletes a resource (DELETE) — a 204 resolves void', async () => {
    const { transport } = mockTransport({ [`DELETE ${BASE}/albums/1`]: '' })
    const client = createClient({ baseUrl: BASE, transport })

    const result = await client.albums.id('1').delete()
    expect(result).toBeUndefined()
  })

  it('surfaces a 422 with byPath() keyed by the flat input path', async () => {
    const { transport } = mockTransport({
      [`POST ${BASE}/albums`]: JSON.stringify({
        errors: [
          {
            status: '422',
            detail: 'must not be blank',
            source: { pointer: '/data/attributes/title' },
          },
        ],
      }),
    })
    // Force the 422: the helper would otherwise reply 201, so override the status here.
    const failing: typeof transport = async (req) => ({ ...(await transport(req)), status: 422 })
    const client = createClient({ baseUrl: BASE, transport: failing })

    const error = (await client.albums
      .create({ title: '' })
      .catch((e: unknown) => e)) as JsonApiError
    expect(error.isUnprocessable()).toBe(true)
    // The server pointer `/data/attributes/title` is remapped to the flat input key `title`.
    expect(error.byPath()['title']?.[0]?.detail).toBe('must not be blank')
  })

  it('sorts a 422 into field errors with fieldErrors()', async () => {
    const { transport } = mockTransport({
      [`POST ${BASE}/albums`]: JSON.stringify({
        errors: [
          {
            status: '422',
            title: 'Invalid attribute',
            detail: 'must not be blank',
            source: { pointer: '/data/attributes/title' },
          },
          { status: '422', detail: 'Rate limit window exceeded', source: { header: 'X-Quota' } },
        ],
      }),
    })
    const failing: typeof transport = async (req) => ({ ...(await transport(req)), status: 422 })
    const client = createClient({ baseUrl: BASE, transport: failing })

    type AlbumInput = Parameters<typeof client.albums.create>[0]
    const caught = await client.albums.create({ title: '' }).catch((e: unknown) => e)
    const fe = fieldErrors<AlbumInput>(caught)

    expect(fe?.first('title')).toBe('must not be blank')
    expect(fe?.fields['title']?.[0]?.path).toEqual(['title'])
    expect(fe?.form.map((issue) => issue.message)).toEqual(['Rate limit window exceeded'])
  })
})

describe('relationship mutations', () => {
  it('adds members to a to-many relationship (POST …/relationships/tracks)', async () => {
    const { transport, requests } = mockTransport({
      [`POST ${BASE}/albums/1/relationships/tracks`]: fixture('album-tracks-relationship.json'),
    })
    const client = createClient({ baseUrl: BASE, transport })

    // The generated descriptor advertises add/remove/replace for `albums.tracks`, so all three
    // verbs are present at runtime AND in the type. `add` POSTs the linkage refs.
    await client.albums
      .id('1')
      .rel('tracks')
      .add([{ type: 'tracks', id: '4' }])

    const sent = JSON.parse(requests[0]!.body!) as { data: Array<{ type: string; id: string }> }
    expect(requests[0]!.method).toBe('POST')
    expect(sent.data).toEqual([{ type: 'tracks', id: '4' }])
  })

  it('replaces a to-many relationship wholesale (PATCH …/relationships/tracks)', async () => {
    const { transport, requests } = mockTransport({
      [`PATCH ${BASE}/albums/1/relationships/tracks`]: fixture('album-tracks-relationship.json'),
    })
    const client = createClient({ baseUrl: BASE, transport })

    await client.albums
      .id('1')
      .rel('tracks')
      .replace([
        { type: 'tracks', id: '1' },
        { type: 'tracks', id: '3' },
      ])

    expect(requests[0]!.method).toBe('PATCH')
    const sent = JSON.parse(requests[0]!.body!) as { data: Array<{ id: string }> }
    expect(sent.data.map((r) => r.id)).toEqual(['1', '3'])
  })

  it('sets a to-one relationship (PATCH …/relationships/artist)', async () => {
    const { transport, requests } = mockTransport({
      [`PATCH ${BASE}/albums/1/relationships/artist`]: JSON.stringify({
        data: { type: 'artists', id: '2' },
      }),
    })
    const client = createClient({ baseUrl: BASE, transport })

    // A to-one exposes `.set(ref | null)` (not add/remove/replace).
    await client.albums.id('1').rel('artist').set({ type: 'artists', id: '2' })

    expect(requests[0]!.method).toBe('PATCH')
    const sent = JSON.parse(requests[0]!.body!) as { data: { type: string; id: string } }
    expect(sent.data).toEqual({ type: 'artists', id: '2' })
  })
})

describe('custom actions', () => {
  it('invokes a resource-scoped action that takes a document and returns one', async () => {
    const { transport, requests } = mockTransport({
      [`POST ${BASE}/albums/1/-actions/reissue`]: album('1', {
        title: 'OK Computer',
        status: 'released',
      }),
    })
    const client = createClient({ baseUrl: BASE, transport })

    // `reissue` is `input: document, output: document` with an `inputType`, so the caller
    // passes FLAT attributes (exactly like a create) and the client builds the
    // `{ data: { type, attributes } }` envelope. The 2xx document is MATERIALISED into a
    // flattened resource, so we read `id`/attributes straight off the result.
    const reissued = (await client.albums.id('1').actions.reissue({
      releasedAt: '2001-10-01T00:00:00+00:00',
    })) as unknown as { id: string; title: string }

    expect(reissued.id).toBe('1')
    expect(reissued.title).toBe('OK Computer')
    expect(requests[0]!.url).toBe(`${BASE}/albums/1/-actions/reissue`)
    expect(requests[0]!.method).toBe('POST')
  })

  it('invokes a collection-scoped action with no input', async () => {
    const { transport, requests } = mockTransport({
      [`POST ${BASE}/albums/-actions/summary`]: { meta: { totalAlbums: 42 } },
    })
    const client = createClient({ baseUrl: BASE, transport })

    // `summary` is collection-scoped (`input: none`, `output: meta`), reached off the type
    // accessor's `.actions`. A meta-only action returns the document `meta` directly (no
    // resource to materialise).
    const summary = (await client.albums.actions.summary()) as unknown as { totalAlbums: number }
    expect(summary.totalAlbums).toBe(42)
    expect(requests[0]!.url).toBe(`${BASE}/albums/-actions/summary`)
  })
})

describe('atomic operations', () => {
  it('runs an all-or-nothing batch with a cross-op lid reference, typed positionally', async () => {
    // The server replies with one result per recorded op, in order.
    const { transport, requests } = mockTransport({
      [`POST ${BASE}/operations`]: JSON.stringify({
        'atomic:results': [
          { data: { type: 'artists', id: '99', attributes: { name: 'Boards of Canada' } } },
          { data: { type: 'albums', id: '100', attributes: { title: 'Geogaddi' } } },
        ],
      }),
    })
    // The generated `createClient` threads the server's `atomic` capability in by default.
    const client = createClient({ baseUrl: BASE, transport })

    // The callback records ops in order and returns the handles it wants results for. A
    // `tx.create` handle DOUBLES AS a `{ type, lid }` ref, so the album wires to the just-created
    // artist with no server id yet.
    const [artist, geogaddi] = await client.atomic((tx) => {
      const newArtist = tx.create({ type: 'artists', name: 'Boards of Canada' })
      // The catalog requires an album created in a batch to say where it came from.
      const newAlbum = tx.create(
        { type: 'albums', title: 'Geogaddi', artist: newArtist },
        { meta: { source: 'import' } },
      )
      return [newArtist, newAlbum] as const
    })

    // Each handle resolves to its OWN positional, materialised result (by op index).
    expect(artist.data.type).toBe('artists')
    expect(artist.data.id).toBe('99')
    expect(geogaddi.data.type).toBe('albums')
    expect(geogaddi.data.title).toBe('Geogaddi')

    // The wire batch: the album's `artist` relationship references the artist's lid, not an id.
    const sent = JSON.parse(requests[0]!.body!) as {
      'atomic:operations': Array<{ op: string; data: { lid?: string; relationships?: unknown } }>
    }
    expect(sent['atomic:operations'][0]!.data.lid).toBe('atomic-0')
    expect(sent['atomic:operations'][1]!.data.relationships).toEqual({
      artist: { data: { type: 'artists', lid: 'atomic-0' } },
    })
    // The atomic ext media type is negotiated on both Content-Type and Accept.
    expect(requests[0]!.headers['Content-Type']).toMatch(
      /ext="https:\/\/jsonapi\.org\/ext\/atomic"/,
    )
  })

  it('sends batches and reads results the server document describes', async () => {
    const results = {
      'atomic:results': [
        { data: { type: 'artists', id: '99', attributes: { name: 'Boards of Canada' } } },
        { data: { type: 'albums', id: '100', attributes: { title: 'Geogaddi' } } },
        {},
      ],
    }
    const { transport, requests } = mockTransport({
      [`POST ${BASE}/operations`]: JSON.stringify(results),
    })
    const client = createClient({ baseUrl: BASE, transport })
    await client.atomic((tx) => {
      const newArtist = tx.create({ type: 'artists', name: 'Boards of Canada' })
      tx.update({
        type: 'albums',
        id: '100',
        title: 'Geogaddi',
        // Linked by the lid of the artist the add creates, which the document must accept.
        artist: newArtist,
      })
      tx.delete({ type: 'albums', id: '101' })
      return [newArtist] as const
    })

    // The document's AtomicOperation is a oneOf per operation kind, so each recorded op must
    // match exactly one of them.
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
    ajv.addSchema(
      JSON.parse(
        readFileSync(
          createRequire(import.meta.url).resolve(
            '@haddowg/json-api-symfony-specs/music-catalog.openapi.json',
          ),
          'utf8',
        ),
      ),
      'spec',
    )
    const request = ajv.getSchema('spec#/components/schemas/AtomicOperationsRequest')!
    const sent = JSON.parse(requests[0]!.body!) as {
      'atomic:operations': Array<{ data?: { relationships?: unknown } }>
    }
    expect(sent['atomic:operations'][1]!.data?.relationships).toEqual({
      artist: { data: { type: 'artists', lid: 'atomic-0' } },
    })
    expect(request(sent), JSON.stringify(request.errors)).toBe(true)
    const response = ajv.getSchema('spec#/components/schemas/AtomicResultsResponse')!
    expect(response(results), JSON.stringify(response.errors)).toBe(true)
  })
  it('changes a relationship inside a batch through tx.rel, as the relationship accessor does', async () => {
    const results = {
      'atomic:results': [
        { data: { type: 'playlists', id: '7', attributes: { title: 'Late night' } } },
        { data: [{ type: 'tracks', id: '5' }] },
        {},
      ],
    }
    const { transport, requests } = mockTransport({
      [`POST ${BASE}/operations`]: JSON.stringify(results),
    })
    const client = createClient({ baseUrl: BASE, transport })

    // `tx.rel(ref, name)` reaches a relationship of the resource `ref` names, here one the batch
    // creates, and its verbs record one operation each, typed and gated like the accessor's.
    const [, tracks] = await client.atomic((tx) => {
      const playlist = tx.create({ type: 'playlists', title: 'Late night' })
      return [
        playlist,
        tx
          .rel(playlist, 'orderedTracks')
          .add([{ type: 'tracks', id: '5', $pivot: { position: 1 } }]),
        tx.rel(playlist, 'publicOwner').set({ type: 'public-profiles', id: '1' }),
      ] as const
    })
    expect(tracks.data?.[0]?.id).toBe('5')

    const sent = JSON.parse(requests[0]!.body!) as { 'atomic:operations': unknown[] }
    expect(sent['atomic:operations'].slice(1)).toEqual([
      {
        op: 'add',
        ref: { type: 'playlists', lid: 'atomic-0', relationship: 'orderedTracks' },
        data: [{ type: 'tracks', id: '5', meta: { pivot: { position: 1 } } }],
      },
      {
        op: 'update',
        ref: { type: 'playlists', lid: 'atomic-0', relationship: 'publicOwner' },
        data: { type: 'public-profiles', id: '1' },
      },
    ])
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
    ajv.addSchema(
      JSON.parse(
        readFileSync(
          createRequire(import.meta.url).resolve(
            '@haddowg/json-api-symfony-specs/music-catalog.openapi.json',
          ),
          'utf8',
        ),
      ),
      'spec',
    )
    const request = ajv.getSchema('spec#/components/schemas/AtomicOperationsRequest')!
    expect(request(sent), JSON.stringify(request.errors)).toBe(true)
  })
})

describe('TanStack Query bindings', () => {
  it('drives reads through option factories and patches the cache on update (write-through normalization)', async () => {
    const { transport } = mockTransport({
      [`${BASE}/albums`]: {
        data: [{ type: 'albums', id: '1', attributes: { title: 'Old title', status: 'released' } }],
      },
      [`${BASE}/albums/1`]: {
        data: { type: 'albums', id: '1', attributes: { title: 'Old title', status: 'released' } },
      },
      [`PATCH ${BASE}/albums/1`]: album('1', { title: 'Fresh title', status: 'released' }),
    })
    const client = createClient({ baseUrl: BASE, transport })

    // One QueryClient hosts one descriptor. `JsonApiMutationCache` runs each mutation's cache
    // upkeep, and `installNormalization` auto-runs the `type:id` write-through patch on every
    // successful query/mutation — "edit once, updates everywhere".
    const qc = new QueryClient({
      mutationCache: new JsonApiMutationCache(),
      defaultOptions: { queries: { staleTime: Infinity } },
    })
    const teardown = installNormalization(qc, resourceMap)

    // The bound read API: `api.<type>.list(query)` returns `{ queryKey, queryFn }` for `useQuery`
    // (or, here, `fetchQuery`). The factories preserve the client's full static narrowing.
    const reads = createQueryApi(client)
    const listOpts = reads.albums.list()
    const getOpts = reads.albums.get('1')
    await qc.fetchQuery(listOpts)
    await qc.fetchQuery(getOpts)

    // The bound mutation API. An update PATCHES the cache via normalize on success (no refetch).
    const writes = createMutationApi(qc, client, resourceMap)
    const updateOpts = writes.albums.id('1').update()
    await qc
      .getMutationCache()
      .build(qc, updateOpts as never)
      .execute({ title: 'Fresh title' })

    // Both the cached list AND the cached single-get now reflect the fresh title — patched in
    // place by `type:id`, not refetched.
    const cachedList = qc.getQueryData(listOpts.queryKey) as Array<{ title: string }>
    const cachedGet = qc.getQueryData(getOpts.queryKey) as { title: string }
    expect(cachedList[0]!.title).toBe('Fresh title')
    expect(cachedGet.title).toBe('Fresh title')

    teardown()
  })

  it('types cache reads and writes by the query key, with no cast', async () => {
    const { transport } = mockTransport({
      [`${BASE}/albums/1?include=artist`]: {
        data: {
          type: 'albums',
          id: '1',
          attributes: { title: 'OK Computer', status: 'released' },
          relationships: { artist: { data: { type: 'artists', id: '1' } } },
        },
        included: [{ type: 'artists', id: '1', attributes: { name: 'Radiohead' } }],
      },
    })
    const client = createClient({ baseUrl: BASE, transport })
    const queryClient = new QueryClient()
    const reads = createQueryApi(client)

    const albumOptions = reads.albums.get('1', { include: ['artist'] })
    await queryClient.fetchQuery(albumOptions)

    // The key is tagged with the read's result type, so the cache hands back the album view.
    const cached = queryClient.getQueryData(albumOptions.queryKey) // the album view | undefined
    expect(cached?.title).toBe('OK Computer')
    expect(cached?.artist?.name).toBe('Radiohead')

    // `old` is the album view too.
    queryClient.setQueryData(albumOptions.queryKey, (old) => old)
    expect(queryClient.getQueryData(albumOptions.queryKey)).toBe(cached)
  })

  it("narrows a read's error to the server's documented codes with hasErrorCode", async () => {
    const { transport } = mockTransport({
      [`${BASE}/albums/404`]: {
        errors: [{ status: '404', code: 'RESOURCE_NOT_FOUND', title: 'Resource not found' }],
      },
    })
    const notFound: typeof transport = async (req) => ({ ...(await transport(req)), status: 404 })
    const client = createClient({ baseUrl: BASE, transport: notFound })
    const queryClient = new QueryClient()
    // `installNormalization` also installs `jsonApiRetry`, so the 404 isn't retried.
    const teardown = installNormalization(queryClient, resourceMap)
    const reads = createQueryApi(client)

    // What `useQuery(reads.albums.get('404'))` holds once the read settles.
    const albumQuery = await new QueryObserver(queryClient, reads.albums.get('404')).refetch()
    // Typed by the codes `fetchOne.albums` raises.
    type FetchOneCode = ErrorCodeByOperation['fetchOne.albums']
    expectTypeOf(albumQuery.error).toEqualTypeOf<ReadError<FetchOneCode> | null>()
    expect(hasErrorCode(albumQuery.error, 'RESOURCE_NOT_FOUND')).toBe(true)
    if (hasErrorCode(albumQuery.error, 'RESOURCE_NOT_FOUND')) {
      const errors: JsonApiErrorObject<FetchOneCode>[] = albumQuery.error.errors
      expect(errors[0]?.code).toBe('RESOURCE_NOT_FOUND')
    }
    // @ts-expect-error a read never fails validation
    hasErrorCode(albumQuery.error, 'VALIDATION_FAILED')

    teardown()
  })

  it('keeps a read disabled with skipToken until its input exists', async () => {
    const { transport, requests } = mockTransport({})
    const client = createClient({ baseUrl: BASE, transport })
    const queryClient = new QueryClient()
    const reads = createQueryApi(client)
    const albumId = undefined as string | undefined
    const ready = false as boolean

    const albumQuery = new QueryObserver(queryClient, reads.albums.get(albumId ?? skipToken))
    const albumsQuery = new QueryObserver(
      queryClient,
      reads.albums.list(ready ? { include: ['artist'] } : skipToken),
    )
    const artistQuery = new QueryObserver(
      queryClient,
      reads.albums.related(albumId ?? skipToken, 'artist'),
    )
    const observers = [albumQuery, albumsQuery, artistQuery]
    const unsubscribes = observers.map((observer) => observer.subscribe(() => {}))
    await Promise.resolve()

    // A skipped read stays idle and sends nothing, under a deterministic key with no params.
    expect(observers.map((observer) => observer.getCurrentResult().fetchStatus)).toEqual([
      'idle',
      'idle',
      'idle',
    ])
    expect(requests).toHaveLength(0)
    expect(reads.albums.get(albumId ?? skipToken).queryKey).toEqual([
      'albums',
      'fetchOne',
      { $skip: true },
    ])
    expect(reads.albums.related(albumId ?? skipToken, 'artist').queryKey).toEqual([
      'albums',
      'fetchRelated',
      { $skip: true },
      'artist',
    ])

    unsubscribes.forEach((unsubscribe) => unsubscribe())
  })
})

describe('infinite queries', () => {
  it('reads a list page by page from its links, and patches a cached page on update', async () => {
    const { transport, requests } = mockTransport({
      // The first page names the next one in its `next` link...
      [`${BASE}/albums?page[size]=1`]: {
        data: [albumObject('1', 'OK Computer')],
        links: { next: `${BASE}/albums?page%5Bnumber%5D=2&page%5Bsize%5D=1` },
      },
      // ...and the last page has none.
      [`${BASE}/albums?page[number]=2&page[size]=1`]: {
        data: [albumObject('2', 'Kid A')],
        links: { prev: `${BASE}/albums?page%5Bnumber%5D=1&page%5Bsize%5D=1` },
      },
      [`PATCH ${BASE}/albums/2`]: album('2', { title: 'Kid A Mnesia', status: 'released' }),
    })
    const client = createClient({ baseUrl: BASE, transport })
    const qc = new QueryClient({
      mutationCache: new JsonApiMutationCache(),
      defaultOptions: { queries: { staleTime: Infinity } },
    })
    const teardown = installNormalization(qc, resourceMap)
    const reads = createQueryApi(client)

    // `reads.<type>.infinite(query)` returns options for `useInfiniteQuery` (or, here,
    // `fetchInfiniteQuery`). The first page is the query's own `page`; the key is the list's key
    // plus '$infinite'.
    const options = reads.albums.infinite({ page: { size: 1 } })
    expect(options.queryKey).toEqual(['albums', 'fetchMany', { page: { size: 1 } }, '$infinite'])
    const first = await qc.fetchInfiniteQuery(options)
    expect(first.pages[0]![0]!.title).toBe('OK Computer')

    // The next page's params come from the page's `next` link, which `fetchNextPage` reads.
    const observer = new InfiniteQueryObserver(qc, options)
    expect(observer.getCurrentResult().hasNextPage).toBe(true)
    const result = await observer.fetchNextPage()
    expect(result.data?.pages.map((page) => page.map((a) => a.title))).toEqual([
      ['OK Computer'],
      ['Kid A'],
    ])
    expect(result.hasNextPage).toBe(false)
    expect(requests[1]!.url).toBe(`${BASE}/albums?page[number]=2&page[size]=1`)

    // An update patches the album on whichever cached page holds it, as for any other read.
    const writes = createMutationApi(qc, client, resourceMap)
    await qc
      .getMutationCache()
      .build(qc, writes.albums.id('2').update() as never)
      .execute({ title: 'Kid A Mnesia' })
    expect(qc.getQueryData(options.queryKey)?.pages[1]![0]!.title).toBe('Kid A Mnesia')

    observer.destroy()
    teardown()
  })
})

/** A QueryClient built as an app builds one: the mutation cache, and the descriptor installed. */
function jsonApiQueryClient(): QueryClient {
  const qc = new QueryClient({
    mutationCache: new JsonApiMutationCache(),
    defaultOptions: { queries: { staleTime: Infinity } },
  })
  installNormalization(qc, resourceMap)
  return qc
}

describe('mutation cache', () => {
  it('keeps the upkeep when your own callbacks are spread alongside the options', async () => {
    const original = {
      type: 'albums',
      id: '1',
      attributes: { title: 'Old title', status: 'released' },
    }
    const { transport } = mockTransport({
      [`${BASE}/albums`]: { data: [original] },
      [`PATCH ${BASE}/albums/1`]: album('1', { title: 'Fresh title', status: 'released' }),
    })
    const client = createClient({ baseUrl: BASE, transport })
    const qc = jsonApiQueryClient()
    const reads = createQueryApi(client)
    const writes = createMutationApi(qc, client, resourceMap)
    const listOpts = reads.albums.list()
    await qc.fetchQuery(listOpts)
    const title = () => (qc.getQueryData(listOpts.queryKey) as Array<{ title: string }>)[0]!.title

    // The idiomatic spread: your onSuccess runs after the cache's normalisation, so it already
    // sees the patched list.
    const seen: string[] = []
    await qc
      .getMutationCache()
      .build(qc, {
        ...writes.albums.id('1').update(),
        onSuccess: () => {
          seen.push(`success:${title()}`)
        },
      } as never)
      .execute({ title: 'Fresh title' })
    expect(seen).toEqual(['success:Fresh title'])

    // An optimistic update whose write fails: your onMutate sees the optimistic value, and your
    // onError the rolled-back one. The rollback ran first, in the mutation cache.
    const failing = createClient({
      baseUrl: BASE,
      transport: async () => ({ status: 500, headers: {}, body: '' }),
    })
    const failingWrites = createMutationApi(qc, failing, resourceMap)
    await expect(
      qc
        .getMutationCache()
        .build(qc, {
          ...failingWrites.albums.id('1').update({ optimistic: true }),
          onMutate: () => {
            seen.push(`mutate:${title()}`)
          },
          onError: () => {
            seen.push(`error:${title()}`)
          },
          onSettled: () => {
            seen.push(`settled:${title()}`)
          },
        } as never)
        .execute({ title: 'Optimistic title' }),
    ).rejects.toBeDefined()
    expect(seen).toEqual([
      'success:Fresh title',
      'mutate:Optimistic title',
      'error:Fresh title',
      'settled:Fresh title',
    ])
    expect(title()).toBe('Fresh title')
  })

  it('finds a pending mutation by its key', async () => {
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = createClient({
      baseUrl: BASE,
      transport: async () => {
        await held
        return {
          status: 200,
          headers: {},
          body: JSON.stringify(album('1', { title: 'Fresh title', status: 'released' })),
        }
      },
    })
    const qc = jsonApiQueryClient()
    const writes = createMutationApi(qc, client, resourceMap)
    const update = writes.albums.id('1').update()
    expect(update.mutationKey).toEqual(['albums', 'update', '1'])

    const pending = qc
      .getMutationCache()
      .build(qc, update as never)
      .execute({ title: 'Fresh title' })
    // Mutation filters match by prefix: every write on albums, every update, this album's.
    expect(qc.isMutating({ mutationKey: ['albums'] })).toBe(1)
    expect(qc.isMutating({ mutationKey: mutationKeyFor({ type: 'albums', verb: 'update' }) })).toBe(
      1,
    )
    expect(
      qc.isMutating({ mutationKey: mutationKeyFor({ type: 'albums', verb: 'update', id: '1' }) }),
    ).toBe(1)
    expect(
      qc.isMutating({ mutationKey: mutationKeyFor({ type: 'albums', verb: 'delete', id: '1' }) }),
    ).toBe(0)

    release?.()
    await pending
    expect(qc.isMutating({ mutationKey: ['albums'] })).toBe(0)
  })
})

/**
 * A transport whose answers can be held open, so a test can look at the cache while a write is
 * still pending, as a component would.
 */
function heldTransport(routes: Record<string, object | 'fail'>) {
  const gates = new Map<string, Promise<void>>()
  const requests: string[] = []
  return {
    requests,
    /** Hold the next `METHOD url` open until the returned function is called. */
    hold(key: string): () => void {
      let release!: () => void
      gates.set(
        key,
        new Promise<void>((resolve) => {
          release = resolve
        }),
      )
      return release
    },
    transport: async (req: TransportRequest): Promise<TransportResponse> => {
      const key = `${req.method} ${req.url}`
      requests.push(key)
      const route = routes[key]
      const gate = gates.get(key)
      gates.delete(key)
      await gate
      if (route === undefined || route === 'fail') {
        return {
          status: 422,
          headers: {},
          body: JSON.stringify({ errors: [{ status: '422', detail: 'rejected' }] }),
        }
      }
      const status = req.method === 'POST' && !req.url.includes('relationships') ? 201 : 200
      return { status, headers: {}, body: JSON.stringify(route) }
    },
  }
}

/** An ordered track's linkage, carrying its pivot. */
const edge = (id: string, position: number) => ({
  type: 'tracks',
  id,
  meta: { pivot: { position, weight: null, addedAt: '2026-01-01T00:00:00Z' } },
})

describe('optimistic updates', () => {
  it('shows an update before the server answers, and rolls it back when the write fails', async () => {
    const { transport, hold } = heldTransport({
      [`GET ${BASE}/albums`]: { data: [albumObject('1', 'OK Computer')] },
      [`PATCH ${BASE}/albums/1`]: 'fail',
    })
    const client = createClient({ baseUrl: BASE, transport })
    const qc = jsonApiQueryClient()
    const reads = createQueryApi(client)
    const writes = createMutationApi(qc, client, resourceMap)
    const list = reads.albums.list()
    await qc.fetchQuery(list)
    const first = () => qc.getQueryData(list.queryKey)![0]!

    // `{ optimistic: true }` predicts the write: the title changes everywhere the album is cached,
    // and the row is marked pending until the write settles.
    const release = hold(`PATCH ${BASE}/albums/1`)
    const rename = qc
      .getMutationCache()
      .build(qc, writes.albums.id('1').update({ optimistic: true }) as never)
      .execute({ title: 'OK Computer OKNOTOK' })
    expect(first().title).toBe('OK Computer OKNOTOK')
    expect(first().$optimistic).toBe('pending')

    // The server rejects it: the prediction is rolled back.
    release()
    await expect(rename).rejects.toBeDefined()
    expect(first().title).toBe('OK Computer')
    expect(first().$optimistic).toBeUndefined()
  })

  it('turns optimism on for every write with the mutation cache, and off for one with false', async () => {
    const { transport, hold } = heldTransport({
      [`GET ${BASE}/albums`]: { data: [albumObject('1', 'OK Computer')] },
      [`PATCH ${BASE}/albums/1`]: album('1', { title: 'Kid A', status: 'released' }),
    })
    const client = createClient({ baseUrl: BASE, transport })
    const qc = new QueryClient({
      mutationCache: new JsonApiMutationCache({ optimistic: true }),
      defaultOptions: { queries: { staleTime: Infinity } },
    })
    const teardown = installNormalization(qc, resourceMap)
    const reads = createQueryApi(client)
    const writes = createMutationApi(qc, client, resourceMap)
    const list = reads.albums.list()
    await qc.fetchQuery(list)

    const release = hold(`PATCH ${BASE}/albums/1`)
    const rename = qc
      .getMutationCache()
      .build(qc, writes.albums.id('1').update() as never)
      .execute({ title: 'Kid A' })
    expect(qc.getQueryData(list.queryKey)![0]!.title).toBe('Kid A')
    release()
    await rename

    // `optimistic: false` waits for the server.
    expect(writes.albums.id('1').update({ optimistic: false }).meta).toEqual({
      jsonApi: { verb: 'update', type: 'albums', id: '1', optimistic: false },
    })
    teardown()
  })

  it('adds a member where it fits, and reports one it cannot show yet through $pending', async () => {
    const { transport, hold } = heldTransport({
      [`GET ${BASE}/albums/1/relationships/tracks`]: {
        data: [{ type: 'tracks', id: '1' }],
      },
      [`GET ${BASE}/albums/1?include=tracks`]: {
        data: {
          type: 'albums',
          id: '1',
          attributes: { title: 'OK Computer', status: 'released' },
          relationships: { tracks: { data: [{ type: 'tracks', id: '1' }] } },
        },
        included: [{ type: 'tracks', id: '1', attributes: { title: 'Airbag' } }],
      },
      [`POST ${BASE}/albums/1/relationships/tracks`]: {
        data: [
          { type: 'tracks', id: '1' },
          { type: 'tracks', id: '4' },
        ],
      },
    })
    const client = createClient({ baseUrl: BASE, transport })
    const qc = jsonApiQueryClient()
    const reads = createQueryApi(client)
    const writes = createMutationApi(qc, client, resourceMap)
    const linkage = reads.albums.relationship('1', 'tracks')
    const withTracks = reads.albums.get('1', { include: ['tracks'] })
    await qc.fetchQuery(linkage)
    await qc.fetchQuery(withTracks)

    const release = hold(`POST ${BASE}/albums/1/relationships/tracks`)
    const add = qc
      .getMutationCache()
      .build(qc, writes.albums.id('1').rel('tracks').add({ optimistic: true }) as never)
      .execute([{ type: 'tracks', id: '4' }])
    // The relationship read holds identifiers, so track 4 goes straight in.
    expect((qc.getQueryData(linkage.queryKey) as Array<{ id: string }>).map((t) => t.id)).toEqual([
      '1',
      '4',
    ])
    // The included slot promises tracks with their attributes, and track 4 isn't cached: it is
    // left out of the slot and reported as pending instead.
    const cached = qc.getQueryData(withTracks.queryKey)!
    expect(cached.tracks.map((t) => t.id)).toEqual(['1'])
    expect(cached.$pending('tracks')).toEqual([{ type: 'tracks', id: '4' }])

    release()
    await add
  })

  it('places an added member by its typed pivot', async () => {
    const linkagePath = `${BASE}/playlists/${PLAYLIST}/relationships/orderedTracks`
    const { transport, hold } = heldTransport({
      [`GET ${linkagePath}?page[size]=2`]: {
        data: [edge('1', 1), edge('3', 3)],
        links: { next: `${linkagePath}?page[number]=2&page[size]=2` },
      },
      [`POST ${linkagePath}`]: { data: [edge('1', 1), edge('2', 2), edge('3', 3)] },
    })
    const client = createClient({ baseUrl: BASE, transport })
    const qc = jsonApiQueryClient()
    const reads = createQueryApi(client)
    const writes = createMutationApi(qc, client, resourceMap)
    const linkage = reads.playlists.relationship(PLAYLIST, 'orderedTracks', { page: { size: 2 } })
    await qc.fetchQuery(linkage)

    // The page has a `next` link, so the member isn't placed automatically. `into` orders it by
    // its pivot: the entering member's `$pivot` is the write pivot, the loaded ones' the read pivot.
    const release = hold(`POST ${linkagePath}`)
    const add = qc
      .getMutationCache()
      .build(
        qc,
        writes.playlists
          .id(PLAYLIST)
          .rel('orderedTracks')
          .add({
            optimistic: {
              into: (q, member) =>
                q.type === 'playlists' && q.rel === 'orderedTracks'
                  ? (members) =>
                      members.findIndex(
                        (m) => (m.$pivot?.position ?? Infinity) > (member.$pivot?.position ?? 0),
                      )
                  : false,
            },
          }) as never,
      )
      .execute([{ type: 'tracks', id: '2', $pivot: { position: 2 } }])
    expect((qc.getQueryData(linkage.queryKey) as Array<{ id: string }>).map((t) => t.id)).toEqual([
      '1',
      '2',
      '3',
    ])
    release()
    await add
  })

  it('creates a row with a temporary id, placed by into, swapped for the server’s id', async () => {
    const { transport, hold } = heldTransport({
      [`GET ${BASE}/albums?fields[albums]=title%2Cstatus`]: {
        data: [albumObject('1', 'OK Computer')],
      },
      [`POST ${BASE}/albums`]: album('10', { title: 'Kid A', status: 'released' }),
    })
    const client = createClient({ baseUrl: BASE, transport })
    const qc = jsonApiQueryClient()
    const reads = createQueryApi(client)
    const writes = createMutationApi(qc, client, resourceMap)
    const list = reads.albums.list({ fields: { albums: ['title', 'status'] } })
    await qc.fetchQuery(list)

    // A create is placed only where `into` says: here, first in every list of albums.
    const create = writes.albums.create({
      optimistic: { into: (q) => (q.operation === 'fetchMany' ? 'start' : false) },
    })
    const variables = { title: 'Kid A', status: 'released' as const }
    const release = hold(`POST ${BASE}/albums`)
    const pending = qc
      .getMutationCache()
      .build(qc, create as never)
      .execute(variables)
    // Albums take no client id, so the row carries a temporary one, kept in the variables.
    const temp = (variables as { $tempId?: string }).$tempId
    expect(temp).toMatch(/^\$tmp:/)
    expect(qc.getQueryData(list.queryKey)![0]!.id).toBe(temp)

    release()
    await pending
    expect(qc.getQueryData(list.queryKey)![0]!.id).toBe('10')
  })

  it('completes a create’s server-only attributes so it shows in a list of whole playlists', async () => {
    const { transport, hold } = heldTransport({
      [`GET ${BASE}/playlists`]: {
        data: [playlistObject(PLAYLIST, 'Late Night')],
        meta: { page: { currentPage: 1, perPage: 15, total: 1 } },
      },
      [`POST ${BASE}/playlists`]: { data: playlistObject('p-new', 'Road Trip') },
    })
    const client = createClient({ baseUrl: BASE, transport })
    const qc = jsonApiQueryClient()
    const reads = createQueryApi(client)
    const writes = createMutationApi(qc, client, resourceMap)
    const list = reads.playlists.list()
    await qc.fetchQuery(list)

    // The list promises every attribute: `slug`, which only the server sets, and the optional
    // `externalId`, which this create leaves out. `complete` supplies both, typed by what the create
    // input may lack.
    const create = writes.playlists.create({
      optimistic: {
        into: () => 'start',
        complete: (input) => ({ slug: slugOf(input.title), externalId: 'pending' }),
      },
    })
    const release = hold(`POST ${BASE}/playlists`)
    const pending = qc
      .getMutationCache()
      .build(qc, create as never)
      .execute({ title: 'Road Trip', public: true })
    const row = qc.getQueryData(list.queryKey)![0]!
    expect(row.title).toBe('Road Trip')
    expect(row.slug).toBe('road-trip')
    expect(row.$optimistic).toBe('pending')

    release()
    await pending
  })

  it('keeps a create it can’t complete as a pending entry, merged in place by withPending', async () => {
    const { transport, hold } = heldTransport({
      [`GET ${BASE}/playlists`]: {
        data: [playlistObject(PLAYLIST, 'Late Night')],
        meta: { page: { currentPage: 1, perPage: 15, total: 1 } },
      },
      [`POST ${BASE}/playlists`]: { data: playlistObject('p-new', 'Sketch') },
    })
    const client = createClient({ baseUrl: BASE, transport })
    const qc = jsonApiQueryClient()
    const reads = createQueryApi(client)
    const writes = createMutationApi(qc, client, resourceMap)
    const list = reads.playlists.list()
    await qc.fetchQuery(list)
    const warn = vi.spyOn(console, 'warn')

    // No `complete`: the row can't promise a `slug`, so the list keeps it as a pending entry.
    const create = writes.playlists.create({ optimistic: { into: () => 'start' } })
    const release = hold(`POST ${BASE}/playlists`)
    const pending = qc
      .getMutationCache()
      .build(qc, create as never)
      .execute({ title: 'Sketch', public: false })
    const playlists = qc.getQueryData(list.queryKey)!
    expect(playlists.map((p) => p.title)).toEqual(['Late Night'])
    expect(playlists.$pending?.()).toEqual([
      expect.objectContaining({
        type: 'playlists',
        at: 'start',
        input: { title: 'Sketch', public: false },
      }),
    ])
    // The list's total counts it, and withPending puts a placeholder where `into` placed it.
    expect(playlists.$page.meta?.total).toBe(2)
    const rows = withPending(playlists, (entry) => ({ skeleton: entry.input['title'] }))
    expect(rows).toEqual([{ skeleton: 'Sketch' }, playlists[0]])
    // It was placed, as a pending entry, so nothing warns.
    expect(warn).not.toHaveBeenCalled()

    release()
    await pending
    warn.mockRestore()
  })

  it('keeps the prediction when a read lands while the write is pending, and rolls back to that read', async () => {
    let title = 'OK Computer'
    const { transport, hold } = heldTransport({ [`PATCH ${BASE}/albums/1`]: 'fail' })
    const reading: typeof transport = async (req) =>
      req.method === 'GET'
        ? {
            status: 200,
            headers: {},
            body: JSON.stringify({ data: albumObject('1', title) }),
          }
        : transport(req)
    const client = createClient({ baseUrl: BASE, transport: reading })
    const qc = jsonApiQueryClient()
    const reads = createQueryApi(client)
    const writes = createMutationApi(qc, client, resourceMap)
    const get = reads.albums.get('1')
    await qc.fetchQuery(get)

    const release = hold(`PATCH ${BASE}/albums/1`)
    const rename = qc
      .getMutationCache()
      .build(qc, writes.albums.id('1').update({ optimistic: true }) as never)
      .execute({ title: 'Predicted' })
    // Someone else renames the album, and a refetch lands before the write answers.
    title = 'Renamed elsewhere'
    await qc.fetchQuery({ ...get, staleTime: 0 })
    expect(qc.getQueryData(get.queryKey)!.title).toBe('Predicted')

    release()
    await expect(rename).rejects.toBeDefined()
    expect(qc.getQueryData(get.queryKey)!.title).toBe('Renamed elsewhere')
  })

  it('gives a custom action the same lifecycle with jsonApiMutationOptions', async () => {
    const { transport } = heldTransport({
      [`GET ${BASE}/albums/1`]: { data: albumObject('1', 'OK Computer') },
      [`POST ${BASE}/albums/1/-actions/reissue`]: album('1', {
        title: 'OK Computer',
        status: 'released',
      }),
    })
    const client = createClient({ baseUrl: BASE, transport })
    const qc = jsonApiQueryClient()
    const reads = createQueryApi(client)
    const get = reads.albums.get('1')
    await qc.fetchQuery(get)

    const reissue = jsonApiMutationOptions({
      descriptor: resourceMap,
      mutationFn: (albumId: string) =>
        client.albums.id(albumId).actions.reissue({ releasedAt: '2001-10-01T00:00:00+00:00' }),
      optimistic: (draft, albumId) => draft.patch('albums', albumId, { status: 'released' }),
      invalidates: (albumId) => [resourceKey('albums', albumId)],
    })
    await qc.getMutationCache().build(qc, reissue).execute('1')
    expect(qc.getQueryState(get.queryKey)?.isInvalidated).toBe(true)
  })
})

describe('opt-in validation (ajv)', () => {
  it('validates every wire resource against its per-type schema, off by default until you opt in', async () => {
    // The bundle emits JSON Schema 2020-12, so use `Ajv2020`. `strict: false` tolerates the
    // schemas' `x-enum-*` annotations; `validateFormats: false` skips advisory format checks; the
    // client's posture is to validate structure + types. `createAjvValidator` turns the ajv
    // instance + the generated `schemas` map into the `validate?` seam.
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
    const { transport } = mockTransport({
      [`${BASE}/albums/1?include=artist%2Ctracks`]: fixture('album-compound.json'),
    })
    const client = createClient({
      baseUrl: BASE,
      transport,
      validate: createAjvValidator(ajv, schemas),
    })

    // The well-formed compound document passes validation (album + artist + 2 tracks) and
    // materialises normally.
    const ok = await client.albums.get('1', { include: ['artist', 'tracks'] })
    expect(ok.title).toBe('OK Computer')
  })

  it('rejects a malformed resource at the seam (a wrong-typed attribute)', async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
    const { transport } = mockTransport({
      // `averageRating` must be number|null per the schema; a string violates it.
      [`${BASE}/albums/1`]: {
        data: {
          type: 'albums',
          id: '1',
          attributes: { title: 'OK Computer', averageRating: 'nine' },
        },
      },
    })
    const client = createClient({
      baseUrl: BASE,
      transport,
      validate: createAjvValidator(ajv, schemas),
    })

    await expect(client.albums.get('1')).rejects.toThrow(/schema validation/)
  })
})
