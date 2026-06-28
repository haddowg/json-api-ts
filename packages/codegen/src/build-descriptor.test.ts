import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildAtomic, buildDescriptor } from './build-descriptor'
import type { OpenApiDocument } from './openapi'

function loadFixture(name: string): OpenApiDocument {
  const path = fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument
}

const descriptor = buildDescriptor(loadFixture('music-catalog.openapi.json'))

describe('buildDescriptor (music-catalog default server)', () => {
  it('builds the albums resource precisely', () => {
    const albums = descriptor['albums']!
    expect(albums).toBeDefined()

    expect(albums.attributes).toMatchObject({
      title: 'string',
      averageRating: 'number',
      artwork: 'string',
      releasedAt: 'date-time',
      explicit: 'boolean',
      status: 'string',
      availableFrom: 'date',
      releaseInfo: 'object',
    })

    expect(albums.relations['artist']).toEqual({
      cardinality: 'one',
      types: ['artists'],
      pivot: false,
      // to-one: PATCH advertised -> `set`.
      mutations: { set: true },
    })
    expect(albums.relations['tracks']).toEqual({
      cardinality: 'many',
      types: ['tracks'],
      pivot: false,
      // to-many: POST/DELETE/PATCH advertised -> add/remove/replace.
      mutations: { add: true, remove: true, replace: true },
    })

    expect(albums.clientId).toBe('forbidden')
    expect(albums.paginator).toBe('page')

    expect(albums.paths).toEqual({
      create: '/albums',
      delete: '/albums/{id}',
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
      fetchRelationship: '/albums/{id}/relationships/{rel}',
      update: '/albums/{id}',
    })
  })

  it('detects a pivot to-many relation (playlists.orderedTracks)', () => {
    expect(descriptor['playlists']!.relations['orderedTracks']).toEqual({
      cardinality: 'many',
      types: ['tracks'],
      pivot: true,
      mutations: { add: true, remove: true, replace: true },
    })
  })

  it('detects a polymorphic to-many relation (libraries.items)', () => {
    const items = descriptor['libraries']!.relations['items']!
    expect(items.cardinality).toBe('many')
    expect(items.pivot).toBe(false)
    expect(items.types).toEqual(expect.arrayContaining(['tracks', 'albums', 'artists']))
  })

  it('detects a polymorphic to-one relation (favorites.favoritable)', () => {
    expect(descriptor['favorites']!.relations['favoritable']).toEqual({
      cardinality: 'one',
      types: ['tracks', 'albums', 'artists'],
      pivot: false,
      mutations: { set: true },
    })
  })

  it('reads a required client-id policy (genres)', () => {
    expect(descriptor['genres']!.clientId).toBe('required')
  })

  it('omits write operations for a read-only type (charts)', () => {
    const charts = descriptor['charts']!
    expect(charts.clientId).toBe('forbidden')
    expect(charts.paths).toEqual({
      fetchMany: '/charts',
      fetchOne: '/charts/{id}',
    })
  })

  it('produces deterministic, sorted type keys', () => {
    const keys = Object.keys(descriptor)
    // oxlint-disable-next-line no-array-sort -- sorting a copy to assert the keys are already ordered
    expect(keys).toEqual([...keys].sort())
  })
})

describe('buildDescriptor — per-relation mutation verbs', () => {
  it('advertises all three verbs on a fully-mutable to-many (albums.tracks)', () => {
    expect(descriptor['albums']!.relations['tracks']!.mutations).toEqual({
      add: true,
      remove: true,
      replace: true,
    })
  })

  it('gates `replace` off a to-many whose endpoint lacks PATCH (tracks.playlists)', () => {
    // `/tracks/{id}/relationships/playlists` advertises POST + DELETE but NOT PATCH —
    // modelling the bundle's `cannotReplace`. So `add`/`remove` are present, `replace` is not.
    const playlists = descriptor['tracks']!.relations['playlists']!
    expect(playlists.cardinality).toBe('many')
    expect(playlists.mutations).toEqual({ add: true, remove: true })
    expect(playlists.mutations).not.toHaveProperty('replace')
  })

  it('advertises only `set` on a to-one relation (albums.artist)', () => {
    expect(descriptor['albums']!.relations['artist']!.mutations).toEqual({ set: true })
  })
})

describe('buildDescriptor — custom actions', () => {
  it('collects a resource-scoped, document-in/document-out action (albums.reissue)', () => {
    expect(descriptor['albums']!.actions?.['reissue']).toEqual({
      scope: 'resource',
      path: '/albums/{id}/-actions/reissue',
      input: 'document',
      output: 'document',
    })
  })

  it('collects a collection-scoped, body-less action (albums.summary)', () => {
    expect(descriptor['albums']!.actions?.['summary']).toEqual({
      scope: 'collection',
      path: '/albums/-actions/summary',
      input: 'none',
      output: 'document',
    })
  })

  it('classifies a non-JSON:API body as a raw input, carrying its declared media type (albums.artwork)', () => {
    expect(descriptor['albums']!.actions?.['artwork']).toEqual({
      scope: 'resource',
      path: '/albums/{id}/-actions/artwork',
      input: 'raw',
      output: 'document',
      // The declared media type (application/octet-stream) rides the descriptor so the client
      // sends the right Content-Type rather than a wildcard.
      contentType: 'application/octet-stream',
    })
  })

  it('omits the `actions` key entirely for a type with no custom actions', () => {
    expect(descriptor['tracks']!.actions).toBeUndefined()
  })
})

describe('buildAtomic — server-level atomic capability', () => {
  it('detects the /operations endpoint by its atomic ext media type', () => {
    expect(buildAtomic(loadFixture('music-catalog.openapi.json'))).toEqual({ path: '/operations' })
  })

  it('detects the atomic endpoint on the admin server too', () => {
    expect(buildAtomic(loadFixture('music-catalog-admin.openapi.json'))).toEqual({
      path: '/operations',
    })
  })

  it('returns null when no endpoint declares the atomic ext media type', () => {
    const noAtomic: OpenApiDocument = {
      paths: {
        '/widgets': {
          post: {
            requestBody: { content: { 'application/vnd.api+json': { schema: {} } } },
          },
        },
      },
    }
    expect(buildAtomic(noAtomic)).toBeNull()
  })
})

describe('buildDescriptor (music-catalog admin server)', () => {
  it('builds without throwing and yields the admin type-set', () => {
    const admin = buildDescriptor(loadFixture('music-catalog-admin.openapi.json'))
    expect(Object.keys(admin)).toEqual(expect.arrayContaining(['albums', 'users']))
    // The admin server omits the public-only types.
    expect(admin['charts']).toBeUndefined()
    expect(admin['countries']).toBeUndefined()
    expect(admin['users']!.relations['playlists']).toEqual({
      cardinality: 'many',
      types: ['playlists'],
      pivot: false,
      mutations: { add: true, remove: true, replace: true },
    })
  })

  it('does not mistake a related collection for a type top-level collection', () => {
    const admin = buildDescriptor(loadFixture('music-catalog-admin.openapi.json'))
    // `/users/{id}/playlists` and `/albums/{id}/tracks` ref Playlists/TracksCollection
    // but are parent-scoped related endpoints — they are NOT fetchMany for these types.
    expect(admin['playlists']!.paths).toEqual({})
    expect(admin['playlists']!.paginator).toBe('none')
    expect(admin['tracks']!.paths).toEqual({})
    expect(admin['tracks']!.paginator).toBe('none')
  })
})
