import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import { JsonApiError } from './errors'
import type { TransportRequest, TransportResponse } from './transport'
import { ATOMIC_EXT } from './types'

const BASE = 'https://music.example'

// A descriptor with an atomic-capable surface (the `atomic` option, not a per-type field).
const descriptor = {
  albums: {
    attributes: {},
    relations: {
      artist: { cardinality: 'one', types: ['artists'], pivot: false },
      tracks: { cardinality: 'many', types: ['tracks'], pivot: false },
      // A to-many self-relation: lets a test wire an `albums` create handle into a to-many slot.
      related: { cardinality: 'many', types: ['albums'], pivot: false },
      // Members can be added but not removed or replaced.
      editions: {
        cardinality: 'many',
        types: ['albums'],
        pivot: false,
        mutations: { add: true },
      },
      // A relationship whose writes are suppressed.
      label: { cardinality: 'one', types: ['artists'], pivot: false, mutations: {} },
    },
    paths: { create: '/albums', update: '/albums/{id}', delete: '/albums/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
  tracks: {
    attributes: {},
    relations: { album: { cardinality: 'one', types: ['albums'], pivot: false } },
    paths: { create: '/tracks', update: '/tracks/{id}', delete: '/tracks/{id}' },
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
} as const satisfies ApiDescriptor

// Records every request and replies with a caller-supplied response (default: an empty
// atomic-results body). The recorded request carries the serialised body for assertions.
function atomicTransport(reply?: (req: TransportRequest) => TransportResponse): {
  transport: (req: TransportRequest) => Promise<TransportResponse>
  requests: TransportRequest[]
} {
  const requests: TransportRequest[] = []
  return {
    requests,
    transport: async (req) => {
      requests.push(req)
      return reply
        ? reply(req)
        : { status: 200, headers: {}, body: JSON.stringify({ 'atomic:results': [] }) }
    },
  }
}

const bodyOf = (req: TransportRequest): Record<string, unknown> =>
  JSON.parse(req.body ?? '{}') as Record<string, unknown>

describe('client.atomic — request shape', () => {
  it('POSTs the operations array to the atomic endpoint with the ext media type', async () => {
    const { transport, requests } = atomicTransport()
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })

    await client.atomic((tx) => {
      tx.create({ type: 'albums', title: 'Kid A', artist: { type: 'artists', id: '1' } })
      tx.update({ type: 'tracks', id: '5', title: 'Idioteque' })
      tx.delete({ type: 'tracks', id: '9' })
    })

    const req = requests[0]!
    expect(req.method).toBe('POST')
    expect(req.url).toBe(`${BASE}/operations`)
    // Both Content-Type and Accept carry the atomic ext media type.
    expect(req.headers['Content-Type']).toBe(`application/vnd.api+json; ext="${ATOMIC_EXT}"`)
    expect(req.headers['Accept']).toBe(`application/vnd.api+json; ext="${ATOMIC_EXT}"`)

    expect(bodyOf(req)).toEqual({
      'atomic:operations': [
        {
          op: 'add',
          data: {
            type: 'albums',
            lid: 'atomic-0',
            attributes: { title: 'Kid A' },
            relationships: { artist: { data: { type: 'artists', id: '1' } } },
          },
        },
        {
          op: 'update',
          ref: { type: 'tracks', id: '5' },
          data: { type: 'tracks', id: '5', attributes: { title: 'Idioteque' } },
        },
        { op: 'remove', ref: { type: 'tracks', id: '9' } },
      ],
    })
  })

  it('wires a just-created resource into a later op via its lid-bearing handle', async () => {
    const { transport, requests } = atomicTransport()
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })

    await client.atomic((tx) => {
      const album = tx.create({ type: 'albums', title: 'Kid A' })
      // The handle doubles as a `{ type, lid }` relationship ref for a later op.
      tx.create({ type: 'tracks', title: 'Everything In Its Right Place', album })
    })

    const ops = bodyOf(requests[0]!)['atomic:operations'] as Record<string, unknown>[]
    expect((ops[0]!['data'] as Record<string, unknown>)['lid']).toBe('atomic-0')
    const trackData = ops[1]!['data'] as Record<string, unknown>
    expect(trackData['lid']).toBe('atomic-1')
    // The track's `album` relationship references the album's lid, not an id.
    expect(trackData['relationships']).toEqual({
      album: { data: { type: 'albums', lid: 'atomic-0' } },
    })
  })

  it('targets a same-batch resource by lid for update and delete', async () => {
    const { transport, requests } = atomicTransport()
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })

    await client.atomic((tx) => {
      const album = tx.create({ type: 'albums', title: 'Kid A' })
      // Update the just-created album (no server id yet) by its lid...
      tx.update({ type: 'albums', lid: album.lid, title: 'Amnesiac' })
      // ...and remove a same-batch track by lid.
      tx.delete({ type: 'albums', lid: album.lid })
    })

    const ops = bodyOf(requests[0]!)['atomic:operations'] as Record<string, unknown>[]
    // The update op references the lid in both its ref and its data (never a server id).
    expect(ops[1]).toEqual({
      op: 'update',
      ref: { type: 'albums', lid: 'atomic-0' },
      data: { type: 'albums', lid: 'atomic-0', attributes: { title: 'Amnesiac' } },
    })
    // The remove op references the lid in its ref.
    expect(ops[2]).toEqual({ op: 'remove', ref: { type: 'albums', lid: 'atomic-0' } })
  })

  it('a create handle is itself a usable {type,lid} ref (spread into another op)', async () => {
    const { transport, requests } = atomicTransport()
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })

    await client.atomic((tx) => {
      const artistRef: { type: 'artists'; id: string } = { type: 'artists', id: '1' }
      const album = tx.create({ type: 'albums', title: 'Amnesiac', artist: artistRef })
      expect(album).toMatchObject({ type: 'albums', lid: 'atomic-0', opIndex: 0 })
      // The handle spreads into a to-many slot (the `related` self-relation) by its `{type,lid}`.
      tx.update({ type: 'albums', id: '3', title: 'Sequel', related: [album] })
    })

    const ops = bodyOf(requests[0]!)['atomic:operations'] as Record<string, unknown>[]
    const updateRels = (ops[1]!['data'] as Record<string, unknown>)['relationships']
    expect(updateRels).toEqual({ related: { data: [{ type: 'albums', lid: 'atomic-0' }] } })
  })
})

describe('client.atomic — results', () => {
  it('materialises each result positionally', async () => {
    const { transport } = atomicTransport(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        'atomic:results': [
          { data: { type: 'albums', id: '10', attributes: { title: 'Kid A' } } },
          { data: { type: 'tracks', id: '5', attributes: { title: 'Idioteque' } } },
          {}, // a remove yields no data
        ],
      }),
    }))
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })

    const results = await client.atomic((tx) => {
      tx.create({ type: 'albums', title: 'Kid A' })
      tx.update({ type: 'tracks', id: '5', title: 'Idioteque' })
      tx.delete({ type: 'tracks', id: '9' })
    })

    expect(results).toHaveLength(3)
    const album = results[0]!.data as Record<string, unknown>
    expect(album['type']).toBe('albums')
    expect(album['id']).toBe('10')
    expect(album['title']).toBe('Kid A')
    const track = results[1]!.data as Record<string, unknown>
    expect(track['id']).toBe('5')
    // The remove op's result carries no data.
    expect(results[2]!.data).toBeUndefined()
  })

  it('carries a result-level meta through', async () => {
    const { transport } = atomicTransport(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        'atomic:results': [
          { data: { type: 'albums', id: '10', attributes: {} }, meta: { lid: 'atomic-0' } },
        ],
      }),
    }))
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })

    const results = await client.atomic((tx) => {
      tx.create({ type: 'albums', title: 'Kid A' })
    })
    expect(results[0]!.meta).toEqual({ lid: 'atomic-0' })
  })

  it('resolves to an empty array for an all-204 (no results) batch', async () => {
    const { transport } = atomicTransport(() => ({ status: 204, headers: {}, body: '' }))
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })

    const results = await client.atomic((tx) => {
      tx.delete({ type: 'tracks', id: '9' })
    })
    expect(results).toEqual([])
  })
})

describe('client.atomic — typed-tuple results (returned handles)', () => {
  // The server replies with three positional results (the op order); the callback returns a
  // tuple of handles selecting them. Each returned handle resolves to its result by `opIndex`.
  const threeResults = () =>
    atomicTransport(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        'atomic:results': [
          { data: { type: 'albums', id: '10', attributes: { title: 'Kid A' } } },
          { data: { type: 'tracks', id: '5', attributes: { title: 'Idioteque' } } },
          {}, // the remove op carries no data
        ],
      }),
    }))

  it('returns a result per returned handle, resolved by opIndex (delete -> undefined)', async () => {
    const { transport } = threeResults()
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })

    const [album, track, gone] = await client.atomic((tx) => [
      tx.create({ type: 'albums', title: 'Kid A' }),
      tx.update({ type: 'tracks', id: '5', title: 'Idioteque' }),
      tx.delete({ type: 'tracks', id: '9' }),
    ])

    expect(album.data.type).toBe('albums')
    expect(album.data.id).toBe('10')
    expect(album.data.title).toBe('Kid A')
    expect(track.data.type).toBe('tracks')
    expect(track.data.id).toBe('5')
    // The delete handle resolves to `undefined` (no data), not the empty result entry.
    expect(gone).toBeUndefined()
  })

  it('is sound when the returned tuple REORDERS the recorded ops (by-opIndex, not by return order)', async () => {
    const { transport } = threeResults()
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })

    // Record album (op 0), track (op 1), delete (op 2) — but RETURN them in a different order.
    const [returnedTrack, returnedAlbum] = await client.atomic((tx) => {
      const album = tx.create({ type: 'albums', title: 'Kid A' })
      const track = tx.update({ type: 'tracks', id: '5', title: 'Idioteque' })
      tx.delete({ type: 'tracks', id: '9' })
      return [track, album] as const
    })

    // Each handle pulled its OWN positional result regardless of return order.
    expect(returnedTrack.data.type).toBe('tracks')
    expect(returnedTrack.data.id).toBe('5')
    expect(returnedAlbum.data.type).toBe('albums')
    expect(returnedAlbum.data.id).toBe('10')
  })

  it('returns a subset of results when the callback returns only some handles', async () => {
    const { transport } = threeResults()
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })

    // Record all three ops (so the wire batch is unchanged) but return only the track handle.
    const [onlyTrack] = await client.atomic((tx) => {
      tx.create({ type: 'albums', title: 'Kid A' })
      const track = tx.update({ type: 'tracks', id: '5', title: 'Idioteque' })
      tx.delete({ type: 'tracks', id: '9' })
      return [track] as const
    })
    expect(onlyTrack.data.type).toBe('tracks')
    expect(onlyTrack.data.id).toBe('5')
  })

  it('carries result-level meta onto a returned handle', async () => {
    const { transport } = atomicTransport(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        'atomic:results': [
          { data: { type: 'albums', id: '10', attributes: {} }, meta: { lid: 'atomic-0' } },
        ],
      }),
    }))
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })

    const [album] = await client.atomic((tx) => [tx.create({ type: 'albums', title: 'Kid A' })])
    expect(album.meta).toEqual({ lid: 'atomic-0' })
  })

  it('still posts the same wire batch under the typed-tuple form', async () => {
    const { transport, requests } = threeResults()
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })

    await client.atomic((tx) => [
      tx.create({ type: 'albums', title: 'Kid A' }),
      tx.update({ type: 'tracks', id: '5', title: 'Idioteque' }),
      tx.delete({ type: 'tracks', id: '9' }),
    ])

    expect(bodyOf(requests[0]!)).toEqual({
      'atomic:operations': [
        { op: 'add', data: { type: 'albums', lid: 'atomic-0', attributes: { title: 'Kid A' } } },
        {
          op: 'update',
          ref: { type: 'tracks', id: '5' },
          data: { type: 'tracks', id: '5', attributes: { title: 'Idioteque' } },
        },
        { op: 'remove', ref: { type: 'tracks', id: '9' } },
      ],
    })
  })
})

describe('client.atomic — error remapping', () => {
  it('remaps a 422 pointer to (opIndex, flat path)', async () => {
    const { transport } = atomicTransport(() => ({
      status: 422,
      headers: {},
      body: JSON.stringify({
        errors: [
          {
            status: '422',
            detail: 'must not be blank',
            // An atomic pointer carries the op-index prefix.
            source: { pointer: '/atomic:operations/1/data/attributes/title' },
          },
          {
            status: '422',
            detail: 'unknown artist',
            source: { pointer: '/atomic:operations/0/data/relationships/artist/data' },
          },
        ],
      }),
    }))
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })

    const error = (await client
      .atomic((tx) => {
        tx.create({ type: 'albums', title: '', artist: { type: 'artists', id: 'nope' } })
        tx.create({ type: 'albums', title: '' })
      })
      .catch((e: unknown) => e)) as JsonApiError

    expect(error).toBeInstanceOf(JsonApiError)
    expect(error.status).toBe(422)

    // The op index is parsed onto each error and the tail is remapped to the flat path,
    // using THAT op's type to invert (op 0 + op 1 are both `albums` here).
    const titleError = error.errors.find((e) => e.detail === 'must not be blank')!
    expect(titleError.opIndex).toBe(1)
    expect(titleError.path).toBe('title')

    const artistError = error.errors.find((e) => e.detail === 'unknown artist')!
    expect(artistError.opIndex).toBe(0)
    expect(artistError.path).toBe('artist')
  })

  it('passes a non-2xx non-JsonApiError-shaped status through as a JsonApiError', async () => {
    const { transport } = atomicTransport(() => ({ status: 500, headers: {}, body: '' }))
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })

    const error = (await client
      .atomic((tx) => tx.delete({ type: 'tracks', id: '9' }))
      .catch((e: unknown) => e)) as JsonApiError
    expect(error).toBeInstanceOf(JsonApiError)
    expect(error.status).toBe(500)
  })
})

describe('client.atomic — relationship operations', () => {
  const recording = (reply?: (req: TransportRequest) => TransportResponse) => {
    const { transport, requests } = atomicTransport(reply)
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })
    return { client, requests }
  }

  it('records add, remove, replace and set on a relationship, by id or by a same-batch lid', async () => {
    const { client, requests } = recording()
    await client.atomic((tx) => {
      const album = tx.create({ type: 'albums', title: 'Kid A' })
      tx.rel({ type: 'albums', lid: album.lid }, 'tracks').add([{ type: 'tracks', id: '5' }])
      tx.rel({ type: 'albums', id: '1' }, 'tracks').remove([{ type: 'tracks', id: '6' }])
      tx.rel({ type: 'albums', id: '1' }, 'related').replace([album])
      tx.rel({ type: 'tracks', id: '5' }, 'album').set(album)
      tx.rel({ type: 'albums', id: '1' }, 'artist').set(null, { meta: { by: 'desk' } })
    })
    expect(bodyOf(requests[0]!)['atomic:operations']).toEqual([
      { op: 'add', data: { type: 'albums', lid: 'atomic-0', attributes: { title: 'Kid A' } } },
      {
        op: 'add',
        ref: { type: 'albums', lid: 'atomic-0', relationship: 'tracks' },
        data: [{ type: 'tracks', id: '5' }],
      },
      {
        op: 'remove',
        ref: { type: 'albums', id: '1', relationship: 'tracks' },
        data: [{ type: 'tracks', id: '6' }],
      },
      {
        op: 'update',
        ref: { type: 'albums', id: '1', relationship: 'related' },
        data: [{ type: 'albums', lid: 'atomic-0' }],
      },
      {
        op: 'update',
        ref: { type: 'tracks', id: '5', relationship: 'album' },
        data: { type: 'albums', lid: 'atomic-0' },
      },
      {
        op: 'update',
        ref: { type: 'albums', id: '1', relationship: 'artist' },
        data: null,
        meta: { by: 'desk' },
      },
    ])
  })

  it('types each verb by the relation it targets and the verbs it advertises', () => {
    const { client } = recording()
    void client
      .atomic((tx) => {
        // @ts-expect-error -- a to-one takes no add.
        tx.rel({ type: 'albums', id: '1' }, 'artist').add([{ type: 'artists', id: '1' }])
        // @ts-expect-error -- a to-many is replaced, not set.
        tx.rel({ type: 'albums', id: '1' }, 'tracks').set(null)
        // @ts-expect-error -- tracks relate to albums, not artists.
        tx.rel({ type: 'albums', id: '1' }, 'tracks').add([{ type: 'artists', id: '1' }])
        // @ts-expect-error -- albums have no such relation.
        tx.rel({ type: 'albums', id: '1' }, 'covers').remove([])
        tx.rel({ type: 'albums', id: '1' }, 'editions').add([{ type: 'albums', id: '2' }])
        // @ts-expect-error -- editions can't be removed.
        tx.rel({ type: 'albums', id: '1' }, 'editions').remove([])
        // @ts-expect-error -- nor replaced.
        tx.rel({ type: 'albums', id: '1' }, 'editions').replace([])
      })
      .catch(() => undefined)
  })

  it('refuses a relation that takes no verb at the rel call', () => {
    const typed = {
      ...descriptor,
      albums: {
        ...descriptor.albums,
        relations: {
          ...descriptor.albums.relations,
          // A to-many whose relationship writes are suppressed.
          archive: { cardinality: 'many', types: ['tracks'], pivot: false, mutations: {} },
          // A to-many advertising only replace.
          lineup: {
            cardinality: 'many',
            types: ['artists'],
            pivot: false,
            mutations: { replace: true },
          },
          // A to-one advertising only verbs a to-one can't take.
          cover: { cardinality: 'one', types: ['artists'], pivot: false, mutations: { add: true } },
        },
      },
    } as const satisfies ApiDescriptor
    const { transport } = atomicTransport()
    const client = createClient(typed, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })
    void client
      .atomic((tx) => {
        const album = { type: 'albums', id: '1' } as const
        // @ts-expect-error -- the label's relationship takes no write.
        tx.rel(album, 'label')
        // @ts-expect-error -- nor does the archive's.
        tx.rel(album, 'archive')
        // @ts-expect-error -- a to-one takes no add, so the cover takes no verb.
        tx.rel(album, 'cover')
        tx.rel(album, 'artist').set(null)
        tx.rel(album, 'tracks').add([])
        tx.rel(album, 'editions').add([])
        tx.rel(album, 'lineup').replace([])
      })
      .catch(() => undefined)
  })

  it('materialises each relationship result as linkage, typed by the returned handle', async () => {
    const { client } = recording(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        'atomic:results': [
          { data: [{ type: 'tracks', id: '5' }] },
          { data: { type: 'albums', id: '1' } },
          {},
        ],
      }),
    }))
    const [tracks, album, artist] = await client.atomic((tx) => [
      tx.rel({ type: 'albums', id: '1' }, 'tracks').add([{ type: 'tracks', id: '5' }]),
      tx.rel({ type: 'tracks', id: '5' }, 'album').set({ type: 'albums', id: '1' }),
      tx.rel({ type: 'albums', id: '1' }, 'artist').set(null),
    ])
    expect(tracks.data).toEqual([{ type: 'tracks', id: '5' }])
    expect(album.data).toEqual({ type: 'albums', id: '1' })
    expect(artist.data).toBeUndefined()
    expectTypeOf(tracks.data?.[0]?.type).toEqualTypeOf<'tracks' | undefined>()
    expectTypeOf(album.data).toMatchTypeOf<{ type: 'albums'; id: string } | null | undefined>()
  })

  it('remaps a relationship operation’s 422 under its relation', async () => {
    const { client } = recording(() => ({
      status: 422,
      headers: {},
      body: JSON.stringify({
        errors: [
          { status: '422', detail: 'gone', source: { pointer: '/atomic:operations/1/data/0' } },
          { status: '422', detail: 'locked', source: { pointer: '/atomic:operations/2/data' } },
          {
            status: '422',
            detail: 'required',
            source: { pointer: '/atomic:operations/1/meta/changedBy' },
          },
        ],
      }),
    }))
    const error = (await client
      .atomic((tx) => {
        tx.create({ type: 'albums', title: 'Kid A' })
        tx.rel({ type: 'albums', id: '1' }, 'tracks').add([{ type: 'tracks', id: '5' }])
        tx.rel({ type: 'tracks', id: '5' }, 'album').set(null)
      })
      .catch((e: unknown) => e)) as JsonApiError
    expect(error.errors.map(({ opIndex, path }) => ({ opIndex, path }))).toEqual([
      { opIndex: 1, path: 'tracks[0]' },
      { opIndex: 2, path: 'album' },
      // The operation's own meta is grouped as a standalone relationship write's is.
      { opIndex: 1, path: '$documentMeta.changedBy' },
    ])
  })
})

describe('client.atomic — reaching a relationship', () => {
  const recording = () => {
    const { transport, requests } = atomicTransport()
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })
    return { client, requests }
  }

  it('takes a create handle or a materialised resource as the ref', async () => {
    const { client, requests } = recording()
    const track = { type: 'tracks', id: '5', title: 'Idioteque' } as const
    await client.atomic((tx) => {
      const album = tx.create({ type: 'albums' })
      tx.rel(album, 'tracks').add([{ type: 'tracks', id: '5' }])
      tx.rel(track, 'album').set(album)
    })
    expect(bodyOf(requests[0]!)['atomic:operations']).toEqual([
      { op: 'add', data: { type: 'albums', lid: 'atomic-0' } },
      {
        op: 'add',
        ref: { type: 'albums', lid: 'atomic-0', relationship: 'tracks' },
        data: [{ type: 'tracks', id: '5' }],
      },
      {
        op: 'update',
        ref: { type: 'tracks', id: '5', relationship: 'album' },
        data: { type: 'albums', lid: 'atomic-0' },
      },
    ])
  })

  it('records each operation when its verb is called, so one relationship can take several', async () => {
    const { client, requests } = recording()
    const [added, removed] = await client.atomic((tx) => {
      const tracks = tx.rel({ type: 'albums', id: '1' }, 'tracks')
      tx.delete({ type: 'tracks', id: '9' })
      return [
        tracks.add([{ type: 'tracks', id: '5' }]),
        tracks.remove([{ type: 'tracks', id: '6' }]),
      ] as const
    })
    expect(
      (bodyOf(requests[0]!)['atomic:operations'] as { op: string }[]).map(({ op }) => op),
    ).toEqual(['remove', 'add', 'remove'])
    expect(added).toBeUndefined()
    expect(removed).toBeUndefined()
  })

  it('refuses a ref with neither an id nor a lid, and a missing relationship name', async () => {
    const { client } = recording()
    const loose = client as unknown as {
      atomic: (build: (tx: { rel: (ref: unknown, name?: unknown) => unknown }) => void) => unknown
    }
    await expect(loose.atomic((tx) => tx.rel({ type: 'albums' }, 'tracks'))).rejects.toThrow(
      /atomic rel requires an `id` or a `lid`/,
    )
    await expect(loose.atomic((tx) => tx.rel({ type: 'albums', id: '1' }))).rejects.toThrow(
      /atomic rel requires a relationship name/,
    )
  })

  it('takes any meta on a relation declaring none for a batch, whatever its standalone write takes', () => {
    const typed = {
      ...descriptor,
      albums: {
        ...descriptor.albums,
        relations: {
          ...descriptor.albums.relations,
          tags: {
            cardinality: 'many',
            types: ['artists'],
            pivot: false,
            requestMeta: { add: { fields: { reason: 'string' } } },
          },
        },
      },
    } as const satisfies ApiDescriptor
    const { transport } = atomicTransport()
    const client = createClient(typed, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })
    void client
      .atomic((tx) => {
        tx.rel({ type: 'albums', id: '1' }, 'tags').add([])
        tx.rel({ type: 'albums', id: '1' }, 'tags').add([], { meta: { reason: 1, other: true } })
      })
      .catch(() => undefined)
    const tags = client.albums.id('1').tags
    // @ts-expect-error -- the standalone add must still send its reason.
    const standalone = () => tags.add([])
    void standalone
  })
})

describe('client.atomic — capability', () => {
  it('throws when the API exposes no atomic endpoint', () => {
    const { transport } = atomicTransport()
    const client = createClient(descriptor, { baseUrl: BASE, transport })
    // No `atomic` option -> calling `atomic` throws synchronously.
    expect(() => client.atomic(() => {})).toThrow(/Atomic Operations/)
  })

  it('is present on the client surface (has trap) only conceptually — runtime always defined', () => {
    const { transport } = atomicTransport()
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })
    expect(typeof (client as unknown as Record<string, unknown>)['atomic']).toBe('function')
    expect('atomic' in client).toBe(true)
  })
})

describe('client.atomic — a relation rendering its pivot on every member', () => {
  const pivoted = {
    playlists: {
      attributes: {},
      relations: {
        tracks: {
          cardinality: 'many',
          types: ['tracks'],
          pivot: true,
          readPivot: { fields: { addedAt: 'date-time', position: 'integer' } },
          pivotRendered: true,
          writePivot: { fields: { position: 'integer' } },
          mutations: { add: true, remove: true, replace: true },
        },
        owner: {
          cardinality: 'one',
          types: ['tracks'],
          identifierMeta: { fields: { role: 'string' }, additional: false },
          mutations: { set: true },
        },
      },
      paths: { update: '/playlists/{id}' },
      paginator: 'page',
      clientId: 'forbidden',
    },
    tracks: {
      attributes: {},
      relations: {},
      paths: { fetchOne: '/tracks/{id}' },
      paginator: 'page',
      clientId: 'forbidden',
    },
  } as const satisfies ApiDescriptor

  it("types each relationship result as its relation's linkage, the pivot present", async () => {
    const { transport } = atomicTransport(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        'atomic:results': [
          {
            data: [
              {
                type: 'tracks',
                id: '5',
                meta: { pivot: { addedAt: '2026-11-28T09:00:00+00:00', position: 1 } },
              },
            ],
          },
          { data: { type: 'tracks', id: '6', meta: { role: 'curator' } } },
        ],
      }),
    }))
    const client = createClient(pivoted, {
      baseUrl: BASE,
      transport,
      atomic: { path: '/operations' },
    })
    const [added, owner] = await client.atomic((tx) => [
      tx
        .rel({ type: 'playlists', id: 'p1' }, 'tracks')
        .add([{ type: 'tracks', id: '5', $pivot: { position: 1 } }]),
      tx.rel({ type: 'playlists', id: 'p1' }, 'owner').set({ type: 'tracks', id: '6' }),
    ])
    const member = added.data![0]!
    expectTypeOf(member.$pivot.addedAt).toEqualTypeOf<string>()
    expectTypeOf(member.$edge.meta.pivot.position).toEqualTypeOf<number>()
    expect(member.$pivot.addedAt).toBe('2026-11-28T09:00:00+00:00')
    expect(member.$edge.meta.pivot.position).toBe(1)
    expectTypeOf(owner.data).toExtend<{ type: 'tracks' } | null | undefined>()
    expect(owner.data?.$edge?.meta?.role).toBe('curator')
  })
})
