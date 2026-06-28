import { describe, expect, it } from 'vitest'
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
      const artistRef = { type: 'artists', id: '1' }
      const album = tx.create({ type: 'albums', title: 'Amnesiac', artist: artistRef })
      expect(album).toMatchObject({ type: 'albums', lid: 'atomic-0', opIndex: 0 })
      tx.update({ type: 'albums', id: '3', title: 'Sequel', tracks: [album] })
    })

    const ops = bodyOf(requests[0]!)['atomic:operations'] as Record<string, unknown>[]
    const updateRels = (ops[1]!['data'] as Record<string, unknown>)['relationships']
    expect(updateRels).toEqual({ tracks: { data: [{ type: 'albums', lid: 'atomic-0' }] } })
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
