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
 *   6. bind it to TanStack Query (option factories + write-through normalization);
 *   7. opt into per-field validation with ajv.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { JsonApiError, TransportRequest, TransportResponse } from '@haddowg/json-api-client'
import { createAjvValidator } from '@haddowg/json-api-client/ajv'
import { createMutationApi, createQueryApi, installNormalization } from '@haddowg/json-api-query'
import { QueryClient } from '@tanstack/query-core'
import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
// The generated artifacts — exactly what `json-api-codegen --input … --output … --schemas …`
// writes. `createClient` is the descriptor-bound factory; `resourceMap` is the runtime
// descriptor TanStack normalization needs; `schemas` is the per-type JSON Schema map for ajv;
// `Attributes`/`WriteAttributes`/`ResourceMap` are the generated type maps.
import { createClient, resourceMap } from './generated/music-catalog.gen'
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

describe('reads', () => {
  it('lists a collection with include + sparse fields, typed end to end', async () => {
    const { transport, requests } = mockTransport({
      // The client serialises the flat query into JSON:API bracketed params, deterministically
      // (multi-value families like `fields` join with a `,`, percent-encoded as `%2C`).
      [`${BASE}/albums?filter[status]=released&sort=-releasedAt&include=artist&fields[albums]=title%2Cstatus%2Cartist&page[number]=1`]:
        fixture('albums-collection.json'),
    })
    const client = createClient({ baseUrl: BASE, transport })

    // `include` widens `artist` to a hydrated resource; `fields[albums]` narrows the result to
    // exactly `title`/`status`/`artist` (any other attribute is statically ABSENT from the type).
    // A relation kept in `include` must also be kept in the fieldset to stay on the type.
    const albums = await client.albums.list({
      filter: { status: 'released' },
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
    const { transport } = mockTransport({
      [`${BASE}/albums/1?include=artist%2Ctracks`]: fixture('album-compound.json'),
    })
    const client = createClient({ baseUrl: BASE, transport })

    const ok = await client.albums.get('1', { include: ['artist', 'tracks'] })

    expect(ok.title).toBe('OK Computer')
    // Resource-level envelope accessors hang off the materialised object (non-enumerable).
    expect(ok.$self).toBe(`${BASE}/albums/1`)
    // The to-many `tracks` relation is hydrated to an augmented array of track resources.
    const tracks = ok.tracks as ReadonlyArray<{ title: string }>
    expect(tracks).toHaveLength(3)
    expect(tracks[0]!.title).toBe('Airbag')
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

    // `reissue` is declared `input: document, output: document`: it takes a JSON:API document
    // (typed by the generated `AlbumsReissueInput`) and the response is MATERIALISED into a
    // flattened resource. Resource-scoped actions live under `.id(id).actions`. The generated
    // output type mirrors the wire document; the runtime materialises it, so we read the
    // flattened resource off the result.
    const reissued = (await client.albums.id('1').actions.reissue({
      data: { type: 'albums', attributes: { title: 'OK Computer' } },
    })) as unknown as { id: string; title: string }

    expect(reissued.id).toBe('1')
    expect(reissued.title).toBe('OK Computer')
    expect(requests[0]!.url).toBe(`${BASE}/albums/1/-actions/reissue`)
    expect(requests[0]!.method).toBe('POST')
  })

  it('invokes a collection-scoped action with no input', async () => {
    const { transport, requests } = mockTransport({
      [`POST ${BASE}/albums/-actions/summary`]: album('summary', { title: 'Catalogue summary' }),
    })
    const client = createClient({ baseUrl: BASE, transport })

    // `summary` is collection-scoped (`input: none`), reached off the type accessor's `.actions`.
    // Its document output is likewise materialised at runtime into a flattened resource.
    const summary = (await client.albums.actions.summary()) as unknown as { title: string }
    expect(summary.title).toBe('Catalogue summary')
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
      const newAlbum = tx.create({ type: 'albums', title: 'Geogaddi', artist: newArtist })
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

    // One QueryClient hosts one descriptor. `installNormalization` auto-runs the `type:id`
    // write-through patch on every successful query/mutation — "edit once, updates everywhere".
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
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

    // The well-formed compound document passes validation (album + artist + 3 tracks) and
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
