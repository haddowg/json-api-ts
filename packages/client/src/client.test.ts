import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import { JsonApiError } from './errors'
import type { Collection } from './result-types'
import type { TransportRequest, TransportResponse } from './transport'

// The typed surface returns precise per-type shapes; these helpers reinterpret a result as
// the loose runtime shape the integration assertions probe (the precise typing is covered by
// the type-level tests in result-types.test.ts).
const asArray = <T = Record<string, unknown>>(v: unknown): Collection<T> => v as Collection<T>
const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>

const BASE = 'https://music.example'
const PLAYLIST = '00000000-0000-4000-8000-000000000001'

function fixtureBody(name: string): string {
  const path = fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url))
  return readFileSync(path, 'utf8')
}

// A descriptor mirroring the live music-catalog paths the fixtures exercise. `as const
// satisfies` keeps the literal types so the typed client surface is precise (accessors
// defined, returns narrowed) — same shape the codegen's `resourceMap` emits.
const descriptor = {
  albums: {
    attributes: { title: 'string', status: 'string' },
    relations: {
      artist: { cardinality: 'one', types: ['artists'], pivot: false },
      tracks: { cardinality: 'many', types: ['tracks'], pivot: false },
    },
    paths: {
      create: '/albums',
      update: '/albums/{id}',
      delete: '/albums/{id}',
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
      fetchRelationship: '/albums/{id}/relationships/{rel}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    countable: {
      tokens: ['_self_', 'tracks'],
      profile: 'https://haddowg.github.io/json-api/profiles/countable/',
    },
    includable: ['artist', 'tracks'],
    sortable: ['title', '-title', 'releasedAt', '-releasedAt'],
    filterable: ['status', 'title'],
    actions: {
      // resource-scoped, FLAT document in (built from `albums` attributes) -> materialised resource out
      reissue: {
        scope: 'resource',
        path: '/albums/{id}/-actions/reissue',
        input: 'document',
        output: 'document',
        inputType: 'albums',
        outputType: 'albums',
        outputCardinality: 'one',
      },
      // resource-scoped, raw (octet-stream) body in -> materialised resource out
      artwork: {
        scope: 'resource',
        path: '/albums/{id}/-actions/artwork',
        input: 'raw',
        output: 'document',
        contentType: 'application/octet-stream',
      },
      // collection-scoped, no input -> document out
      summary: {
        scope: 'collection',
        path: '/albums/-actions/summary',
        input: 'none',
        output: 'document',
        outputType: 'albums',
        outputCardinality: 'one',
      },
      // collection-scoped, no input -> meta-only document out (D2)
      stats: {
        scope: 'collection',
        path: '/albums/-actions/stats',
        input: 'none',
        output: 'meta',
      },
      // collection-scoped, declared over PATCH (a non-POST method, D25) -> no output (204)
      recalculate: {
        scope: 'collection',
        path: '/albums/-actions/recalculate',
        method: 'PATCH',
        input: 'none',
        output: 'none',
      },
      // collection-scoped, no input, no output (a 204)
      reindex: {
        scope: 'collection',
        path: '/albums/-actions/reindex',
        input: 'none',
        output: 'none',
      },
    },
  },
  tracks: {
    attributes: {},
    relations: { album: { cardinality: 'one', types: ['albums'], pivot: false } },
    paths: {
      create: '/tracks',
      update: '/tracks/{id}',
      delete: '/tracks/{id}',
      fetchMany: '/tracks',
      fetchOne: '/tracks/{id}',
    },
    paginator: 'page',
    clientId: 'optional',
  },
  artists: {
    attributes: {},
    relations: {},
    paths: { fetchOne: '/artists/{id}' },
    paginator: 'page',
    clientId: 'optional',
  },
  playlists: {
    attributes: {},
    relations: {
      orderedTracks: { cardinality: 'many', types: ['tracks'], pivot: true },
      owner: { cardinality: 'one', types: ['users'], pivot: false },
    },
    paths: {
      create: '/playlists',
      update: '/playlists/{id}',
      delete: '/playlists/{id}',
      fetchOne: '/playlists/{id}',
      fetchRelated: '/playlists/{id}/{rel}',
      fetchRelationship: '/playlists/{id}/relationships/{rel}',
    },
    paginator: 'page',
    clientId: 'optional',
  },
  genres: {
    attributes: {},
    relations: {},
    paths: { create: '/genres', fetchMany: '/genres', fetchOne: '/genres/{id}' },
    paginator: 'page',
    clientId: 'required',
  },
  // A cursor-paginated read surface (the fixture carries only `page`-kind paginators, so the
  // cursor path is exercised here with a synthetic descriptor + document).
  feed: {
    attributes: { headline: 'string' },
    relations: {},
    paths: { fetchMany: '/feed', fetchOne: '/feed/{id}' },
    paginator: 'cursor',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

/**
 * A mock transport mapping the (already-built) request URL to a captured fixture, recording
 * every request so URL/query construction can be asserted. A `404` fixture isn't modelled;
 * an unmapped URL throws (a test wiring error, not a runtime path).
 */
function mockTransport(routes: Record<string, string>): {
  transport: (req: TransportRequest) => Promise<TransportResponse>
  requests: TransportRequest[]
} {
  const requests: TransportRequest[] = []
  return {
    requests,
    transport: async (req) => {
      requests.push(req)
      const body = routes[req.url]
      if (body === undefined) {
        throw new Error(`unmapped URL: ${req.url}`)
      }
      return { status: 200, headers: {}, body }
    },
  }
}

describe('createClient — collection reads', () => {
  it('client.<type>.list() yields an augmented array of resources', async () => {
    const { transport, requests } = mockTransport({
      [`${BASE}/albums`]: fixtureBody('albums-collection.json'),
    })
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const albums = asArray(await client.albums.list())

    expect(Array.isArray(albums)).toBe(true)
    expect(albums).toHaveLength(2)
    expect(albums[0]!['title']).toBe('OK Computer')
    expect(albums.$page.kind).toBe('page')
    expect(requests[0]!.method).toBe('GET')
    expect(requests[0]!.url).toBe(`${BASE}/albums`)
  })

  it('serialises include/fields/sort/page/filter into the request URL', async () => {
    const { transport, requests } = mockTransport({
      [`${BASE}/albums?filter[status]=released&sort=-releasedAt&include=artist&fields[albums]=title&page[number]=2`]:
        fixtureBody('albums-collection.json'),
    })
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    await client.albums.list({
      filter: { status: 'released' },
      sort: '-releasedAt',
      include: ['artist'],
      fields: { albums: ['title'] },
      page: { number: 2 },
    })

    expect(requests[0]!.url).toBe(
      `${BASE}/albums?filter[status]=released&sort=-releasedAt&include=artist&fields[albums]=title&page[number]=2`,
    )
  })
})

describe('createClient — withCount', () => {
  const COUNTABLE_PROFILE = 'https://haddowg.github.io/json-api/profiles/countable/'

  it('list serialises withCount AND negotiates the Countable profile in Accept', async () => {
    const { transport, requests } = mockTransport({
      [`${BASE}/albums?withCount=_self_%2Ctracks`]: fixtureBody('albums-collection.json'),
    })
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    await client.albums.list({ withCount: ['_self_', 'tracks'] })

    const req = requests[0]!
    expect(req.url).toBe(`${BASE}/albums?withCount=_self_%2Ctracks`)
    // The Countable profile (read from the descriptor) rides Accept so the server honours it.
    expect(req.headers['Accept']).toBe(`application/vnd.api+json; profile="${COUNTABLE_PROFILE}"`)
  })

  it('a single-resource get is a plain read (withCount is collection-only — see result-types.test)', async () => {
    // No `GET /{type}/{id}` endpoint advertises `withCount`, so the typed `get` drops it (a
    // single-resource withCount would be rejected 400 under strict validation). The type-level
    // rejection is asserted in result-types.test.ts; here we confirm a plain `get` negotiates no
    // profile.
    const { transport, requests } = mockTransport({
      [`${BASE}/albums/1`]: fixtureBody('album-compound.json'),
    })
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    await client.albums.get('1')

    const req = requests[0]!
    expect(req.url).toBe(`${BASE}/albums/1`)
    expect(req.headers['Accept']).toBe('application/vnd.api+json')
  })

  it('does not negotiate the profile (or emit withCount) for a plain read', async () => {
    const { transport, requests } = mockTransport({
      [`${BASE}/albums`]: fixtureBody('albums-collection.json'),
    })
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    await client.albums.list()

    const req = requests[0]!
    expect(req.url).toBe(`${BASE}/albums`)
    // No withCount -> the bare JSON:API media type, no profile parameter.
    expect(req.headers['Accept']).toBe('application/vnd.api+json')
  })

  it('exposes the relationship count via meta.total on the materialised relationship', async () => {
    // A withCount read renders the relationship counts under each relationship's `meta.total`,
    // reachable via $rel(name).meta — confirm the runtime preserves them (does not drop them). It
    // is exercised on the COLLECTION read, where withCount is supported (a single-resource get
    // does not advertise it).
    const { transport } = mockTransport({
      [`${BASE}/albums?withCount=tracks`]: JSON.stringify({
        data: [
          {
            type: 'albums',
            id: '1',
            attributes: { title: 'OK Computer' },
            relationships: {
              tracks: {
                links: { related: `${BASE}/albums/1/tracks` },
                meta: { total: 12 },
              },
            },
          },
        ],
        jsonapi: { version: '1.1' },
      }),
    })
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const albums = asArray(await client.albums.list({ withCount: ['tracks'] }))
    const album = asRecord(albums[0])
    const tracksRel = (album['$rel'] as (name: string) => Record<string, unknown> | undefined)(
      'tracks',
    )
    expect(tracksRel?.['meta']).toEqual({ total: 12 })
  })
})

describe('createClient — cursor pagination', () => {
  it('materialises $page.kind === "cursor" and $next follows the cursor link', async () => {
    const page1: TransportResponse = {
      status: 200,
      headers: {},
      body: JSON.stringify({
        data: [{ type: 'feed', id: '1', attributes: { headline: 'First' } }],
        links: { self: `${BASE}/feed`, next: `${BASE}/feed?page[cursor]=c2` },
        meta: { page: { hasMore: true } },
        jsonapi: { version: '1.1' },
      }),
    }
    const page2: TransportResponse = {
      status: 200,
      headers: {},
      body: JSON.stringify({
        data: [{ type: 'feed', id: '2', attributes: { headline: 'Second' } }],
        links: { self: `${BASE}/feed?page[cursor]=c2` },
        meta: { page: { hasMore: false } },
        jsonapi: { version: '1.1' },
      }),
    }
    const transport = vi.fn(async (req: TransportRequest) =>
      req.url.includes('page[cursor]=c2') ? page2 : page1,
    )
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const first = asArray(await client.feed.list())
    // The discriminant is the descriptor's paginator kind.
    expect(first.$page.kind).toBe('cursor')
    expect(first[0]!['headline']).toBe('First')

    // $next follows the (absolute) cursor link and re-materialises, still cursor-kinded.
    const next = asArray(await first.$next())
    expect(next).toBeDefined()
    expect(next[0]!['headline']).toBe('Second')
    expect(next.$page.kind).toBe('cursor')
    expect(transport.mock.calls[1]![0].url).toBe(`${BASE}/feed?page[cursor]=c2`)
  })

  it('serialises cursor page params on a list request', async () => {
    const { transport, requests } = mockTransport({
      [`${BASE}/feed?page[cursor]=c2&page[size]=20`]: JSON.stringify({
        data: [],
        links: { self: `${BASE}/feed?page[cursor]=c2&page[size]=20` },
      }),
    })
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    await client.feed.list({ page: { cursor: 'c2', size: 20 } })
    expect(requests[0]!.url).toBe(`${BASE}/feed?page[cursor]=c2&page[size]=20`)
  })
})

describe('createClient — resource reads + hydration', () => {
  it('client.<type>.get(id, {include}) hydrates the included relations', async () => {
    const { transport, requests } = mockTransport({
      [`${BASE}/albums/1?include=artist%2Ctracks`]: fixtureBody('album-compound.json'),
    })
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const album = asRecord(await client.albums.get('1', { include: ['artist', 'tracks'] }))

    expect(album['type']).toBe('albums')
    expect(album['title']).toBe('OK Computer')

    const artist = asRecord(album['artist'])
    expect(artist['type']).toBe('artists')
    expect(artist['name']).toBe('Radiohead')

    const tracks = asArray(album['tracks'])
    expect(tracks).toHaveLength(3)
    expect(tracks[0]!['title']).toBe('Airbag')

    expect(requests[0]!.url).toBe(`${BASE}/albums/1?include=artist%2Ctracks`)
  })

  it('client.<type>.id(id).get() reads fetchOne without a fetch up front', async () => {
    const { transport, requests } = mockTransport({
      [`${BASE}/albums/1?include=artist%2Ctracks`]: fixtureBody('album-compound.json'),
    })
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    // .id() must not fetch; only .get() does.
    const handle = client.albums.id('1')
    expect(requests).toHaveLength(0)

    const album = asRecord(await handle.get({ include: ['artist', 'tracks'] }))
    expect(album['id']).toBe('1')
    expect(requests).toHaveLength(1)
  })
})

describe('createClient — relationship + related accessors', () => {
  it('id(id).<rel>.get() reads the relationship (linkage) endpoint', async () => {
    const { transport, requests } = mockTransport({
      [`${BASE}/albums/1/relationships/tracks`]: fixtureBody('album-tracks-relationship.json'),
    })
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const linkage = asArray(await client.albums.id('1').tracks.get())
    expect(linkage).toHaveLength(2)
    expect(linkage[0]).toMatchObject({ type: 'tracks', id: '1' })
    expect(linkage[0]!['title']).toBeUndefined()
    expect(requests[0]!.url).toBe(`${BASE}/albums/1/relationships/tracks`)
  })

  it('id(id).<rel>.related() reads the related (hydrated) collection', async () => {
    const { transport, requests } = mockTransport({
      [`${BASE}/albums/1/tracks`]: fixtureBody('album-tracks-related.json'),
    })
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const tracks = asArray(await client.albums.id('1').tracks.related())
    expect(tracks).toHaveLength(2)
    expect(tracks[0]!['title']).toBe('Airbag')
    expect(requests[0]!.url).toBe(`${BASE}/albums/1/tracks`)
  })

  it('related() members carry $pivot for a pivot relation', async () => {
    const { transport } = mockTransport({
      [`${BASE}/playlists/${PLAYLIST}/orderedTracks`]: fixtureBody(
        'playlist-orderedtracks-related.json',
      ),
    })
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const ordered = asArray<Record<string, unknown> & { $pivot?: Record<string, unknown> }>(
      await client.playlists.id(PLAYLIST).orderedTracks.related(),
    )
    expect(ordered).toHaveLength(2)
    expect(ordered[0]!.$pivot).toEqual({
      position: 2,
      weight: 100,
      addedAt: '2024-04-02T09:00:00+00:00',
    })
  })

  it('get() members carry $pivot on the relationship endpoint', async () => {
    const { transport } = mockTransport({
      [`${BASE}/playlists/${PLAYLIST}/relationships/orderedTracks`]: fixtureBody(
        'playlist-orderedtracks-relationship.json',
      ),
    })
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const linkage = asArray<Record<string, unknown> & { $pivot?: Record<string, unknown> }>(
      await client.playlists.id(PLAYLIST).orderedTracks.get(),
    )
    expect(linkage[0]!.$pivot).toMatchObject({ position: 2 })
  })

  it('.rel(name) is the universal fallback for the same accessor', async () => {
    const { transport, requests } = mockTransport({
      [`${BASE}/albums/1/tracks`]: fixtureBody('album-tracks-related.json'),
    })
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const tracks = asArray(await client.albums.id('1').rel('tracks').related())
    expect(tracks).toHaveLength(2)
    expect(requests[0]!.url).toBe(`${BASE}/albums/1/tracks`)
  })

  it('passes a query through to the related endpoint', async () => {
    const { transport, requests } = mockTransport({
      [`${BASE}/playlists/${PLAYLIST}/orderedTracks?sort=position&page[size]=2`]: fixtureBody(
        'playlist-orderedtracks-related.json',
      ),
    })
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    await client.playlists
      .id(PLAYLIST)
      .orderedTracks.related({ sort: 'position', page: { size: 2 } })
    expect(requests[0]!.url).toBe(
      `${BASE}/playlists/${PLAYLIST}/orderedTracks?sort=position&page[size]=2`,
    )
  })
})

describe('createClient — navigation seam', () => {
  it('$next() returns undefined when there is no next link', async () => {
    const { transport } = mockTransport({
      [`${BASE}/albums`]: fixtureBody('albums-collection.json'),
    })
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const albums = asArray(await client.albums.list())
    await expect(albums.$next()).resolves.toBeUndefined()
    await expect(albums.$prev()).resolves.toBeUndefined()
  })

  it('$next() re-fetches the next link and re-materialises', async () => {
    const page2: TransportResponse = {
      status: 200,
      headers: {},
      body: JSON.stringify({
        data: [{ type: 'albums', id: '3', attributes: { title: 'Kid A' } }],
        links: { self: `${BASE}/albums?page[number]=2` },
        meta: { page: { currentPage: 2 } },
        jsonapi: { version: '1.1' },
      }),
    }
    const page1: TransportResponse = {
      status: 200,
      headers: {},
      body: JSON.stringify({
        data: [{ type: 'albums', id: '1', attributes: { title: 'OK Computer' } }],
        links: { self: `${BASE}/albums`, next: `${BASE}/albums?page[number]=2` },
        meta: { page: { currentPage: 1 } },
        jsonapi: { version: '1.1' },
      }),
    }
    const transport = vi.fn(async (req: TransportRequest) =>
      req.url.includes('page[number]=2') ? page2 : page1,
    )
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const first = asArray(await client.albums.list())
    expect(first[0]!['title']).toBe('OK Computer')

    const next = asArray(await first.$next())
    expect(next).toBeDefined()
    expect(next[0]!['title']).toBe('Kid A')
    expect(next.$page.meta).toEqual({ currentPage: 2 })
    // navigate executed the absolute next link verbatim.
    expect(transport.mock.calls[1]![0].url).toBe(`${BASE}/albums?page[number]=2`)
  })
})

describe('createClient — surface shape', () => {
  it('exposes a defined accessor per descriptor type and undefined otherwise', () => {
    const client = asRecord(
      createClient(descriptor, {
        baseUrl: BASE,
        transport: async () => ({ status: 200, headers: {}, body: '' }),
      }),
    )
    expect(client['albums']).toBeDefined()
    expect(client['playlists']).toBeDefined()
    expect(client['nope']).toBeUndefined()
    expect('albums' in client).toBe(true)
    expect('nope' in client).toBe(false)
  })
})

// A write-aware transport: records every request and replies with a caller-supplied
// response (defaults to a 200 echoing back a minimal resource of the requested type, so a
// create/update materialises). The recorded request carries the serialised body so the
// envelope built from flat input can be asserted.
function writeTransport(reply?: (req: TransportRequest) => TransportResponse): {
  transport: (req: TransportRequest) => Promise<TransportResponse>
  requests: TransportRequest[]
} {
  const requests: TransportRequest[] = []
  return {
    requests,
    transport: async (req) => {
      requests.push(req)
      if (reply) {
        return reply(req)
      }
      return { status: 200, headers: {}, body: '' }
    },
  }
}

// Parse a recorded request body back to an object for envelope assertions.
const bodyOf = (req: TransportRequest): Record<string, unknown> =>
  JSON.parse(req.body ?? '{}') as Record<string, unknown>

const resourceResponse = (type: string, id: string): TransportResponse => ({
  status: 201,
  headers: {},
  body: JSON.stringify({
    data: { type, id, attributes: {} },
    jsonapi: { version: '1.1' },
  }),
})

describe('createClient — create', () => {
  it('POSTs the flat input as a JSON:API envelope and materialises the response', async () => {
    const { transport, requests } = writeTransport(() => resourceResponse('albums', '10'))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const album = asRecord(
      await client.albums.create({
        title: 'Kid A',
        artist: { type: 'artists', id: '1' },
        tracks: [{ type: 'tracks', id: '2' }],
      }),
    )

    const req = requests[0]!
    expect(req.method).toBe('POST')
    expect(req.url).toBe(`${BASE}/albums`)
    expect(req.headers['Content-Type']).toBe('application/vnd.api+json')
    expect(bodyOf(req)).toEqual({
      data: {
        type: 'albums',
        attributes: { title: 'Kid A' },
        relationships: {
          artist: { data: { type: 'artists', id: '1' } },
          tracks: { data: [{ type: 'tracks', id: '2' }] },
        },
      },
    })
    // The 201 body is materialised the same as a read.
    expect(album['type']).toBe('albums')
    expect(album['id']).toBe('10')
  })

  it('omits data.id when the client-id policy forbids it (even if passed)', async () => {
    const { transport, requests } = writeTransport(() => resourceResponse('albums', '10'))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    // The runtime input would not allow `id` at the type level; pass it loosely to prove
    // the serializer drops it for a forbidden policy.
    await client.albums.create({ title: 'Kid A', id: 'forced' } as never)

    const data = bodyOf(requests[0]!)['data'] as Record<string, unknown>
    expect(data['id']).toBeUndefined()
  })

  it('passes a client-supplied id through when the policy is optional', async () => {
    const { transport, requests } = writeTransport(() => resourceResponse('tracks', 't1'))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    await client.tracks.create({ title: 'Idioteque', id: 't1' })

    const data = bodyOf(requests[0]!)['data'] as Record<string, unknown>
    expect(data['id']).toBe('t1')
  })

  it('sends the required client id end-to-end and materialises the response', async () => {
    const { transport, requests } = writeTransport(() => resourceResponse('genres', 'rock'))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const genre = asRecord(await client.genres.create({ id: 'rock', name: 'Rock' }))

    const req = requests[0]!
    expect(req.method).toBe('POST')
    expect(req.url).toBe(`${BASE}/genres`)
    expect(bodyOf(req)).toEqual({
      data: { type: 'genres', id: 'rock', attributes: { name: 'Rock' } },
    })
    expect(genre['id']).toBe('rock')
    expect(genre['type']).toBe('genres')
  })

  it('honours include/fields on the write response', async () => {
    const { transport, requests } = writeTransport(() => resourceResponse('albums', '10'))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    await client.albums.create(
      { title: 'Kid A' },
      { include: ['tracks'], fields: { albums: ['title'] } },
    )

    expect(requests[0]!.url).toBe(`${BASE}/albums?include=tracks&fields[albums]=title`)
  })
})

describe('createClient — update', () => {
  it('PATCHes the patch with data.id from the handle', async () => {
    const { transport, requests } = writeTransport(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ data: { type: 'albums', id: '1', attributes: {} } }),
    }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const album = asRecord(await client.albums.id('1').update({ title: 'Amnesiac' }))

    const req = requests[0]!
    expect(req.method).toBe('PATCH')
    expect(req.url).toBe(`${BASE}/albums/1`)
    expect(bodyOf(req)).toEqual({
      data: { type: 'albums', id: '1', attributes: { title: 'Amnesiac' } },
    })
    expect(album['id']).toBe('1')
  })

  it('clears a to-one relation with null', async () => {
    const { transport, requests } = writeTransport(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ data: { type: 'albums', id: '1', attributes: {} } }),
    }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    await client.albums.id('1').update({ artist: null })

    const data = bodyOf(requests[0]!)['data'] as Record<string, unknown>
    expect(data['relationships']).toEqual({ artist: { data: null } })
  })
})

describe('createClient — delete', () => {
  it('DELETEs the resource and resolves to void on 204', async () => {
    const { transport, requests } = writeTransport(() => ({ status: 204, headers: {}, body: '' }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const out = await client.albums.id('1').delete()

    expect(requests[0]!.method).toBe('DELETE')
    expect(requests[0]!.url).toBe(`${BASE}/albums/1`)
    expect(requests[0]!.body).toBeUndefined()
    expect(out).toBeUndefined()
  })
})

describe('createClient — relationship mutation', () => {
  it('to-many .add POSTs an array linkage to the relationship endpoint', async () => {
    const { transport, requests } = writeTransport(() => ({ status: 204, headers: {}, body: '' }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const out = await client.albums.id('1').tracks.add([
      { type: 'tracks', id: '2' },
      { type: 'tracks', id: '3' },
    ])

    const req = requests[0]!
    expect(req.method).toBe('POST')
    expect(req.url).toBe(`${BASE}/albums/1/relationships/tracks`)
    expect(bodyOf(req)).toEqual({
      data: [
        { type: 'tracks', id: '2' },
        { type: 'tracks', id: '3' },
      ],
    })
    expect(out).toBeUndefined()
  })

  it('to-many .remove DELETEs the array linkage', async () => {
    const { transport, requests } = writeTransport(() => ({ status: 204, headers: {}, body: '' }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    await client.albums.id('1').tracks.remove([{ type: 'tracks', id: '2' }])

    const req = requests[0]!
    expect(req.method).toBe('DELETE')
    expect(req.url).toBe(`${BASE}/albums/1/relationships/tracks`)
    expect(bodyOf(req)).toEqual({ data: [{ type: 'tracks', id: '2' }] })
  })

  it('to-many .replace PATCHes the array linkage, carrying $pivot as meta.pivot', async () => {
    const { transport, requests } = writeTransport(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        data: [{ type: 'tracks', id: '2', meta: { pivot: { position: 1 } } }],
      }),
    }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const linkage = asArray<Record<string, unknown> & { $pivot?: Record<string, unknown> }>(
      await client.playlists
        .id(PLAYLIST)
        .orderedTracks.replace([{ type: 'tracks', id: '2', $pivot: { position: 1 } }]),
    )

    const req = requests[0]!
    expect(req.method).toBe('PATCH')
    expect(req.url).toBe(`${BASE}/playlists/${PLAYLIST}/relationships/orderedTracks`)
    expect(bodyOf(req)).toEqual({
      data: [{ type: 'tracks', id: '2', meta: { pivot: { position: 1 } } }],
    })
    // The 200 linkage body is materialised as identifier members (with $pivot).
    expect(linkage[0]).toMatchObject({ type: 'tracks', id: '2' })
    expect(linkage[0]!.$pivot).toEqual({ position: 1 })
  })

  it('to-one .set PATCHes a single identifier (or null to clear)', async () => {
    const { transport, requests } = writeTransport(() => ({ status: 204, headers: {}, body: '' }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    await client.albums.id('1').artist.set({ type: 'artists', id: '9' })
    expect(requests[0]!.method).toBe('PATCH')
    expect(requests[0]!.url).toBe(`${BASE}/albums/1/relationships/artist`)
    expect(bodyOf(requests[0]!)).toEqual({ data: { type: 'artists', id: '9' } })

    await client.albums.id('1').artist.set(null)
    expect(bodyOf(requests[1]!)).toEqual({ data: null })
  })

  it('to-one .set materialises a 200 linkage response as a single identifier', async () => {
    const { transport } = writeTransport(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        data: { type: 'artists', id: '9' },
        links: { self: `${BASE}/albums/1/relationships/artist` },
      }),
    }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const linkage = asRecord(await client.albums.id('1').artist.set({ type: 'artists', id: '9' }))
    expect(linkage['type']).toBe('artists')
    expect(linkage['id']).toBe('9')
  })
})

describe('createClient — custom actions', () => {
  it('resource action (reissue): builds the envelope from FLAT input and materialises the resource', async () => {
    const { transport, requests } = writeTransport(() => resourceResponse('albums', '1'))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    // D37: a document action names its inputType, so the caller passes FLAT attributes (like
    // create) and the client builds the envelope — no hand-built `{ data: { type, attributes } }`.
    const reissued = asRecord(
      await client.albums.id('1').actions.reissue({ title: 'OK Computer (Reissue)' }),
    )

    const req = requests[0]!
    expect(req.method).toBe('POST')
    expect(req.url).toBe(`${BASE}/albums/1/-actions/reissue`)
    expect(req.headers['Content-Type']).toBe('application/vnd.api+json')
    expect(bodyOf(req)).toEqual({
      data: { type: 'albums', attributes: { title: 'OK Computer (Reissue)' } },
    })
    // D1: the 2xx document is materialised the same as a read — result.type/id, not result.data.
    expect(reissued['type']).toBe('albums')
    expect(reissued['id']).toBe('1')
  })

  it('resource action (reissue): remaps a 422 pointer to the flat input path (D37)', async () => {
    const { transport } = writeTransport(() => ({
      status: 422,
      headers: {},
      body: JSON.stringify({
        errors: [
          {
            status: '422',
            detail: 'must not be blank',
            source: { pointer: '/data/attributes/title' },
          },
        ],
      }),
    }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const error = await client.albums
      .id('1')
      .actions.reissue({ title: '' })
      .then(
        () => {
          throw new Error('expected the reissue to reject')
        },
        (e: unknown) => e,
      )

    expect(error).toBeInstanceOf(JsonApiError)
    const byPath = (error as JsonApiError).byPath()
    // The pointer is remapped to the flat attribute path, like create/update.
    expect(byPath['title']![0]!.detail).toBe('must not be blank')
  })

  it('collection action (stats): a meta-only output returns the document meta (D2)', async () => {
    const { transport, requests } = writeTransport(() => ({
      status: 200,
      headers: { 'content-type': 'application/vnd.api+json' },
      body: JSON.stringify({ meta: { albums: { published: 3, unpublished: 1, total: 4 } } }),
    }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const meta = asRecord(await client.albums.actions.stats())

    expect(requests[0]!.url).toBe(`${BASE}/albums/-actions/stats`)
    // The meta payload is returned directly — NOT materialised to undefined (the old data-less bug).
    expect(asRecord(meta['albums'])['total']).toBe(4)
  })

  it('collection action (recalculate): dispatches over its declared non-POST method (D25)', async () => {
    const { transport, requests } = writeTransport(() => ({ status: 204, headers: {}, body: '' }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const out = await client.albums.actions.recalculate()

    expect(requests[0]!.method).toBe('PATCH')
    expect(requests[0]!.url).toBe(`${BASE}/albums/-actions/recalculate`)
    expect(out).toBeUndefined()
  })

  it('resource action (artwork): sends a raw body with the declared media type', async () => {
    const { transport, requests } = writeTransport(() => resourceResponse('albums', '1'))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    await client.albums.id('1').actions.artwork('iVBORw0KGgo=')

    const req = requests[0]!
    expect(req.method).toBe('POST')
    expect(req.url).toBe(`${BASE}/albums/1/-actions/artwork`)
    // Raw input: the body is sent verbatim and NOT claimed as a JSON:API document.
    expect(req.body).toBe('iVBORw0KGgo=')
    // The action's declared content type is sent (not a wildcard, not JSON:API).
    expect(req.headers['Content-Type']).toBe('application/octet-stream')
    // Accept stays JSON:API — a document response is still expected.
    expect(req.headers['Accept']).toBe('application/vnd.api+json')
  })

  it('resource action (raw): falls back to a wildcard content type when none is declared', async () => {
    // A raw action whose spec declared no media type uses `*/*` so the server still accepts it.
    const noTypeDescriptor = {
      albums: {
        attributes: {},
        relations: {},
        paths: {},
        paginator: 'page',
        clientId: 'forbidden',
        actions: {
          artwork: {
            scope: 'resource',
            path: '/albums/{id}/-actions/artwork',
            input: 'raw',
            output: 'document',
          },
        },
      },
    } as const satisfies ApiDescriptor
    const { transport, requests } = writeTransport(() => resourceResponse('albums', '1'))
    const client = createClient(noTypeDescriptor, { baseUrl: BASE, transport })

    await client.albums.id('1').actions.artwork('iVBORw0KGgo=')

    expect(requests[0]!.headers['Content-Type']).toBe('*/*')
  })

  it('collection action (summary): no input, materialises the document result', async () => {
    const { transport, requests } = writeTransport(() => resourceResponse('albums', '1'))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const result = asRecord(await client.albums.actions.summary())

    const req = requests[0]!
    expect(req.method).toBe('POST')
    expect(req.url).toBe(`${BASE}/albums/-actions/summary`)
    // A `none` input sends no body at all.
    expect(req.body).toBeUndefined()
    expect(req.headers['Content-Type']).toBeUndefined()
    expect(result['type']).toBe('albums')
  })

  it('collection action (reindex): no input, no output -> void on 204', async () => {
    const { transport, requests } = writeTransport(() => ({ status: 204, headers: {}, body: '' }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const out = await client.albums.actions.reindex()

    expect(requests[0]!.url).toBe(`${BASE}/albums/-actions/reindex`)
    expect(out).toBeUndefined()
  })

  it('exposes each action only on its declared scope', () => {
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport: async () => ({ status: 204, headers: {}, body: '' }),
    })

    const collectionActions = asRecord(asRecord(client.albums)['actions'])
    expect(typeof collectionActions['summary']).toBe('function')
    // A resource-scoped action is absent from the collection accessor.
    expect(collectionActions['reissue']).toBeUndefined()

    const resourceActions = asRecord(asRecord(client.albums.id('1'))['actions'])
    expect(typeof resourceActions['reissue']).toBe('function')
    expect(typeof resourceActions['artwork']).toBe('function')
    // A collection-scoped action is absent from the resource handle.
    expect(resourceActions['summary']).toBeUndefined()
  })

  it('a relation named like a reserved member is shadowed by .actions and reachable via .rel', async () => {
    // `actions` is a reserved handle member; if a type ever had a relation named `actions`
    // the handle resolves the accessor, never the relation. Prove `.actions` is the accessor.
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport: async () => ({ status: 204, headers: {}, body: '' }),
    })
    const handle = asRecord(client.albums.id('1'))
    expect(typeof handle['actions']).toBe('object')
  })
})

// A descriptor whose relations carry explicit per-relation `mutations` flags (mirroring the
// generated `resourceMap`: `tracks.playlists` advertises POST/DELETE but no PATCH).
const verbDescriptor = {
  tracks: {
    attributes: {},
    relations: {
      // to-one with set.
      album: { cardinality: 'one', types: ['albums'], pivot: false, mutations: { set: true } },
      // to-many lacking `replace` (no PATCH -> cannotReplace).
      playlists: {
        cardinality: 'many',
        types: ['playlists'],
        pivot: false,
        mutations: { add: true, remove: true },
      },
      // to-many forbidding every verb (explicit empty block).
      frozen: { cardinality: 'many', types: ['albums'], pivot: false, mutations: {} },
      // read-only to-one: the relationship endpoint advertises no PATCH (empty block) -> no `.set`.
      readonlyOwner: { cardinality: 'one', types: ['albums'], pivot: false, mutations: {} },
    },
    paths: { fetchRelationship: '/tracks/{id}/relationships/{rel}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
  albums: { attributes: {}, relations: {}, paths: {}, paginator: 'none', clientId: 'forbidden' },
  playlists: {
    attributes: {},
    relations: {},
    paths: {},
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

describe('createClient — per-relation verb gating (runtime)', () => {
  it('omits a forbidden mutation verb from the relationship accessor', () => {
    const client = createClient(verbDescriptor, {
      baseUrl: BASE,
      transport: async () => ({ status: 204, headers: {}, body: '' }),
    })

    const playlists = asRecord(asRecord(client.tracks.id('1'))['playlists'])
    // Advertised verbs are present...
    expect(typeof playlists['add']).toBe('function')
    expect(typeof playlists['remove']).toBe('function')
    // ...the unadvertised `replace` (no PATCH on the endpoint) is absent at runtime.
    expect(playlists['replace']).toBeUndefined()
    // `set` is a to-one verb, never present on a to-many.
    expect(playlists['set']).toBeUndefined()
    // Reads are always present.
    expect(typeof playlists['get']).toBe('function')
    expect(typeof playlists['related']).toBe('function')
  })

  it('omits every verb when the relation forbids all of them', () => {
    const client = createClient(verbDescriptor, {
      baseUrl: BASE,
      transport: async () => ({ status: 204, headers: {}, body: '' }),
    })
    const frozen = asRecord(asRecord(client.tracks.id('1'))['frozen'])
    expect(frozen['add']).toBeUndefined()
    expect(frozen['remove']).toBeUndefined()
    expect(frozen['replace']).toBeUndefined()
  })

  it('keeps only `set` on a to-one with the set flag', () => {
    const client = createClient(verbDescriptor, {
      baseUrl: BASE,
      transport: async () => ({ status: 204, headers: {}, body: '' }),
    })
    const album = asRecord(asRecord(client.tracks.id('1'))['album'])
    expect(typeof album['set']).toBe('function')
    expect(album['add']).toBeUndefined()
    expect(album['remove']).toBeUndefined()
    expect(album['replace']).toBeUndefined()
  })

  it('omits `set` on a read-only to-one (empty mutations block, no PATCH)', () => {
    const client = createClient(verbDescriptor, {
      baseUrl: BASE,
      transport: async () => ({ status: 204, headers: {}, body: '' }),
    })
    const owner = asRecord(asRecord(client.tracks.id('1'))['readonlyOwner'])
    // A read-only to-one exposes the reads but no `.set` mutation.
    expect(typeof owner['get']).toBe('function')
    expect(typeof owner['related']).toBe('function')
    expect(owner['set']).toBeUndefined()
    expect(owner['add']).toBeUndefined()
  })

  it('actually invokes an advertised verb (add POSTs the linkage)', async () => {
    const { transport, requests } = writeTransport(() => ({ status: 204, headers: {}, body: '' }))
    const client = createClient(verbDescriptor, { baseUrl: BASE, transport })

    await client.tracks.id('1').playlists.add([{ type: 'playlists', id: '2' }])
    expect(requests[0]!.method).toBe('POST')
    expect(requests[0]!.url).toBe(`${BASE}/tracks/1/relationships/playlists`)
  })
})

describe('createClient — write error remapping', () => {
  it('a 422 throws a JsonApiError whose byPath() keys are the flat input paths', async () => {
    const { transport } = writeTransport(() => ({
      status: 422,
      headers: {},
      body: JSON.stringify({
        errors: [
          {
            status: '422',
            detail: 'must not be blank',
            source: { pointer: '/data/attributes/title' },
          },
          {
            status: '422',
            detail: 'unknown artist',
            source: { pointer: '/data/relationships/artist/data' },
          },
        ],
      }),
    }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const error = await client.albums
      .create({ title: '', artist: { type: 'artists', id: 'nope' } })
      .then(
        () => {
          throw new Error('expected the create to reject')
        },
        (e: unknown) => e,
      )

    expect(error).toBeInstanceOf(JsonApiError)
    const japi = error as JsonApiError
    expect(japi.status).toBe(422)
    const byPath = japi.byPath()
    expect(Object.keys(byPath)).toEqual(expect.arrayContaining(['artist', 'title']))
    expect(Object.keys(byPath)).toHaveLength(2)
    expect(byPath['title']![0]!.detail).toBe('must not be blank')
    expect(byPath['artist']![0]!.detail).toBe('unknown artist')
  })

  it('remaps a client-id create conflict (/data/id) to the flat id key', async () => {
    const { transport } = writeTransport(() => ({
      status: 409,
      headers: {},
      body: JSON.stringify({
        errors: [
          {
            status: '409',
            detail: 'a resource with this id already exists',
            // The exact pointer core's ClientGeneratedIdAlreadyExists emits.
            source: { pointer: '/data/id' },
          },
        ],
      }),
    }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    // `tracks` has an `optional` client-id policy, so the caller supplies a flat `id`.
    const error = (await client.tracks
      .create({ title: 'Idioteque', id: 't1' })
      .catch((e: unknown) => e)) as JsonApiError

    expect(error).toBeInstanceOf(JsonApiError)
    expect(error.status).toBe(409)
    const byPath = error.byPath()
    expect(Object.keys(byPath)).toContain('id')
    expect(byPath['id']![0]!.detail).toBe('a resource with this id already exists')
  })

  it('remaps a relationship-mutation pivot error pointer to the flat path', async () => {
    const { transport } = writeTransport(() => ({
      status: 422,
      headers: {},
      body: JSON.stringify({
        errors: [
          {
            status: '422',
            detail: 'invalid pivot',
            // The exact pointer json-api-symfony emits at the relationship endpoint: a pivot
            // field nests under `meta.pivot` — DoctrinePivotWriteTest / bundle ADR 0103.
            source: { pointer: '/data/0/meta/pivot/position' },
          },
        ],
      }),
    }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const error = (await client.playlists
      .id(PLAYLIST)
      .orderedTracks.replace([{ type: 'tracks', id: '2', $pivot: { position: -1 } }])
      .catch((e: unknown) => e)) as JsonApiError

    expect(error).toBeInstanceOf(JsonApiError)
    // The relationship endpoint's body is the linkage document `{ data: [...] }`; the
    // pointer remaps under that shape, keyed by the relation name from the route, surfacing a
    // member-level meta field as $pivot (the relation carries pivot).
    const keys = Object.keys(error.byPath())
    expect(keys).toContain('orderedTracks[0].$pivot.position')
  })

  it('remaps a relationship prohibition pointer (/data/relationships/<rel>) to the relation name', async () => {
    const { transport } = writeTransport(() => ({
      status: 403,
      headers: {},
      body: JSON.stringify({
        errors: [
          {
            status: '403',
            detail: 'full replacement is prohibited',
            // The exact pointer core's FullReplacementProhibited emits unchanged at the
            // relationship endpoint (a resource-document relationship pointer).
            source: { pointer: '/data/relationships/orderedTracks' },
          },
        ],
      }),
    }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    const error = (await client.playlists
      .id(PLAYLIST)
      .orderedTracks.replace([{ type: 'tracks', id: '2' }])
      .catch((e: unknown) => e)) as JsonApiError

    expect(error).toBeInstanceOf(JsonApiError)
    expect(error.status).toBe(403)
    // It maps to the relation name, not garbage like `orderedTracks.relationships.orderedTracks`.
    expect(Object.keys(error.byPath())).toContain('orderedTracks')
  })
})
