import { describe, expectTypeOf, it } from 'vitest'
import type { ApiDescriptor } from './descriptor'
import type { Client, ReadResult } from './result-types'

// A descriptor shaped like codegen output for relations declaring identifier meta members: a
// to-one (`owner`), a pivot to-many carrying both (`tracks`), a polymorphic to-many
// (`attachments`) and a plain to-many declaring none (`followers`).
const map = {
  playlists: {
    attributes: { title: 'string' },
    relations: {
      owner: {
        cardinality: 'one',
        types: ['users'],
        pivot: false,
        identifierMeta: {
          fields: { primary: 'boolean', role: 'string' },
          nullable: ['primary'],
        },
        mutations: { set: true },
      },
      tracks: {
        cardinality: 'many',
        types: ['tracks'],
        pivot: true,
        readPivot: { fields: { position: 'integer' } },
        identifierMeta: { fields: { addedVia: 'string' }, required: [] },
        mutations: { add: true, remove: true, replace: true },
      },
      attachments: {
        cardinality: 'many',
        types: ['tracks', 'users'],
        polymorphic: true,
        pivot: false,
        identifierMeta: { fields: { order: 'integer' } },
      },
      followers: { cardinality: 'many', types: ['users'], pivot: false },
    },
    paths: {
      fetchOne: '/playlists/{id}',
      fetchRelated: '/playlists/{id}/{rel}',
      fetchRelationship: '/playlists/{id}/relationships/{rel}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['owner', 'tracks', 'attachments', 'followers'],
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

type Playlist = ReadResult<Map, Attributes, 'playlists', [], unknown>
type Included = ReadResult<Map, Attributes, 'playlists', ['owner', 'tracks'], unknown>
type Handle = ReturnType<Client<Map, Attributes>['playlists']['id']>

describe('declared identifier meta', () => {
  it("types a linkage member's edge meta on the resource's relations", () => {
    type Meta = NonNullable<NonNullable<NonNullable<Playlist['owner']>['$edge']>['meta']>
    expectTypeOf<Meta['role']>().toEqualTypeOf<string>()
    expectTypeOf<Meta['primary']>().toEqualTypeOf<boolean | null>()
    // The record stays open for the related resource's own meta.
    expectTypeOf<Meta['other']>().toEqualTypeOf<unknown>()
  })

  it('types it on included members too', () => {
    type Meta = NonNullable<NonNullable<NonNullable<Included['owner']>['$edge']>['meta']>
    expectTypeOf<Meta['role']>().toEqualTypeOf<string>()
  })

  it('types it beside the pivot on the relationship endpoint', () => {
    type Linkage = Awaited<ReturnType<Handle['tracks']['get']>>
    type Member = Linkage[number]
    type Meta = NonNullable<NonNullable<Member['$edge']>['meta']>
    expectTypeOf<Meta['addedVia']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<NonNullable<Member['$pivot']>['position']>().toEqualTypeOf<number>()
  })

  it('types it on every member of a polymorphic relation', () => {
    type Member = Playlist['attachments'][number]
    type Meta = NonNullable<NonNullable<Member['$edge']>['meta']>
    expectTypeOf<Meta['order']>().toEqualTypeOf<number>()
  })

  it('leaves a relation declaring none open', () => {
    type Meta = NonNullable<NonNullable<Playlist['followers'][number]['$edge']>['meta']>
    expectTypeOf<Meta>().toEqualTypeOf<Record<string, unknown>>()
  })
})
