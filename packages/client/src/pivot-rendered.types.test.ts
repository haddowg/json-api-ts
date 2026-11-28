import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ApiDescriptor } from './descriptor'
import type { Edge } from './materialise'
import type { Client, PendingPivotOf, PivotFieldsOf, ReadResult } from './result-types'

// A descriptor shaped like codegen output for pivot relations whose response linkage renders
// `meta.pivot` on every member: one with no other identifier meta (`tracks`), one declaring
// identifier meta beside its pivot (`tagged`), one whose pivot the server stamps a field of
// (`stamped`), one whose write pivot requires every field the read does (`ranked`), and one that
// doesn't say (`legacy`).
const map = {
  playlists: {
    attributes: { title: 'string' },
    relations: {
      tracks: {
        cardinality: 'many',
        types: ['tracks'],
        pivot: true,
        readPivot: { fields: { note: 'string', position: 'integer' }, required: ['position'] },
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
      stamped: {
        cardinality: 'many',
        types: ['tracks'],
        pivot: true,
        readPivot: {
          fields: { addedAt: 'date-time', position: 'integer', weight: 'integer' },
          nullable: ['weight'],
        },
        pivotRendered: true,
        writePivot: {
          fields: { position: 'integer', weight: 'integer' },
          required: ['position'],
          nullable: ['weight'],
        },
        mutations: { add: true, remove: true },
      },
      ranked: {
        cardinality: 'many',
        types: ['tracks'],
        pivot: true,
        readPivot: { fields: { position: 'integer' } },
        pivotRendered: true,
        writePivot: { fields: { position: 'integer' } },
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
    includable: ['tracks', 'tagged', 'stamped', 'legacy'],
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
type Included = ReadResult<Map, Attributes, 'playlists', ['tracks', 'tagged', 'stamped'], unknown>
type Handle = ReturnType<Client<Map, Attributes>['playlists']['id']>
type Linkage<R extends 'tracks' | 'tagged' | 'stamped' | 'ranked' | 'legacy'> = Awaited<
  ReturnType<Handle[R]['get']>
>[number]
/** A member once no write holds it pending. */
type Confirmed<M> = Exclude<M, { readonly $optimistic: 'pending' }>

describe('a pivot rendered on every linkage member', () => {
  it('types the relationship endpoint member pivot and edge meta as present', () => {
    type Member = Confirmed<Linkage<'tracks'>>
    expectTypeOf<Member['$pivot']['position']>().toEqualTypeOf<number>()
    expectTypeOf<Member['$edge']['meta']['pivot']['position']>().toEqualTypeOf<number>()
  })

  it('keeps the pivot required beside declared identifier meta', () => {
    type Meta = Confirmed<Linkage<'tagged'>>['$edge']['meta']
    expectTypeOf<Meta['pivot']['weight']>().toEqualTypeOf<number>()
    expectTypeOf<Meta['addedVia']>().toEqualTypeOf<string>()
  })

  it("types the resource's own linkage members as present, included or not", () => {
    type Track = Confirmed<Playlist['tracks'][number]>
    expectTypeOf<Track['$pivot']['position']>().toEqualTypeOf<number>()
    type Linked = Track['$edge']['meta']['pivot']
    expectTypeOf<Linked['position']>().toEqualTypeOf<number>()
    type Hydrated = Confirmed<Included['tagged'][number]>['$edge']['meta']['pivot']
    expectTypeOf<Hydrated['weight']>().toEqualTypeOf<number>()
  })

  it("types the resource's own slot pivot from the relation's pivot fields", () => {
    type Pivot = Confirmed<Playlist['tracks'][number]>['$pivot']
    expectTypeOf<Pivot['position']>().toEqualTypeOf<number>()
    expectTypeOf<Pivot['note']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<{ readonly position: 1 }>().toExtend<Pivot>()
    expectTypeOf<{ readonly note: 'x' }>().not.toExtend<Pivot>()
    type Track = Confirmed<Included['tracks'][number]>
    expectTypeOf<Track['$pivot']['position']>().toEqualTypeOf<number>()
    type Tagged = Confirmed<Included['tagged'][number]>
    expectTypeOf<Tagged['$pivot']['weight']>().toEqualTypeOf<number>()
    type Unmarked = NonNullable<Playlist['legacy'][number]['$pivot']>
    expectTypeOf<Unmarked['position']>().toEqualTypeOf<number>()
    expectTypeOf<undefined>().toExtend<Playlist['legacy'][number]['$pivot']>()
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

/** Reads a pending and a confirmed member of the resource's own slot. */
const linked = (member: Playlist['stamped'][number]) => {
  if (member.$optimistic === 'pending') {
    expectTypeOf(member.$pivot.addedAt).toEqualTypeOf<string | undefined>()
    expectTypeOf(member.$edge.meta.pivot.addedAt).toEqualTypeOf<string | undefined>()
  } else {
    expectTypeOf(member.$pivot.addedAt).toEqualTypeOf<string>()
    expectTypeOf(member.$edge.meta.pivot.addedAt).toEqualTypeOf<string>()
  }
}
/** Reads a pending and a confirmed member of an included slot. */
const included = (member: Included['stamped'][number]) => {
  expectTypeOf(member.title).toEqualTypeOf<string>()
  if (member.$optimistic === 'pending') {
    expectTypeOf(member.$pivot.addedAt).toEqualTypeOf<string | undefined>()
    expectTypeOf(member.$pivot.position).toEqualTypeOf<number>()
  } else {
    expectTypeOf(member.$pivot.addedAt).toEqualTypeOf<string>()
  }
}

/** Reads a member whose write pivot requires nothing, pending and confirmed. */
const unsent = (member: Linkage<'tracks'>) => {
  if (member.$optimistic === 'pending') {
    expectTypeOf(member.$pivot.position).toEqualTypeOf<number | undefined>()
  } else {
    expectTypeOf(member.$pivot.position).toEqualTypeOf<number>()
  }
}

describe('a pending member of a relation rendering its pivot on every member', () => {
  type Stamped = PivotFieldsOf<Map, 'playlists', 'stamped'>
  type Pending = PendingPivotOf<Map, 'playlists', 'stamped'>

  it('keeps only the fields the write pivot requires, and makes the rest optional', () => {
    expectTypeOf<Pending['addedAt']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Pending['position']>().toEqualTypeOf<number>()
    expectTypeOf<Pending['weight']>().toEqualTypeOf<number | null | undefined>()
    expectTypeOf<{ readonly position: 3; readonly weight: null }>().toExtend<Pending>()
    expectTypeOf<{ readonly position: 3; readonly weight: null }>().not.toExtend<Stamped>()
  })

  it('allows a write-optional field the write left out', () => {
    expectTypeOf<{ readonly position: 3 }>().toExtend<Pending>()
    expectTypeOf<{ readonly weight: 1 }>().not.toExtend<Pending>()
  })

  it('allows an attach that sent no pivot, where the write pivot requires nothing', () => {
    type Sent = PendingPivotOf<Map, 'playlists', 'tracks'>
    expectTypeOf<{}>().toExtend<Sent>()
    expectTypeOf<Sent['position']>().toEqualTypeOf<number | undefined>()
    expect(typeof unsent).toBe('function')
  })

  it('types the relationship endpoint member apart while it is pending', () => {
    type Member = Linkage<'stamped'>
    expectTypeOf<Member['$pivot']['addedAt']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Member['$pivot']['position']>().toEqualTypeOf<number>()
    const check = (member: Member) => {
      if (member.$optimistic === 'pending') {
        expectTypeOf(member.$pivot).toEqualTypeOf<Pending>()
        expectTypeOf(member.$pivot.addedAt).toEqualTypeOf<string | undefined>()
        expectTypeOf(member.$edge.meta.pivot.addedAt).toEqualTypeOf<string | undefined>()
        expectTypeOf(member.$edge.meta.pivot.position).toEqualTypeOf<number>()
      } else {
        expectTypeOf(member.$optimistic).toEqualTypeOf<undefined>()
        expectTypeOf(member.$pivot).toEqualTypeOf<Stamped>()
        expectTypeOf(member.$pivot.addedAt).toEqualTypeOf<string>()
        expectTypeOf(member.$edge.meta.pivot.addedAt).toEqualTypeOf<string>()
      }
    }
    expect(typeof check).toBe('function')
  })

  it("types the resource's own slot apart, included or not", () => {
    expect([typeof linked, typeof included]).toEqual(['function', 'function'])
  })

  it('leaves a member alone where the write pivot requires every field the read requires', () => {
    type Member = Linkage<'ranked'>
    expectTypeOf<Member['$optimistic']>().toEqualTypeOf<'pending' | undefined>()
    expectTypeOf<Member['$pivot']['position']>().toEqualTypeOf<number>()
  })

  it('leaves the related endpoint and an unmarked relation as they were', () => {
    type Related = Awaited<ReturnType<Handle['stamped']['related']>>[number]
    expectTypeOf<NonNullable<Related['$pivot']>['addedAt']>().toEqualTypeOf<string>()
    expectTypeOf<Linkage<'legacy'>['$optimistic']>().toEqualTypeOf<'pending' | undefined>()
  })
})
