import { describe, expectTypeOf, it } from 'vitest'
import type { ApiDescriptor } from './descriptor'
import type {
  Client,
  CreateInput,
  FieldsMap,
  IncludePath,
  ReadResult,
  UpdateInput,
} from './result-types'

// A descriptor shaped like codegen output for generator contract 8: a write-only relation
// (`curator`), a pivot relation with separate response and request shapes (`orderedTracks`), and
// a relation served under a different URI segment (`publisher` at `published-by`).
const map = {
  playlists: {
    attributes: { title: 'string' },
    relations: {
      curator: {
        cardinality: 'one',
        types: ['users'],
        pivot: false,
        writeOnly: true,
        related: false,
        mutations: { set: true },
      },
      contributors: {
        cardinality: 'many',
        types: ['users'],
        pivot: false,
        writeOnly: true,
        related: false,
        mutations: { add: true },
      },
      orderedTracks: {
        cardinality: 'many',
        types: ['tracks'],
        pivot: true,
        readPivot: {
          fields: { addedAt: 'date-time', position: 'integer', weight: 'integer' },
          required: ['addedAt', 'position', 'weight'],
          nullable: ['weight'],
        },
        writePivot: {
          fields: { position: 'integer', weight: 'integer' },
          required: ['position'],
        },
        mutations: { add: true, remove: true, replace: true },
      },
      publisher: {
        cardinality: 'one',
        types: ['users'],
        pivot: false,
        uriField: 'published-by',
        mutations: { set: true },
      },
    },
    paths: {
      create: '/playlists',
      fetchOne: '/playlists/{id}',
      update: '/playlists/{id}',
      fetchRelated: '/playlists/{id}/{rel}',
      fetchRelationship: '/playlists/{id}/relationships/{rel}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['orderedTracks', 'publisher'],
  },
  tracks: {
    attributes: { title: 'string' },
    relations: {},
    paths: { fetchOne: '/tracks/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
  users: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchOne: '/users/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

type Map = typeof map

interface Attributes {
  playlists: { title: string }
  tracks: { title: string }
  users: { name: string }
}

interface WriteAttributes {
  playlists: { create: { title: string }; update: { title?: string } }
}

type Playlist = ReadResult<Map, Attributes, 'playlists', [], unknown>
type Handle = ReturnType<Client<Map, Attributes, WriteAttributes>['playlists']['id']>

describe('write-only relations', () => {
  it('are settable on create and update', () => {
    expectTypeOf<CreateInput<Map, WriteAttributes, 'playlists'>>().toHaveProperty('curator')
    expectTypeOf<UpdateInput<Map, WriteAttributes, 'playlists'>>().toHaveProperty('contributors')
    const create: CreateInput<Map, WriteAttributes, 'playlists'> = {
      title: 'Mix',
      curator: { type: 'users', id: '1' },
      contributors: [{ type: 'users', id: '2' }],
    }
    const update: UpdateInput<Map, WriteAttributes, 'playlists'> = { curator: null }
    void create
    void update
  })

  it('are left out of the read view', () => {
    expectTypeOf<Playlist>().not.toHaveProperty('curator')
    expectTypeOf<Playlist>().not.toHaveProperty('contributors')
    expectTypeOf<Playlist>().toHaveProperty('orderedTracks')
  })

  it('are neither includable nor selectable in fields', () => {
    expectTypeOf<'curator'>().not.toMatchTypeOf<IncludePath<Map, 'playlists'>>()
    expectTypeOf<'curator'>().not.toMatchTypeOf<NonNullable<FieldsMap<Map>['playlists']>[number]>()
    expectTypeOf<'publisher'>().toMatchTypeOf<NonNullable<FieldsMap<Map>['playlists']>[number]>()
  })

  it('keep their mutations but lose the relationship reads', () => {
    expectTypeOf<Handle['curator']['get']>().toBeNever()
    expectTypeOf<Handle['curator']['related']>().toBeNever()
    expectTypeOf<Handle['curator']['set']>().toBeFunction()
    expectTypeOf<Handle['contributors']['add']>().toBeFunction()
  })
})

describe('pivot shapes', () => {
  it('types a response pivot from readPivot, nullable fields included', () => {
    type Related = Awaited<ReturnType<Handle['orderedTracks']['related']>>
    type Pivot = NonNullable<Related[number]['$pivot']>
    expectTypeOf<Pivot['position']>().toEqualTypeOf<number>()
    expectTypeOf<Pivot['weight']>().toEqualTypeOf<number | null>()
    expectTypeOf<Pivot['addedAt']>().toEqualTypeOf<string>()
  })

  it('types a request pivot from writePivot, which needs no read-only field', () => {
    type AddRef = Parameters<Handle['orderedTracks']['add']>[0][number]
    type Pivot = NonNullable<AddRef['$pivot']>
    expectTypeOf<Pivot['position']>().toEqualTypeOf<number>()
    const add: Parameters<Handle['orderedTracks']['add']>[0] = [
      { type: 'tracks', id: '1', $pivot: { position: 1 } },
    ]
    const missing: Parameters<Handle['orderedTracks']['add']>[0] = [
      // @ts-expect-error position is required on a request pivot
      { type: 'tracks', id: '1', $pivot: { weight: 2 } },
    ]
    void add
    void missing
  })

  it('types create and update pivots from writePivot', () => {
    const create: CreateInput<Map, WriteAttributes, 'playlists'> = {
      title: 'Mix',
      orderedTracks: [{ type: 'tracks', id: '1', $pivot: { position: 1, weight: 3 } }],
    }
    const update: UpdateInput<Map, WriteAttributes, 'playlists'> = {
      // @ts-expect-error weight is an integer on a request pivot
      orderedTracks: [{ type: 'tracks', id: '1', $pivot: { position: 1, weight: 'x' } }],
    }
    void create
    void update
  })
})
