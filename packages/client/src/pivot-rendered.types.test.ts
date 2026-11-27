import { describe, expectTypeOf, it } from 'vitest'
import type { ApiDescriptor } from './descriptor'
import type { Edge } from './materialise'
import type { Client, ReadResult } from './result-types'

// A descriptor shaped like codegen output for pivot relations whose response linkage renders
// `meta.pivot` on every member: one with no other identifier meta (`tracks`), one declaring
// identifier meta beside its pivot (`tagged`), and one that doesn't say (`legacy`).
const map = {
  playlists: {
    attributes: { title: 'string' },
    relations: {
      tracks: {
        cardinality: 'many',
        types: ['tracks'],
        pivot: true,
        readPivot: { fields: { position: 'integer' } },
        pivotRendered: true,
        writePivot: { fields: { position: 'integer' }, required: [] },
        mutations: { add: true, remove: true, replace: true },
      },
      tagged: {
        cardinality: 'many',
        types: ['tracks'],
        pivot: true,
        readPivot: { fields: { weight: 'integer' } },
        pivotRendered: true,
        identifierMeta: { fields: { addedVia: 'string' }, additional: false },
        mutations: { add: true },
      },
      legacy: {
        cardinality: 'many',
        types: ['tracks'],
        pivot: true,
        readPivot: { fields: { position: 'integer' } },
        mutations: { add: true },
      },
    },
    paths: {
      fetchOne: '/playlists/{id}',
      fetchRelated: '/playlists/{id}/{rel}',
      fetchRelationship: '/playlists/{id}/relationships/{rel}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['tracks', 'tagged', 'legacy'],
  },
  tracks: {
    attributes: { title: 'string' },
    relations: {},
    paths: { fetchOne: '/tracks/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

type Map = typeof map

interface Attributes {
  playlists: { title: string }
  tracks: { title: string }
}

type Playlist = ReadResult<Map, Attributes, 'playlists', [], unknown>
type Included = ReadResult<Map, Attributes, 'playlists', ['tracks', 'tagged'], unknown>
type Handle = ReturnType<Client<Map, Attributes>['playlists']['id']>
type Linkage<R extends 'tracks' | 'tagged' | 'legacy'> = Awaited<
  ReturnType<Handle[R]['get']>
>[number]

describe('a pivot rendered on every linkage member', () => {
  it('types the relationship endpoint member pivot and edge meta as present', () => {
    type Member = Linkage<'tracks'>
    expectTypeOf<Member['$pivot']['position']>().toEqualTypeOf<number>()
    expectTypeOf<Member['$edge']['meta']['pivot']['position']>().toEqualTypeOf<number>()
  })

  it('keeps the pivot required beside declared identifier meta', () => {
    type Meta = Linkage<'tagged'>['$edge']['meta']
    expectTypeOf<Meta['pivot']['weight']>().toEqualTypeOf<number>()
    expectTypeOf<Meta['addedVia']>().toEqualTypeOf<string>()
  })

  it("types the resource's own linkage members as present, included or not", () => {
    expectTypeOf<Playlist['tracks'][number]['$pivot']>().toEqualTypeOf<Record<string, unknown>>()
    type Linked = Playlist['tracks'][number]['$edge']['meta']['pivot']
    expectTypeOf<Linked['position']>().toEqualTypeOf<number>()
    type Hydrated = Included['tagged'][number]['$edge']['meta']['pivot']
    expectTypeOf<Hydrated['weight']>().toEqualTypeOf<number>()
  })

  it('leaves a relation that does not say optional', () => {
    type Member = Linkage<'legacy'>
    expectTypeOf<undefined>().toExtend<Member['$pivot']>()
    expectTypeOf<undefined>().toExtend<Member['$edge']>()
    expectTypeOf<Member['$edge']>().toEqualTypeOf<Edge | undefined>()
  })

  it('keeps the pivot a request sends optional', () => {
    type Add = Parameters<Handle['tracks']['add']>[0][number]
    expectTypeOf<{ type: 'tracks'; id: '1' }>().toExtend<Add>()
  })
})
