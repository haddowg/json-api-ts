import { describe, expect, it } from 'vitest'
import type { ApiDescriptor } from './descriptor'
import { JsonApiError } from './errors'
import { remapPointer, toDocument, withRemappedPaths } from './serialize-write'

const descriptor = {
  albums: {
    attributes: { title: 'string', releaseInfo: 'object' },
    relations: {
      artist: { cardinality: 'one', types: ['artists'] },
      tracks: { cardinality: 'many', types: ['tracks'] },
    },
    paths: {},
    paginator: 'page',
    clientId: 'forbidden',
  },
  genres: {
    attributes: { name: 'string' },
    relations: {},
    paths: {},
    paginator: 'page',
    clientId: 'required',
  },
  products: {
    attributes: { name: 'string' },
    relations: {},
    paths: {},
    paginator: 'page',
    clientId: 'optional',
  },
  playlists: {
    attributes: { title: 'string' },
    relations: {
      owner: { cardinality: 'one', types: ['users'] },
      orderedTracks: { cardinality: 'many', types: ['tracks'], pivot: true },
    },
    paths: {},
    paginator: 'page',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

describe('toDocument — envelope building', () => {
  it('routes attributes vs relations and always sets data.type', () => {
    const doc = toDocument(descriptor, 'albums', {
      title: 'Kid A',
      releaseInfo: { label: 'Parlophone' },
      artist: { type: 'artists', id: '7' },
    })
    expect(doc).toEqual({
      data: {
        type: 'albums',
        attributes: { title: 'Kid A', releaseInfo: { label: 'Parlophone' } },
        relationships: { artist: { data: { type: 'artists', id: '7' } } },
      },
    })
  })

  it('omits empty attributes/relationships blocks', () => {
    expect(toDocument(descriptor, 'albums', { title: 'OK' })).toEqual({
      data: { type: 'albums', attributes: { title: 'OK' } },
    })
    expect(toDocument(descriptor, 'albums', { artist: null })).toEqual({
      data: { type: 'albums', relationships: { artist: { data: null } } },
    })
  })

  it('accepts a to-one as an identifier, a resource object, or null', () => {
    const fromIdentifier = toDocument(descriptor, 'albums', {
      artist: { type: 'artists', id: '7' },
    })
    expect(fromIdentifier.data.relationships?.['artist']?.data).toEqual({
      type: 'artists',
      id: '7',
    })

    // A materialised resource object carries extra enumerable props; only type/id are extracted.
    const resourceObject = { type: 'artists', id: '7', name: 'Radiohead', slug: 'radiohead' }
    const fromResource = toDocument(descriptor, 'albums', { artist: resourceObject })
    expect(fromResource.data.relationships?.['artist']?.data).toEqual({ type: 'artists', id: '7' })

    const cleared = toDocument(descriptor, 'albums', { artist: null })
    expect(cleared.data.relationships?.['artist']?.data).toBeNull()
  })

  it('accepts a to-many as an array of identifiers / resource objects', () => {
    const doc = toDocument(descriptor, 'albums', {
      tracks: [
        { type: 'tracks', id: '1' },
        { type: 'tracks', id: '2', title: 'Idioteque' },
      ],
    })
    expect(doc.data.relationships?.['tracks']?.data).toEqual([
      { type: 'tracks', id: '1' },
      { type: 'tracks', id: '2' },
    ])
  })

  it('renders a $pivot member as the identifier meta.pivot', () => {
    const doc = toDocument(descriptor, 'playlists', {
      orderedTracks: [
        { type: 'tracks', id: '1', $pivot: { position: 1 } },
        { type: 'tracks', id: '2' },
      ],
    })
    expect(doc.data.relationships?.['orderedTracks']?.data).toEqual([
      { type: 'tracks', id: '1', meta: { pivot: { position: 1 } } },
      { type: 'tracks', id: '2' },
    ])
  })

  it('coerces a single to-many value into a one-element array', () => {
    const doc = toDocument(descriptor, 'albums', { tracks: { type: 'tracks', id: '1' } })
    expect(doc.data.relationships?.['tracks']?.data).toEqual([{ type: 'tracks', id: '1' }])
  })

  it('throws on a linkage value missing type/id', () => {
    expect(() => toDocument(descriptor, 'albums', { artist: { id: '7' } })).toThrow()
    expect(() => toDocument(descriptor, 'albums', { artist: 7 })).toThrow()
  })
})

describe('toDocument — id policy', () => {
  it('omits a client id when forbidden', () => {
    const doc = toDocument(descriptor, 'albums', { id: 'nope', title: 'Amnesiac' })
    expect(doc.data.id).toBeUndefined()
  })

  it('passes a client id through when required', () => {
    const doc = toDocument(descriptor, 'genres', { id: 'rock', name: 'Rock' })
    expect(doc.data.id).toBe('rock')
  })

  it('passes a client id through when optional, omitting it when absent', () => {
    expect(toDocument(descriptor, 'products', { id: 'p1', name: 'Box' }).data.id).toBe('p1')
    expect(toDocument(descriptor, 'products', { name: 'Box' }).data.id).toBeUndefined()
  })

  it('uses the handle id for an update regardless of policy, ignoring input id', () => {
    const doc = toDocument(
      descriptor,
      'albums',
      { id: 'ignored', title: 'Hail to the Thief' },
      {
        id: '42',
      },
    )
    expect(doc.data.id).toBe('42')
  })
})

describe('remapPointer', () => {
  it('remaps an attribute pointer to its flat name', () => {
    expect(remapPointer(descriptor, 'albums', '/data/attributes/title')).toBe('title')
  })

  it('remaps a relationship pointer to the relation name', () => {
    expect(remapPointer(descriptor, 'albums', '/data/relationships/artist/data')).toBe('artist')
  })

  it('remaps a nested-map attribute pointer with dotted children', () => {
    expect(remapPointer(descriptor, 'albums', '/data/attributes/releaseInfo/label')).toBe(
      'releaseInfo.label',
    )
  })

  it('remaps a pivot-array relationship pointer to [n].$pivot.field', () => {
    // Pivot values nest under `meta.pivot` — the exact wire shape from json-api-symfony
    // DoctrinePivotWriteTest (whole-resource write; bundle ADR 0103).
    expect(
      remapPointer(
        descriptor,
        'playlists',
        '/data/relationships/orderedTracks/data/0/meta/pivot/position',
      ),
    ).toBe('orderedTracks[0].$pivot.position')
  })

  it('leaves a non-pivot to-many member meta field as a plain dotted child', () => {
    // `tracks` carries no pivot, so a `meta/<field>` tail is NOT a pivot field.
    expect(remapPointer(descriptor, 'albums', '/data/relationships/tracks/data/0/meta/note')).toBe(
      'tracks[0].meta.note',
    )
  })

  it('remaps a client-id create conflict pointer to the flat id key', () => {
    expect(remapPointer(descriptor, 'genres', '/data/id')).toBe('id')
  })

  it('remaps a to-many member pointer without pivot', () => {
    expect(remapPointer(descriptor, 'albums', '/data/relationships/tracks/data/2')).toBe(
      'tracks[2]',
    )
  })

  it('leaves a query-side / non-write pointer as-is', () => {
    expect(remapPointer(descriptor, 'albums', 'filter[title]')).toBe('filter[title]')
    expect(remapPointer(descriptor, 'albums', '/meta/something')).toBe('/meta/something')
  })
})

describe('withRemappedPaths', () => {
  it('populates path from source.pointer so byPath groups by the flat shape', () => {
    const raw = new JsonApiError(422, [
      { status: '422', source: { pointer: '/data/attributes/title' } },
      { status: '422', source: { pointer: '/data/relationships/artist/data' } },
      { status: '422', source: { pointer: '/data/attributes/releaseInfo/label' } },
    ])

    const remapped = withRemappedPaths(raw, descriptor, 'albums')
    const byPath = remapped.byPath()
    expect(new Set(Object.keys(byPath))).toEqual(new Set(['artist', 'releaseInfo.label', 'title']))
    // The original error is not mutated.
    expect(raw.errors[0]!.path).toBeUndefined()
  })

  it('leaves a query-side error (source.parameter) untouched', () => {
    const raw = new JsonApiError(400, [{ status: '400', source: { parameter: 'filter[x]' } }])
    const remapped = withRemappedPaths(raw, descriptor, 'albums')
    expect(remapped.errors[0]!.path).toBeUndefined()
    expect(remapped.byPath()['filter[x]']).toHaveLength(1)
  })

  it('passes through an error with no source', () => {
    const raw = new JsonApiError(500, [{ status: '500', detail: 'boom' }])
    const remapped = withRemappedPaths(raw, descriptor, 'albums')
    expect(remapped.errors[0]!.path).toBeUndefined()
  })
})
