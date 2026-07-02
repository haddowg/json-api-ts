import { describe, expectTypeOf, it } from 'vitest'
import type { AtomicCreateHandle, AtomicDeleteHandle, AtomicUpdateHandle } from './atomic'
import type { ApiDescriptor } from './descriptor'
import type {
  AtomicResultOf,
  Client,
  Collection,
  CountToken,
  CreateInput,
  IdentifierMember,
  LinkageRef,
  ReadResult,
  ResourceObjectView,
  UpdateInput,
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
    // The COLLECTION count tokens, mirroring the wire (`GET /albums` advertises only `tracks`;
    // `_self_` is a related/relationship-endpoint token, not a collection one).
    countable: {
      tokens: ['tracks'],
      profile: 'https://haddowg.github.io/json-api/profiles/countable/',
    },
    // The advertised query capabilities (the include/sort/filter enums the wire exposes).
    includable: ['artist', 'tracks', 'artist.albums', 'tracks.album'],
    sortable: ['title', '-title', 'status', '-status'],
    filterable: ['status', 'title'],
  },
  artists: {
    attributes: { name: 'string' },
    relations: { albums: { cardinality: 'many', types: ['albums'], pivot: false } },
    paths: {},
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['albums'],
    sortable: ['name', '-name'],
    filterable: ['name'],
  },
  tracks: {
    attributes: { title: 'string' },
    relations: { album: { cardinality: 'one', types: ['albums'], pivot: false } },
    paths: {},
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['album', 'album.artist'],
    sortable: ['title', '-title'],
    filterable: ['title'],
  },
  // `favorites` advertises an includable polymorphic relation but NO sort and NO filter — it
  // exercises the "sorting/filtering unsupported" branch (`sort`/`filter` are then `never`).
  favorites: {
    attributes: {},
    relations: {
      // polymorphic to-one
      favoritable: { cardinality: 'one', types: ['tracks', 'albums', 'artists'], pivot: false },
    },
    paths: {},
    paginator: 'none',
    clientId: 'forbidden',
    includable: ['favoritable'],
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

  it('hydrates EVERY head when a tuple mixes a plain relation and a dotted path', () => {
    // Regression: a distributive template-literal `infer` collapses the union to a single head
    // when the tuple mixes dotted + plain members, dropping a relation from the narrowed set.
    // `['artist', 'tracks.album']` must hydrate BOTH `artist` (to-one) and `tracks` (to-many).
    type Both = ReadResult<Map, Attributes, 'albums', ['artist', 'tracks.album']>
    expectTypeOf<NonNullable<Both['artist']>['name']>().toEqualTypeOf<string>()
    expectTypeOf<Both['tracks'][number]['title']>().toEqualTypeOf<string>()
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

describe('sparse-fieldset return-type narrowing', () => {
  it('keeps every attribute when no fieldset is supplied', () => {
    type Album = ReadResult<Map, Attributes, 'albums'>
    expectTypeOf<Album['title']>().toEqualTypeOf<string>()
    expectTypeOf<Album['status']>().toEqualTypeOf<AlbumStatus>()
  })

  it('narrows attributes to the requested fieldset (unrequested ones are ABSENT)', () => {
    // `fields: { albums: ['title'] }` -> only `title` (plus type/id/$accessors); `status` is gone.
    type Album = ReadResult<Map, Attributes, 'albums', [], { albums: ['title'] }>
    expectTypeOf<Album['title']>().toEqualTypeOf<string>()
    expectTypeOf<Album['type']>().toEqualTypeOf<'albums'>()
    expectTypeOf<Album['id']>().toEqualTypeOf<string>()
    // The unrequested attribute is statically absent — reading it is a compile error.
    // @ts-expect-error — `status` was not in the fieldset.
    type _ = Album['status']
    // The resource-level accessors are always present (never narrowed away).
    expectTypeOf<Album>().toHaveProperty('$self')
  })

  it('narrows relations too (a relation absent from the fieldset is dropped)', () => {
    // Selecting only `title` drops the relation slots `artist`/`tracks`.
    type Album = ReadResult<Map, Attributes, 'albums', [], { albums: ['title'] }>
    // @ts-expect-error — `tracks` (a relation) is not in the fieldset.
    type _t = Album['tracks']
    // @ts-expect-error — `artist` (a relation) is not in the fieldset.
    type _a = Album['artist']

    // Selecting only the relation keeps the relation but drops the attributes.
    type RelOnly = ReadResult<Map, Attributes, 'albums', ['artist'], { albums: ['artist'] }>
    expectTypeOf<NonNullable<RelOnly['artist']>['type']>().toEqualTypeOf<'artists'>()
    // @ts-expect-error — `title` is not in the fieldset.
    type _x = RelOnly['title']
  })

  it('narrows the included member by its own type fieldset', () => {
    // include the to-one artist but request only `name` on artists.
    type Album = ReadResult<Map, Attributes, 'albums', ['artist'], { artists: ['name'] }>
    expectTypeOf<NonNullable<Album['artist']>['name']>().toEqualTypeOf<string>()
    // The album's own attributes are untouched (no `albums` entry in the fieldset).
    expectTypeOf<Album['title']>().toEqualTypeOf<string>()
  })
})

describe('withCount token typing', () => {
  it('resolves the count-token union from the countable descriptor', () => {
    expectTypeOf<CountToken<Map, 'albums'>>().toEqualTypeOf<'tracks'>()
  })

  it('is never for a type with no countable block', () => {
    expectTypeOf<CountToken<Map, 'tracks'>>().toBeNever()
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

  it('.rel(name) yields a relationship accessor exposing the read + write surface', () => {
    type Handle = ReturnType<Client<Map, Attributes>['albums']['id']>
    type ViaRel = ReturnType<Handle['rel']>
    expectTypeOf<ViaRel>().toHaveProperty('get')
    expectTypeOf<ViaRel>().toHaveProperty('related')
    expectTypeOf<ViaRel>().toHaveProperty('add')
    expectTypeOf<ViaRel>().toHaveProperty('set')
  })

  it('exposes cardinality-gated mutation methods on a relationship accessor', () => {
    type Handle = ReturnType<Client<Map, Attributes, never>['albums']['id']>
    // to-many `tracks` (no `mutations` block -> cardinality fallback): add/remove/replace
    // callable, set never.
    expectTypeOf<Handle['tracks']['add']>().toBeFunction()
    expectTypeOf<Handle['tracks']['remove']>().toBeFunction()
    expectTypeOf<Handle['tracks']['replace']>().toBeFunction()
    expectTypeOf<Handle['tracks']['set']>().toBeNever()
    // to-one `artist`: set is callable, add/remove/replace are never.
    expectTypeOf<Handle['artist']['set']>().toBeFunction()
    expectTypeOf<Handle['artist']['add']>().toBeNever()
    expectTypeOf<Handle['artist']['remove']>().toBeNever()
    expectTypeOf<Handle['artist']['replace']>().toBeNever()
  })
})

// A descriptor whose relations carry explicit per-relation `mutations` flags — mirroring
// the generated `resourceMap` (where `tracks.playlists` advertises POST/DELETE but no PATCH).
const verbMap = {
  tracks: {
    attributes: { title: 'string' },
    relations: {
      // to-many with all three verbs.
      album: { cardinality: 'one', types: ['albums'], pivot: false, mutations: { set: true } },
      // to-many lacking `replace` (no PATCH on the relationship endpoint -> cannotReplace).
      playlists: {
        cardinality: 'many',
        types: ['playlists'],
        pivot: false,
        mutations: { add: true, remove: true },
      },
      // to-many that forbids EVERY verb (explicit empty mutations block).
      frozen: { cardinality: 'many', types: ['albums'], pivot: false, mutations: {} },
      // read-only to-one: the relationship endpoint advertises no PATCH (empty mutations) ->
      // `.set` must be gated off.
      readonlyOwner: {
        cardinality: 'one',
        types: ['albums'],
        pivot: false,
        mutations: {},
      },
    },
    paths: {},
    paginator: 'page',
    clientId: 'forbidden',
  },
  albums: {
    attributes: { title: 'string' },
    relations: {
      // to-many with the full verb set.
      tracks: {
        cardinality: 'many',
        types: ['tracks'],
        pivot: false,
        mutations: { add: true, remove: true, replace: true },
      },
    },
    paths: {},
    paginator: 'page',
    clientId: 'forbidden',
  },
  playlists: {
    attributes: {},
    relations: {},
    paths: {},
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

type VerbMap = typeof verbMap

describe('per-relation mutation-verb gating', () => {
  it('keeps all three verbs on a fully-mutable to-many', () => {
    type Handle = ReturnType<Client<VerbMap, Attributes, never>['albums']['id']>
    expectTypeOf<Handle['tracks']['add']>().toBeFunction()
    expectTypeOf<Handle['tracks']['remove']>().toBeFunction()
    expectTypeOf<Handle['tracks']['replace']>().toBeFunction()
    expectTypeOf<Handle['tracks']['set']>().toBeNever()
  })

  it('gates `replace` to never on a to-many whose endpoint lacks PATCH', () => {
    type Handle = ReturnType<Client<VerbMap, Attributes, never>['tracks']['id']>
    expectTypeOf<Handle['playlists']['add']>().toBeFunction()
    expectTypeOf<Handle['playlists']['remove']>().toBeFunction()
    // The headline assertion: a forbidden verb is `never`, so calling it is a compile error.
    expectTypeOf<Handle['playlists']['replace']>().toBeNever()
    expectTypeOf<Handle['playlists']['set']>().toBeNever()
  })

  it('gates every verb to never when the relation forbids all of them', () => {
    type Handle = ReturnType<Client<VerbMap, Attributes, never>['tracks']['id']>
    expectTypeOf<Handle['frozen']['add']>().toBeNever()
    expectTypeOf<Handle['frozen']['remove']>().toBeNever()
    expectTypeOf<Handle['frozen']['replace']>().toBeNever()
  })

  it('keeps `set` on a to-one with the set flag', () => {
    type Handle = ReturnType<Client<VerbMap, Attributes, never>['tracks']['id']>
    expectTypeOf<Handle['album']['set']>().toBeFunction()
    expectTypeOf<Handle['album']['add']>().toBeNever()
  })

  it('gates `set` to never on a read-only to-one (empty mutations block, no PATCH)', () => {
    type Handle = ReturnType<Client<VerbMap, Attributes, never>['tracks']['id']>
    // A read-only to-one forbids every mutation verb — `.set` is `never`.
    expectTypeOf<Handle['readonlyOwner']['set']>().toBeNever()
    expectTypeOf<Handle['readonlyOwner']['add']>().toBeNever()
    expectTypeOf<Handle['readonlyOwner']['remove']>().toBeNever()
    expectTypeOf<Handle['readonlyOwner']['replace']>().toBeNever()
  })
})

// A call-site probe: a `replace` on a verb-gated to-many is a compile error.
declare const vclient: Client<VerbMap, Attributes, never>
async function gatedVerbIsACompileError() {
  const handle = vclient.tracks.id('1')
  await handle.playlists.add([{ type: 'playlists', id: '2' }])
  await handle.playlists.remove([{ type: 'playlists', id: '2' }])
  // @ts-expect-error — `playlists` forbids `replace` (no PATCH on its relationship endpoint).
  await handle.playlists.replace([{ type: 'playlists', id: '2' }])
}

describe('per-relation verb gating call-site', () => {
  it('a forbidden verb is rejected at the call site', () => {
    expectTypeOf(gatedVerbIsACompileError).returns.resolves.toBeVoid()
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

// Call-site sparse-fieldset narrowing: a `fields` selection narrows the inferred element type
// (an unrequested attribute is statically absent). Declared, never run — the assertions are tsc.
async function narrowsListFields() {
  const albums = await client.albums.list({ fields: { albums: ['title'] } })
  expectTypeOf(albums[0]!.title).toEqualTypeOf<string>()
  // @ts-expect-error — `status` was not in the requested fieldset (statically absent).
  type _ = (typeof albums)[number]['status']
  return albums
}

// Call-site withCount: the token is constrained to the type's COLLECTION count tokens; a bogus
// token errs, and `withCount` is rejected on a single-resource `get` (collection-only).
async function withCountIsTokenConstrained() {
  await client.albums.list({ withCount: ['tracks'] })
  // @ts-expect-error — `_self_` is not a collection count token for albums (only `tracks`).
  await client.albums.list({ withCount: ['_self_'] })
  // @ts-expect-error — `artist` is not a declared count token for albums.
  await client.albums.list({ withCount: ['artist'] })
  // @ts-expect-error — `withCount` is not accepted on a single-resource get (collection-only).
  await client.albums.get('1', { withCount: ['tracks'] })
}

// Call-site include/sort/filter narrowing: each family is constrained to exactly what the
// descriptor advertises — an unadvertised include path, sort token or filter key is a compile
// error (the static mirror of the server's 400s) — and `sort`/`filter` are rejected outright on a
// type that advertises none. Declared, never run — the assertions are tsc.
async function queryParamsAreNarrowed() {
  // include — advertised paths compile (incl. dotted); an undeclared path errs.
  await client.albums.list({ include: ['artist', 'tracks.album'] })
  // @ts-expect-error — `label` is not an advertised include path for albums.
  await client.albums.list({ include: ['label'] })

  // sort — advertised (signed) tokens compile, as a scalar or a tuple; an undeclared token errs.
  await client.albums.list({ sort: 'title' })
  await client.albums.list({ sort: ['-title', 'status'] })
  // @ts-expect-error — `rating` is not an advertised sort token for albums.
  await client.albums.list({ sort: 'rating' })

  // filter — advertised keys compile; an undeclared key errs.
  await client.albums.list({ filter: { title: 'OK', status: 'released' } })
  // @ts-expect-error — `rating` is not an advertised filter key for albums.
  await client.albums.list({ filter: { rating: 1 } })

  // `favorites` advertises neither sort nor filter, so supplying either is a compile error.
  // @ts-expect-error — favorites advertises no sortable fields.
  await client.favorites.list({ sort: 'whatever' })
  // @ts-expect-error — favorites advertises no filters.
  await client.favorites.list({ filter: { whatever: 1 } })

  // A single-resource get accepts `include` + `fields` only — not sort/filter/page.
  await client.albums.get('1', { include: ['artist'] })
  // @ts-expect-error — a single-resource get does not accept `sort`.
  await client.albums.get('1', { sort: 'title' })
  // @ts-expect-error — a single-resource get does not accept `filter`.
  await client.albums.get('1', { filter: { title: 'OK' } })
}

describe('read call-site fieldset + withCount narrowing', () => {
  it('narrows the element type to the requested fieldset', () => {
    expectTypeOf(narrowsListFields).returns.resolves.toMatchTypeOf<ReadonlyArray<unknown>>()
  })
  it('constrains withCount to the type count tokens', () => {
    expectTypeOf(withCountIsTokenConstrained).returns.resolves.toBeVoid()
  })
  it('constrains include/sort/filter to the advertised capabilities', () => {
    expectTypeOf(queryParamsAreNarrowed).returns.resolves.toBeVoid()
  })
})

// ── Write surface typing (Build 3) ───────────────────────────────────────────────────

// A descriptor with varied client-id policies so the create-`id` gating is exercised.
const writeMap = {
  albums: {
    attributes: { title: 'string' },
    relations: {
      artist: { cardinality: 'one', types: ['artists'], pivot: false },
      tracks: { cardinality: 'many', types: ['tracks'], pivot: false },
    },
    paths: {},
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['artist', 'tracks'],
  },
  artists: {
    attributes: { name: 'string' },
    relations: {},
    paths: {},
    paginator: 'page',
    clientId: 'forbidden',
  },
  tracks: {
    attributes: { title: 'string' },
    relations: {},
    paths: {},
    paginator: 'page',
    clientId: 'optional',
  },
  devices: {
    attributes: { label: 'string' },
    relations: {},
    paths: {},
    paginator: 'none',
    clientId: 'required',
  },
} as const satisfies ApiDescriptor

type WriteMap = typeof writeMap

// The generated `WriteAttributes` shape: per-type `{ create; update }` pairs (create marks
// required fields, update makes all optional). `devices` is omitted to model a type the
// API doesn't allow writing — the open fallback applies.
interface AlbumsCreateAttributes {
  title: string
}
interface AlbumsUpdateAttributes {
  title?: string
}
interface TracksCreateAttributes {
  title: string
}
interface TracksUpdateAttributes {
  title?: string
}
interface WriteAttributes {
  albums: { create: AlbumsCreateAttributes; update: AlbumsUpdateAttributes }
  tracks: { create: TracksCreateAttributes; update: TracksUpdateAttributes }
}

describe('write input typing', () => {
  it('CreateInput carries the create attributes + relation slots', () => {
    type Input = CreateInput<WriteMap, WriteAttributes, 'albums'>
    expectTypeOf<Input['title']>().toEqualTypeOf<string>()
    // to-one relation slot accepts a ref or null; to-many accepts an array of refs.
    expectTypeOf<Input['artist']>().toEqualTypeOf<LinkageRef<'artists'> | null | undefined>()
    expectTypeOf<Input['tracks']>().toEqualTypeOf<readonly LinkageRef<'tracks'>[] | undefined>()
  })

  it('UpdateInput makes attributes optional and keeps relation slots', () => {
    type Input = UpdateInput<WriteMap, WriteAttributes, 'albums'>
    expectTypeOf<Input['title']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Input['artist']>().toEqualTypeOf<LinkageRef<'artists'> | null | undefined>()
  })

  it('gates the create `id` field by the client-id policy', () => {
    // forbidden -> no usable `id` (typed `never?`).
    expectTypeOf<
      CreateInput<WriteMap, WriteAttributes, 'albums'>['id']
    >().toEqualTypeOf<undefined>()
    // optional -> `id?: string`.
    expectTypeOf<CreateInput<WriteMap, WriteAttributes, 'tracks'>['id']>().toEqualTypeOf<
      string | undefined
    >()
    // required -> `id: string` (a missing key is a type error at the call site).
    type DeviceInput = CreateInput<WriteMap, WriteAttributes, 'devices'>
    expectTypeOf<DeviceInput['id']>().toEqualTypeOf<string>()
  })

  it('falls back to an open create/update pair for a type absent from the write map', () => {
    // `devices` has no WriteAttributes entry -> open attributes, but the descriptor still
    // gates the id (required here).
    type Input = CreateInput<WriteMap, WriteAttributes, 'devices'>
    expectTypeOf<Input['id']>().toEqualTypeOf<string>()
    expectTypeOf<Input['label']>().toEqualTypeOf<unknown>()
  })
})

// Call-site write probes (declared, never run): the inferred types are the assertions.
declare const wclient: Client<WriteMap, Attributes, WriteAttributes>

async function createReturnsResource() {
  const album = await wclient.albums.create({
    title: 'Kid A',
    artist: { type: 'artists', id: '1' },
  })
  expectTypeOf(album.type).toEqualTypeOf<'albums'>()
  return album
}

async function createNarrowsOnInclude() {
  const album = await wclient.albums.create({ title: 'Kid A' }, { include: ['tracks'] })
  // The included to-many is a Collection of hydrated tracks.
  expectTypeOf(album.tracks).toHaveProperty('$page')
  return album
}

async function createForbidsClientIdWhenPolicyForbids() {
  // @ts-expect-error — albums.clientId is 'forbidden', so `id` is not an accepted key.
  await wclient.albums.create({ title: 'Kid A', id: 'nope' })
}

async function createRequiresClientIdWhenPolicyRequires() {
  // @ts-expect-error — devices.clientId is 'required', so `id` is mandatory.
  await wclient.devices.create({ label: 'phone' })
  await wclient.devices.create({ label: 'phone', id: 'd1' })
}

async function updateAcceptsPartialPatch() {
  const album = await wclient.albums.id('1').update({ title: 'Amnesiac' })
  expectTypeOf(album.type).toEqualTypeOf<'albums'>()
  return album
}

async function deleteReturnsVoid() {
  const out = await wclient.albums.id('1').delete()
  expectTypeOf(out).toEqualTypeOf<void>()
}

async function relationshipMutationsAreCardinalityGated() {
  const handle = wclient.albums.id('1')
  // to-many: add/remove/replace accept arrays of refs (members may carry $pivot).
  await handle.tracks.add([{ type: 'tracks', id: '2' }])
  await handle.tracks.remove([{ type: 'tracks', id: '2' }])
  await handle.tracks.replace([{ type: 'tracks', id: '2', $pivot: { position: 1 } }])
  // to-one: set accepts a ref or null.
  await handle.artist.set({ type: 'artists', id: '9' })
  await handle.artist.set(null)
  // @ts-expect-error — `set` is not available on a to-many relation.
  handle.tracks.set({ type: 'tracks', id: '2' })
  // @ts-expect-error — `add` is not available on a to-one relation.
  handle.artist.add([{ type: 'artists', id: '9' }])
}

describe('write call-site narrowing', () => {
  // Reference the probe functions so tsc type-checks their bodies (the `@ts-expect-error`
  // directives are the assertions); the runtime expectations confirm the inferred returns.
  it('create returns the materialised resource (narrowed on include)', () => {
    expectTypeOf(createReturnsResource).returns.resolves.toHaveProperty('$self')
    expectTypeOf(createNarrowsOnInclude).returns.resolves.toHaveProperty('tracks')
  })

  it('the client-id policy gates the create `id` at the call site', () => {
    expectTypeOf(createForbidsClientIdWhenPolicyForbids).returns.resolves.toBeVoid()
    expectTypeOf(createRequiresClientIdWhenPolicyRequires).returns.resolves.toBeVoid()
  })

  it('update returns the resource and delete returns void', () => {
    expectTypeOf(updateAcceptsPartialPatch).returns.resolves.toHaveProperty('$self')
    expectTypeOf(deleteReturnsVoid).returns.resolves.toBeVoid()
  })

  it('relationship mutations are cardinality-gated', () => {
    expectTypeOf(relationshipMutationsAreCardinalityGated).returns.resolves.toBeVoid()
  })
})

// ── Custom actions ─────────────────────────────────────────────────────────────────────

// A descriptor carrying a mix of action scopes and input/output modes (mirroring the
// generated `actions` block for the music-catalog albums type).
const actionMap = {
  albums: {
    attributes: { title: 'string' },
    relations: {},
    paths: {},
    paginator: 'page',
    clientId: 'forbidden',
    actions: {
      reissue: {
        scope: 'resource',
        path: '/albums/{id}/-actions/reissue',
        input: 'document',
        output: 'document',
      },
      artwork: {
        scope: 'resource',
        path: '/albums/{id}/-actions/artwork',
        input: 'raw',
        output: 'document',
      },
      summary: {
        scope: 'collection',
        path: '/albums/-actions/summary',
        input: 'none',
        output: 'document',
      },
      reindex: {
        scope: 'collection',
        path: '/albums/-actions/reindex',
        input: 'none',
        output: 'none',
      },
    },
  },
} as const satisfies ApiDescriptor

type ActionMap = typeof actionMap

// A descriptor whose actions carry the RESOLVED input/output types (the codegen's
// `inputType`/`outputType`/`outputCardinality` + a `meta` output + a non-POST `method`). The
// client derives the action surface from these directly — no generated alias map needed.
const resolvedActionMap = {
  albums: {
    attributes: { title: 'string', status: 'string' },
    relations: {},
    paths: {},
    paginator: 'page',
    clientId: 'forbidden',
    actions: {
      // document in/out, resolving the resource type both ways.
      reissue: {
        scope: 'resource',
        path: '/albums/{id}/-actions/reissue',
        input: 'document',
        output: 'document',
        inputType: 'albums',
        outputType: 'albums',
        outputCardinality: 'one',
      },
      // a meta-only output.
      stats: {
        scope: 'collection',
        path: '/albums/-actions/stats',
        input: 'none',
        output: 'meta',
      },
      // a non-POST method, no output.
      recalculate: {
        scope: 'collection',
        path: '/albums/-actions/recalculate',
        method: 'PATCH',
        input: 'none',
        output: 'none',
      },
    },
  },
} as const satisfies ApiDescriptor

type ResolvedActionMap = typeof resolvedActionMap

// The generated per-action body-type map (the codegen's `ActionTypes`, threaded as the
// client's fourth type argument). `reissue` carries a precise create-envelope input and a
// materialised-album output; `summary`/`artwork` carry only their output. A type/action
// absent from this map falls back to the loose `Record<string,unknown>` in / `unknown` out.
interface ReissueInput {
  data: { type: 'albums'; attributes?: AlbumsAttributes }
}
interface AlbumOutput {
  data: { type: 'albums'; id: string; attributes?: AlbumsAttributes }
}
interface ActionTypes {
  albums: {
    reissue: { input: ReissueInput; output: AlbumOutput }
    summary: { output: AlbumOutput }
    artwork: { output: AlbumOutput }
  }
}

describe('custom action typing', () => {
  it('exposes collection-scoped actions on the type accessor, not resource-scoped ones', () => {
    type Accessor = Client<ActionMap, Attributes>['albums']
    expectTypeOf<Accessor['actions']['summary']>().toBeFunction()
    expectTypeOf<Accessor['actions']['reindex']>().toBeFunction()
    // A resource-scoped action is absent from the collection accessor.
    // @ts-expect-error — `reissue` is resource-scoped (reach it via `.id(id).actions`).
    type _r = Accessor['actions']['reissue']
  })

  it('exposes resource-scoped actions on the handle, not collection-scoped ones', () => {
    type Handle = ReturnType<Client<ActionMap, Attributes>['albums']['id']>
    expectTypeOf<Handle['actions']['reissue']>().toBeFunction()
    expectTypeOf<Handle['actions']['artwork']>().toBeFunction()
    // A collection-scoped action is absent from the handle.
    // @ts-expect-error — `summary` is collection-scoped (reach it via `client.albums.actions`).
    type _s = Handle['actions']['summary']
  })

  it('types each action by its input mode (loose fallback without the action-types map)', () => {
    type Handle = ReturnType<Client<ActionMap, Attributes>['albums']['id']>
    type Accessor = Client<ActionMap, Attributes>['albums']
    // `document` input falls back to a loose JSON:API document body (no action-types map).
    expectTypeOf<Parameters<Handle['actions']['reissue']>>().toEqualTypeOf<
      [Record<string, unknown>]
    >()
    // `raw` input takes an arbitrary body.
    expectTypeOf<Parameters<Handle['actions']['artwork']>>().toEqualTypeOf<[unknown]>()
    // `none` input takes no argument.
    expectTypeOf<Parameters<Accessor['actions']['summary']>>().toEqualTypeOf<[]>()
  })

  it('types each action by its output mode (loose fallback without the action-types map)', () => {
    type Accessor = Client<ActionMap, Attributes>['albums']
    // `document` output falls back to a materialised value typed `unknown` (no map).
    expectTypeOf<ReturnType<Accessor['actions']['summary']>>().resolves.toBeUnknown()
    // `none` output resolves void.
    expectTypeOf<ReturnType<Accessor['actions']['reindex']>>().resolves.toBeVoid()
  })

  it('wires the generated action-types map onto the input/output of a document action', () => {
    type Handle = ReturnType<Client<ActionMap, Attributes, never, ActionTypes>['albums']['id']>
    type Accessor = Client<ActionMap, Attributes, never, ActionTypes>['albums']
    // `reissue` now takes the precise generated input envelope, not a loose record.
    expectTypeOf<Parameters<Handle['actions']['reissue']>>().toEqualTypeOf<[ReissueInput]>()
    // ...and resolves the generated output type (the materialised album document).
    expectTypeOf<ReturnType<Handle['actions']['reissue']>>().resolves.toEqualTypeOf<AlbumOutput>()
    // `summary` (none-input) keeps no argument but resolves the generated output.
    expectTypeOf<Parameters<Accessor['actions']['summary']>>().toEqualTypeOf<[]>()
    expectTypeOf<ReturnType<Accessor['actions']['summary']>>().resolves.toEqualTypeOf<AlbumOutput>()
    // `artwork` (raw-input) stays loose on input but resolves the generated output.
    expectTypeOf<Parameters<Handle['actions']['artwork']>>().toEqualTypeOf<[unknown]>()
    expectTypeOf<ReturnType<Handle['actions']['artwork']>>().resolves.toEqualTypeOf<AlbumOutput>()
  })

  it('a none-output action resolves void even with the action-types map present', () => {
    type Accessor = Client<ActionMap, Attributes, never, ActionTypes>['albums']
    // `reindex` is none-output and absent from the map; it stays void regardless.
    expectTypeOf<ReturnType<Accessor['actions']['reindex']>>().resolves.toBeVoid()
  })
})

describe('custom action typing — resolved input/output types (no alias map)', () => {
  type Handle = ReturnType<Client<ResolvedActionMap, Attributes, WriteAttributes>['albums']['id']>
  type Accessor = Client<ResolvedActionMap, Attributes, WriteAttributes>['albums']

  it('materialises a document output into the resource view of its outputType (D1)', () => {
    type Reissued = Awaited<ReturnType<Handle['actions']['reissue']>>
    // The result is the MATERIALISED resource (result.title / result.type), not the raw envelope.
    expectTypeOf<Reissued['type']>().toEqualTypeOf<'albums'>()
    expectTypeOf<Reissued['title']>().toEqualTypeOf<string>()
    expectTypeOf<Reissued['status']>().toEqualTypeOf<AlbumStatus>()
    // A raw-envelope `data` member is NOT present on the materialised result.
    expectTypeOf<Reissued>().not.toHaveProperty('data')
  })

  it('accepts FLAT input for a document action naming its inputType (D37)', () => {
    // The argument is the resource's create input (flat attributes), not a hand-built envelope.
    expectTypeOf<Parameters<Handle['actions']['reissue']>[0]>().toHaveProperty('title')
  })

  it('returns the document meta for a meta-output action (D2)', () => {
    expectTypeOf<ReturnType<Accessor['actions']['stats']>>().resolves.toEqualTypeOf<
      Record<string, unknown>
    >()
    expectTypeOf<Parameters<Accessor['actions']['stats']>>().toEqualTypeOf<[]>()
  })

  it('a non-POST, none-output action takes no argument and resolves void (D25)', () => {
    expectTypeOf<Parameters<Accessor['actions']['recalculate']>>().toEqualTypeOf<[]>()
    expectTypeOf<ReturnType<Accessor['actions']['recalculate']>>().resolves.toBeVoid()
  })
})

// Call-site probe: a resolved document action takes FLAT input and returns the materialised view.
declare const rclient: Client<ResolvedActionMap, Attributes, WriteAttributes>
async function resolvedActionsCallSite() {
  const album = await rclient.albums.id('1').actions.reissue({ title: 'Reissued' })
  album.title.toUpperCase()
  const meta = await rclient.albums.actions.stats()
  expectTypeOf(meta).toEqualTypeOf<Record<string, unknown>>()
  await rclient.albums.actions.recalculate()
  // @ts-expect-error — a resolved document input is FLAT; a hand-built envelope is not accepted.
  await rclient.albums.id('1').actions.reissue({ data: { type: 'albums' } })
}

// Call-site probes: real action invocations whose argument/return shapes tsc checks.
declare const aclient: Client<ActionMap, Attributes>
async function actionsCallSite() {
  await aclient.albums.id('1').actions.reissue({ data: { type: 'albums' } })
  await aclient.albums.id('1').actions.artwork('raw-payload')
  await aclient.albums.actions.summary()
  await aclient.albums.actions.reindex()
  // @ts-expect-error — `none` input takes no argument.
  await aclient.albums.actions.summary({ nope: true })
  // @ts-expect-error — a resource-scoped action is not on the collection accessor.
  await aclient.albums.actions.reissue({ data: {} })
}

// Call-site probe with the generated action-types map: the precise input is enforced and the
// output is the materialised type.
declare const taclient: Client<ActionMap, Attributes, never, ActionTypes>
async function typedActionsCallSite() {
  const album = await taclient.albums.id('1').actions.reissue({ data: { type: 'albums' } })
  // The output is the generated album document (not `unknown`).
  expectTypeOf(album.data.type).toEqualTypeOf<'albums'>()
  // @ts-expect-error — the input must be the generated envelope, not an arbitrary record.
  await taclient.albums.id('1').actions.reissue({ totally: 'wrong', not: 'an envelope' })
}

describe('custom action call-site', () => {
  it('accepts well-typed action calls and rejects ill-typed ones', () => {
    expectTypeOf(actionsCallSite).returns.resolves.toBeVoid()
    expectTypeOf(typedActionsCallSite).returns.resolves.toBeVoid()
    // The resolved-descriptor probe (flat input, materialised output, meta, non-POST).
    expectTypeOf(resolvedActionsCallSite).returns.resolves.toBeVoid()
  })
})

// ── Atomic transaction surface ──────────────────────────────────────────────────────────

describe('atomic surface typing', () => {
  it('exposes `atomic` on the client, taking a recorder callback and resolving positional results', () => {
    expectTypeOf<Client<Map, Attributes>>().toHaveProperty('atomic')
    expectTypeOf<Client<Map, Attributes>['atomic']>().toBeFunction()
  })

  it('resolves the loose AtomicResult[] when the callback returns void', () => {
    // The void-return overload preserves the original (untyped-data) result array.
    expectTypeOf<ReturnType<Client<Map, Attributes>['atomic']>>().resolves.toBeArray()
  })
})

// Call-site probe (void return -> loose results): the recorder records typed ops; a create
// handle doubles as a `{type,lid}` ref usable in a later op. Declared, never run.
declare const atclient: Client<Map, Attributes>
async function atomicCallSite() {
  const results = await atclient.atomic((tx) => {
    const album = tx.create({ type: 'albums', title: 'Kid A' })
    // The create handle carries its narrowed type + lid + kind + opIndex.
    expectTypeOf(album.type).toEqualTypeOf<'albums'>()
    expectTypeOf(album.lid).toEqualTypeOf<string>()
    expectTypeOf(album.kind).toEqualTypeOf<'create'>()
    expectTypeOf(album.opIndex).toEqualTypeOf<number>()
    // It wires into a later op without a server id.
    tx.create({ type: 'tracks', title: 'Idioteque', album })
    tx.update({ type: 'albums', id: '1', title: 'Amnesiac' })
    tx.delete({ type: 'tracks', id: '9' })
    // An update/delete can target a same-batch resource by `lid` (e.g. the create handle).
    tx.update({ type: 'albums', lid: album.lid, title: 'Sequel' })
    tx.delete({ type: 'albums', lid: album.lid })
    // @ts-expect-error — an update must carry an `id` OR a `lid`, never both.
    tx.update({ type: 'albums', id: '1', lid: album.lid })
    // No return -> the loose `AtomicResult[]` overload.
  })
  // Loose results are positional; each carries the materialised data (unknown) + optional meta.
  expectTypeOf(results[0]!.data).toBeUnknown()
  return results
}

describe('atomic call-site (loose, void return)', () => {
  it('records typed ops and resolves positional results', () => {
    expectTypeOf(atomicCallSite).returns.resolves.toBeArray()
  })
})

// ── Atomic per-op POSITIONAL typing (the headline) ───────────────────────────────────────

// Call-site probe (tuple return -> per-op typed results). Declared, never run — the inferred
// result-tuple types ARE the assertions.
async function atomicPositionalCallSite() {
  const [album, track, gone] = await atclient.atomic((tx) => [
    tx.create({ type: 'albums', title: 'Kid A' }),
    tx.update({ type: 'tracks', id: '1', title: 'Idioteque' }),
    tx.delete({ type: 'artists', id: '9' }),
  ])

  // (1) the create result is typed as that type's resource (has `title`/attributes/$accessors).
  expectTypeOf(album.data.type).toEqualTypeOf<'albums'>()
  expectTypeOf(album.data.title).toEqualTypeOf<string>()
  expectTypeOf(album.data.status).toEqualTypeOf<AlbumStatus>()
  expectTypeOf(album.data).toHaveProperty('$self')
  expectTypeOf(album.meta).toEqualTypeOf<Record<string, unknown> | undefined>()

  // (2) the update result is likewise the materialised resource of its type.
  expectTypeOf(track.data.type).toEqualTypeOf<'tracks'>()
  expectTypeOf(track.data.title).toEqualTypeOf<string>()

  // (3) the delete result is `undefined` (no data).
  expectTypeOf(gone).toEqualTypeOf<undefined>()

  return [album, track, gone] as const
}

// (4) the tuple is positional: mixed types keep their positions even when REORDERED at return.
async function atomicPositionalKeepsOrder() {
  const [aTrack, anAlbum] = await atclient.atomic((tx) => {
    const album = tx.create({ type: 'albums', title: 'Kid A' })
    const track = tx.update({ type: 'tracks', id: '1', title: 'Idioteque' })
    // Returned in the OPPOSITE order to the ops recorded — the result tuple follows the
    // RETURN order (resolved by each handle's opIndex at runtime), not the op order.
    return [track, album] as const
  })
  expectTypeOf(aTrack.data.type).toEqualTypeOf<'tracks'>()
  expectTypeOf(anAlbum.data.type).toEqualTypeOf<'albums'>()
}

// (5) a same-batch lid handle still wires into a later op under the typed-tuple form.
async function atomicLidWiringUnderTuple() {
  const [album, track] = await atclient.atomic((tx) => {
    const created = tx.create({ type: 'albums', title: 'Kid A' })
    // The create handle wires (by `{type,lid}`) into a later op's to-one slot.
    return [created, tx.create({ type: 'tracks', title: 'Idioteque', album: created })] as const
  })
  expectTypeOf(album.data.type).toEqualTypeOf<'albums'>()
  expectTypeOf(track.data.type).toEqualTypeOf<'tracks'>()
}

// AtomicResultOf unit assertions (the per-handle mapping, independent of call-site inference).
describe('AtomicResultOf mapping', () => {
  it('maps a create handle to the materialised resource result of its type', () => {
    type R = AtomicResultOf<Map, Attributes, AtomicCreateHandle<'albums'>>
    expectTypeOf<R['data']['type']>().toEqualTypeOf<'albums'>()
    expectTypeOf<R['data']['title']>().toEqualTypeOf<string>()
  })

  it('maps an update handle to the materialised resource result of its type', () => {
    type R = AtomicResultOf<Map, Attributes, AtomicUpdateHandle<'tracks'>>
    expectTypeOf<R['data']['type']>().toEqualTypeOf<'tracks'>()
    expectTypeOf<R['data']['title']>().toEqualTypeOf<string>()
  })

  it('maps a delete handle to undefined', () => {
    expectTypeOf<AtomicResultOf<Map, Attributes, AtomicDeleteHandle>>().toEqualTypeOf<undefined>()
  })
})

describe('atomic per-op positional call-site', () => {
  it('types each returned handle as its positional result', () => {
    expectTypeOf(atomicPositionalCallSite).returns.resolves.toMatchTypeOf<readonly unknown[]>()
  })
  it('keeps positions when the returned tuple reorders the ops', () => {
    expectTypeOf(atomicPositionalKeepsOrder).returns.resolves.toBeVoid()
  })
  it('wires a same-batch lid handle into a later op under the tuple form', () => {
    expectTypeOf(atomicLidWiringUnderTuple).returns.resolves.toBeVoid()
  })
})
