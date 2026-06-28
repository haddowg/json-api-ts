import { describe, expectTypeOf, it } from 'vitest'
import type { ApiDescriptor } from './descriptor'
import type {
  Client,
  Collection,
  IdentifierMember,
  ReadResult,
  ResourceObjectView,
} from './result-types'

// A representative descriptor mirroring the generated music-catalog `resourceMap` shape
// (the literal `as const` the codegen emits). `satisfies` keeps the literal types.
const resourceMap = {
  albums: {
    attributes: { title: 'string', status: 'string' },
    relations: {
      artist: { cardinality: 'one', types: ['artists'], pivot: false },
      tracks: { cardinality: 'many', types: ['tracks'], pivot: false },
    },
    paths: {},
    paginator: 'page',
    clientId: 'forbidden',
  },
  artists: {
    attributes: { name: 'string' },
    relations: { albums: { cardinality: 'many', types: ['albums'], pivot: false } },
    paths: {},
    paginator: 'page',
    clientId: 'forbidden',
  },
  tracks: {
    attributes: { title: 'string' },
    relations: { album: { cardinality: 'one', types: ['albums'], pivot: false } },
    paths: {},
    paginator: 'page',
    clientId: 'forbidden',
  },
  favorites: {
    attributes: {},
    relations: {
      // polymorphic to-one
      favoritable: { cardinality: 'one', types: ['tracks', 'albums', 'artists'], pivot: false },
    },
    paths: {},
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

type Map = typeof resourceMap

// The generated `Attributes` map: wire type -> precise per-type interface (with a real
// enum union for `status`, as the codegen emits `status: AlbumStatus`).
type AlbumStatus = 'upcoming' | 'released' | 'withdrawn'
interface AlbumsAttributes {
  title: string
  status: AlbumStatus
}
interface ArtistsAttributes {
  name: string
}
interface TracksAttributes {
  title: string
}
interface Attributes {
  albums: AlbumsAttributes
  artists: ArtistsAttributes
  tracks: TracksAttributes
  favorites: Record<string, never>
}

describe('attribute typing', () => {
  it('flattens precise attribute types onto the resource object', () => {
    type Album = ResourceObjectView<Map, Attributes, 'albums'>
    expectTypeOf<Album['type']>().toEqualTypeOf<'albums'>()
    expectTypeOf<Album['id']>().toEqualTypeOf<string>()
    expectTypeOf<Album['title']>().toEqualTypeOf<string>()
    expectTypeOf<Album['status']>().toEqualTypeOf<AlbumStatus>()
  })

  it('exposes the resource-level $-accessors', () => {
    type Album = ResourceObjectView<Map, Attributes, 'albums'>
    expectTypeOf<Album['$self']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Album>().toHaveProperty('$meta')
    expectTypeOf<Album>().toHaveProperty('$document')
    expectTypeOf<Album>().toHaveProperty('$rel')
    expectTypeOf<Album['$rel']>().toBeFunction()
  })
})

describe('cardinality typing', () => {
  it('types a to-many relation as a Collection regardless of include', () => {
    type Album = ResourceObjectView<Map, Attributes, 'albums'>
    expectTypeOf<Album['tracks']>().toMatchTypeOf<Collection<unknown>>()
  })

  it('types an excluded to-one relation as identifier | null | undefined', () => {
    type Album = ResourceObjectView<Map, Attributes, 'albums'>
    expectTypeOf<Album['artist']>().toEqualTypeOf<IdentifierMember<'artists'> | null | undefined>()
  })
})

describe('include-driven narrowing', () => {
  it('hydrates an included to-one relation to the related resource (has name)', () => {
    type WithArtist = ReadResult<Map, Attributes, 'albums', ['artist']>
    // An included to-one is the hydrated resource OR `null` (empty to-one).
    expectTypeOf<Extract<WithArtist['artist'], null>>().toEqualTypeOf<null>()
    // The hydrated artist carries the related type's attributes...
    expectTypeOf<NonNullable<WithArtist['artist']>['name']>().toEqualTypeOf<string>()
    expectTypeOf<NonNullable<WithArtist['artist']>['type']>().toEqualTypeOf<'artists'>()
    // ...and its per-edge accessors.
    expectTypeOf<NonNullable<WithArtist['artist']>>().toHaveProperty('$edge')
    expectTypeOf<NonNullable<WithArtist['artist']>>().toHaveProperty('$pivot')
  })

  it('leaves an un-included to-one relation as an identifier (no name field)', () => {
    type NoInclude = ReadResult<Map, Attributes, 'albums', []>
    expectTypeOf<NoInclude['artist']>().toEqualTypeOf<
      IdentifierMember<'artists'> | null | undefined
    >()
    // @ts-expect-error — the identifier carries no related attributes.
    type _ = NonNullable<NoInclude['artist']>['name']
  })

  it('hydrates an included to-many relation to a Collection of related resources', () => {
    type WithTracks = ReadResult<Map, Attributes, 'albums', ['tracks']>
    expectTypeOf<WithTracks['tracks'][number]['title']>().toEqualTypeOf<string>()
    expectTypeOf<WithTracks['tracks'][number]['type']>().toEqualTypeOf<'tracks'>()
  })

  it('narrows on the head of a dotted include path', () => {
    type WithArtist = ReadResult<Map, Attributes, 'albums', ['artist.albums']>
    expectTypeOf<NonNullable<WithArtist['artist']>['name']>().toEqualTypeOf<string>()
  })

  it('distributes a polymorphic to-one over its related types when included', () => {
    type WithFavoritable = ReadResult<Map, Attributes, 'favorites', ['favoritable']>
    // The union member discriminates on `type` (an empty to-one is `null`).
    expectTypeOf<NonNullable<WithFavoritable['favoritable']>['type']>().toEqualTypeOf<
      'tracks' | 'albums' | 'artists'
    >()
  })

  it('distributes a polymorphic to-one identifier when not included', () => {
    type NoInclude = ReadResult<Map, Attributes, 'favorites', []>
    expectTypeOf<NoInclude['favoritable']>().toEqualTypeOf<
      | IdentifierMember<'tracks'>
      | IdentifierMember<'albums'>
      | IdentifierMember<'artists'>
      | null
      | undefined
    >()
  })
})

describe('Collection augmented-array typing', () => {
  it('is a read-only array carrying the relationship-level envelope', () => {
    type Tracks = Collection<ResourceObjectView<Map, Attributes, 'tracks'>>
    expectTypeOf<Tracks>().toMatchTypeOf<ReadonlyArray<unknown>>()
    expectTypeOf<Tracks>().toHaveProperty('$page')
    expectTypeOf<Tracks>().toHaveProperty('$next')
    expectTypeOf<Tracks['$next']>().returns.resolves.toEqualTypeOf<Tracks | undefined>()
  })
})

describe('Client surface', () => {
  it('exposes a typed accessor per wire type', () => {
    type C = Client<Map, Attributes>
    expectTypeOf<C>().toHaveProperty('albums')
    expectTypeOf<C>().toHaveProperty('favorites')
    expectTypeOf<C['albums']['id']>().toBeFunction()
    expectTypeOf<C['albums']['list']>().toBeFunction()
    expectTypeOf<C['albums']['get']>().toBeFunction()
  })

  // These probe call-site generic inference (the `include` tuple drives narrowing), so
  // they exercise a real call expression — type-checked by tsc, never executed at runtime.
  it('a list with include narrows the element relations', () => {
    expectTypeOf(narrowsListInclude).returns.resolves.toHaveProperty('$page')
  })

  it('a handle .get with include narrows the result', () => {
    expectTypeOf(narrowsHandleGetInclude).returns.resolves.toHaveProperty('$self')
  })

  it('falls back to open attributes when no Attributes map is supplied', () => {
    type C = Client<Map>
    // Without the generated map, attributes are an open record (still type-checks).
    type Album = Awaited<ReturnType<C['albums']['get']>>
    expectTypeOf<Album['type']>().toEqualTypeOf<'albums'>()
    expectTypeOf<Album>().toHaveProperty('id')
  })
})

describe('ResourceHandle relationship accessors', () => {
  it('exposes a relationship accessor per declared relation, plus get/rel', () => {
    type Handle = ReturnType<Client<Map, Attributes>['albums']['id']>
    expectTypeOf<Handle>().toHaveProperty('get')
    expectTypeOf<Handle>().toHaveProperty('rel')
    expectTypeOf<Handle>().toHaveProperty('artist')
    expectTypeOf<Handle>().toHaveProperty('tracks')
    expectTypeOf<Handle['artist']>().toHaveProperty('get')
    expectTypeOf<Handle['artist']>().toHaveProperty('related')
  })

  it('types a to-one .related() as the hydrated member | null', () => {
    type Handle = ReturnType<Client<Map, Attributes>['albums']['id']>
    type Related = Awaited<ReturnType<Handle['artist']['related']>>
    // null is a member of the union (empty to-one), and the non-null member is hydrated.
    expectTypeOf<Extract<Related, null>>().toEqualTypeOf<null>()
    expectTypeOf<NonNullable<Related>['name']>().toEqualTypeOf<string>()
    expectTypeOf<NonNullable<Related>['type']>().toEqualTypeOf<'artists'>()
  })

  it('types a to-many .related() as a Collection of hydrated members', () => {
    type Handle = ReturnType<Client<Map, Attributes>['albums']['id']>
    type Related = Awaited<ReturnType<Handle['tracks']['related']>>
    expectTypeOf<Related>().toMatchTypeOf<ReadonlyArray<unknown>>()
    expectTypeOf<Related[number]['title']>().toEqualTypeOf<string>()
  })

  it('types a to-many .get() as a Collection of identifier members', () => {
    type Handle = ReturnType<Client<Map, Attributes>['albums']['id']>
    type Linkage = Awaited<ReturnType<Handle['tracks']['get']>>
    expectTypeOf<Linkage>().toMatchTypeOf<ReadonlyArray<unknown>>()
    expectTypeOf<Linkage[number]['type']>().toEqualTypeOf<'tracks'>()
    // @ts-expect-error — a linkage member carries no related attributes.
    type _ = Linkage[number]['title']
  })

  it('.rel(name) yields the same accessor as the named property', () => {
    type Handle = ReturnType<Client<Map, Attributes>['albums']['id']>
    type ViaRel = ReturnType<Handle['rel']>
    // The universal fallback returns the union of the type's relationship accessors,
    // which includes the named accessor's shape.
    expectTypeOf<Handle['tracks']>().toMatchTypeOf<ViaRel>()
  })
})

// Call-site narrowing probes: real call expressions whose inferred return types are
// asserted by tsc. Declared (never invoked at runtime) — the type assertions are the test.
declare const client: Client<Map, Attributes>

async function narrowsListInclude() {
  const albums = await client.albums.list({ include: ['artist'] })
  // The included `artist` is hydrated to the related resource (carries `name`); an empty
  // to-one is `null`, so narrow before reading attributes.
  const artist = albums[0]!.artist
  if (artist !== null) {
    expectTypeOf(artist.name).toEqualTypeOf<string>()
    expectTypeOf(artist.type).toEqualTypeOf<'artists'>()
  }
  return albums
}

async function narrowsHandleGetInclude() {
  const album = await client.albums.id('1').get({ include: ['tracks'] })
  // The included to-many `tracks` is a Collection of hydrated tracks (carry `title`).
  expectTypeOf(album.tracks[0]!.title).toEqualTypeOf<string>()
  expectTypeOf(album.tracks).toHaveProperty('$page')
  return album
}
