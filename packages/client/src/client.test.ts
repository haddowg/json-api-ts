import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
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
    attributes: {},
    relations: {
      artist: { cardinality: 'one', types: ['artists'], pivot: false },
      tracks: { cardinality: 'many', types: ['tracks'], pivot: false },
    },
    paths: {
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
      fetchRelationship: '/albums/{id}/relationships/{rel}',
    },
    paginator: 'page',
    clientId: 'optional',
  },
  tracks: {
    attributes: {},
    relations: { album: { cardinality: 'one', types: ['albums'], pivot: false } },
    paths: { fetchMany: '/tracks', fetchOne: '/tracks/{id}' },
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
    },
    paths: {
      fetchOne: '/playlists/{id}',
      fetchRelated: '/playlists/{id}/{rel}',
      fetchRelationship: '/playlists/{id}/relationships/{rel}',
    },
    paginator: 'page',
    clientId: 'optional',
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
