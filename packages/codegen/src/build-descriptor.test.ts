import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { buildAtomic, buildDescriptor } from './build-descriptor'
import type { OpenApiDocument, SchemaObject } from './openapi'

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
      // the related to-many GET advertises its own withCount (`_self_` + tracks' countable
      // relations) with the Countable profile (D3).
      countable: {
        tokens: ['_self_', 'playlists'],
        profile: 'https://haddowg.github.io/json-api/profiles/countable/',
      },
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
      // the related to-many GET advertises its own withCount + Countable profile (D3).
      countable: {
        tokens: ['playlists'],
        profile: 'https://haddowg.github.io/json-api/profiles/countable/',
      },
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
      // A document body/output names its resource type so the client accepts flat input and
      // materialises the response (rather than the raw wire envelope).
      inputType: 'albums',
      outputType: 'albums',
      outputCardinality: 'one',
    })
  })

  it('collects a collection-scoped, meta-output action (albums.summary)', () => {
    expect(descriptor['albums']!.actions?.['summary']).toEqual({
      scope: 'collection',
      path: '/albums/-actions/summary',
      input: 'none',
      // A meta-only document ($ref MetaDocument) — the client returns its top-level `meta`.
      output: 'meta',
    })
  })

  it('classifies a non-JSON:API body as a raw input, carrying its declared media type (albums.artwork)', () => {
    expect(descriptor['albums']!.actions?.['artwork']).toEqual({
      scope: 'resource',
      path: '/albums/{id}/-actions/artwork',
      input: 'raw',
      // The handler returns a 204 (no JSON:API body), so the output is `none`.
      output: 'none',
      // The declared media type (application/octet-stream) rides the descriptor so the client
      // sends the right Content-Type rather than a wildcard.
      contentType: 'application/octet-stream',
    })
  })

  it('omits the `actions` key entirely for a type with no custom actions', () => {
    expect(descriptor['tracks']!.actions).toBeUndefined()
  })
})

describe('buildDescriptor — non-POST + unusable action operations', () => {
  const doc: OpenApiDocument = {
    openapi: '3.1.0',
    paths: {
      '/widgets': {
        get: {
          responses: {
            '200': {
              content: {
                'application/vnd.api+json': {
                  schema: { $ref: '#/components/schemas/WidgetsCollection' },
                },
              },
            },
          },
        },
      },
      // A PATCH-only action (methods: ['PATCH']) — must be collected, carrying its method.
      '/widgets/-actions/recalculate': {
        patch: { responses: { '204': {} } },
      },
      // A path item advertising no operation at all — skipped with a warning, not collected.
      '/widgets/-actions/broken': {},
    },
    components: {
      schemas: {
        WidgetsResource: {
          type: 'object',
          properties: { type: { type: 'string', const: 'widgets' } },
        },
        WidgetsCollection: { type: 'object' },
      },
    },
  }

  it('collects a non-POST action carrying its upper-cased method', () => {
    const built = buildDescriptor(doc)
    expect(built['widgets']!.actions?.['recalculate']).toEqual({
      scope: 'collection',
      path: '/widgets/-actions/recalculate',
      method: 'PATCH',
      input: 'none',
      output: 'none',
    })
  })

  it('warns and skips an -actions path with no usable operation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const built = buildDescriptor(doc)
      expect(built['widgets']!.actions?.['broken']).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('/widgets/-actions/broken'))
    } finally {
      warn.mockRestore()
    }
  })
})

describe('buildDescriptor — withCount (Countable) capability', () => {
  const COUNTABLE_PROFILE = 'https://haddowg.github.io/json-api/profiles/countable/'

  it('captures the count tokens and profile from a collection withCount param (albums)', () => {
    expect(descriptor['albums']!.countable).toEqual({
      tokens: ['tracks'],
      profile: COUNTABLE_PROFILE,
    })
    expect(descriptor['albums']!.countable!.tokens).toContain('tracks')
    expect(descriptor['albums']!.countable!.profile).toBe(COUNTABLE_PROFILE)
  })

  it('omits `countable` when the collection GET lacks withCount, even if a related GET has one (artists)', () => {
    // `/artists` (the collection) has no withCount; `/artists/{id}/albums` (a related GET) does,
    // but its tokens count the related collection, NOT the `artists` collection — so `list` could
    // not legally send them. `countable` mirrors the collection GET only, so it is omitted here.
    expect(descriptor['artists']!.countable).toBeUndefined()
  })

  it('omits `countable` for a type whose read endpoints advertise no withCount (genres)', () => {
    expect(descriptor['genres']!.countable).toBeUndefined()
  })

  it('omits `countable` for a read-only type with no withCount (charts)', () => {
    expect(descriptor['charts']!.countable).toBeUndefined()
  })

  it('reads the profile from x-profile rather than hardcoding the URI', () => {
    const synthetic: OpenApiDocument = {
      components: {
        schemas: {
          WidgetsResource: {
            type: 'object',
            properties: { type: { type: 'string', const: 'widgets' }, id: { type: 'string' } },
          },
          WidgetsCollection: { type: 'object' },
        },
      },
      paths: {
        '/widgets': {
          get: {
            parameters: [
              {
                name: 'withCount',
                in: 'query',
                schema: { type: 'array', items: { type: 'string', enum: ['gadgets'] } },
                'x-profile': 'https://example.test/profiles/custom-count/',
              },
            ],
            responses: {
              '200': {
                content: {
                  'application/vnd.api+json': {
                    schema: { $ref: '#/components/schemas/WidgetsCollection' },
                  },
                },
              },
            },
          },
        },
      },
    }
    expect(buildDescriptor(synthetic)['widgets']!.countable).toEqual({
      tokens: ['gadgets'],
      profile: 'https://example.test/profiles/custom-count/',
    })
  })

  it('omits `countable` when a withCount param carries no x-profile (un-negotiable)', () => {
    const synthetic: OpenApiDocument = {
      components: {
        schemas: {
          WidgetsResource: {
            type: 'object',
            properties: { type: { type: 'string', const: 'widgets' }, id: { type: 'string' } },
          },
          WidgetsCollection: { type: 'object' },
        },
      },
      paths: {
        '/widgets': {
          get: {
            parameters: [
              {
                name: 'withCount',
                in: 'query',
                schema: { type: 'array', items: { type: 'string', enum: ['gadgets'] } },
              },
            ],
            responses: {
              '200': {
                content: {
                  'application/vnd.api+json': {
                    schema: { $ref: '#/components/schemas/WidgetsCollection' },
                  },
                },
              },
            },
          },
        },
      },
    }
    expect(buildDescriptor(synthetic)['widgets']!.countable).toBeUndefined()
  })
})

describe('buildDescriptor — include/sort/filter capabilities', () => {
  it('captures the includable enum (incl. nested dotted paths) from the read params (albums)', () => {
    expect(descriptor['albums']!.includable).toEqual([
      'artist',
      'tracks',
      'tracks.album',
      'tracks.playlists',
    ])
  })

  it('captures the sortable (signed) tokens from the collection GET (albums)', () => {
    expect(descriptor['albums']!.sortable).toEqual([
      'title',
      '-title',
      'releasedAt',
      '-releasedAt',
      'status',
      '-status',
    ])
  })

  it('captures the filterable keys (sorted) from the collection GET (albums)', () => {
    expect(descriptor['albums']!.filterable).toEqual([
      'artist.name',
      'rating',
      'releasedAt',
      'title',
      'tracks',
    ])
  })

  it('omits `includable` for a type whose relations are all non-includable (artists)', () => {
    expect(descriptor['artists']!.includable).toBeUndefined()
    // ...while its sort/filter capabilities are still captured.
    expect(descriptor['artists']!.sortable).toContain('name')
    expect(descriptor['artists']!.filterable).toEqual(['slug'])
  })

  it('omits `sortable` and `filterable` when the collection advertises neither (playlists)', () => {
    expect(descriptor['playlists']!.sortable).toBeUndefined()
    expect(descriptor['playlists']!.filterable).toBeUndefined()
    // ...but `includable` is still present (playlists' relations are includable).
    expect(descriptor['playlists']!.includable).toContain('orderedTracks')
  })

  it('omits all three for a type whose reads advertise no include/sort/filter (genres)', () => {
    expect(descriptor['genres']!.includable).toBeUndefined()
    expect(descriptor['genres']!.sortable).toBeUndefined()
    expect(descriptor['genres']!.filterable).toBeUndefined()
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
    // `/users/{id}/playlists` and `/albums/{id}/tracks` ref Playlists/TracksCollection but are
    // parent-scoped related endpoints — they are NOT fetchMany for these types. These are REAL
    // registered resources (a `type/id/attributes/meta` object) with no top-level collection, so
    // they stay in the descriptor (with empty paths) — only a permissive type-only stub is
    // dropped by D27 (see the dedicated test below).
    expect(admin['playlists']!.paths).toEqual({})
    expect(admin['playlists']!.paginator).toBe('none')
    expect(admin['tracks']!.paths).toEqual({})
    expect(admin['tracks']!.paginator).toBe('none')
  })
})

// A to-many relationship component whose linkage refs `<IdType>Identifier` (an identifier, not a
// Resource — so the related type does not become its own descriptor entry).
const toManyRelationshipComponent = (idType: string): SchemaObject => ({
  type: 'object',
  properties: {
    data: { type: 'array', items: { $ref: `#/components/schemas/${idType}Identifier` } },
  },
})

describe('buildDescriptor — per-relation endpoint suppression (D24)', () => {
  // A `parts` relation exposes both endpoints; `gadgets` has its RELATED endpoint suppressed;
  // `labels` has its RELATIONSHIP endpoint suppressed.
  const rel = toManyRelationshipComponent
  const doc: OpenApiDocument = {
    openapi: '3.1.0',
    paths: {
      '/widgets': {
        get: {
          responses: {
            '200': {
              content: {
                'application/vnd.api+json': {
                  schema: { $ref: '#/components/schemas/WidgetsCollection' },
                },
              },
            },
          },
        },
      },
      // parts: both endpoints (relationship advertises POST -> add).
      '/widgets/{id}/parts': { get: {} },
      '/widgets/{id}/relationships/parts': { get: {}, post: {} },
      // gadgets: NO related endpoint; relationship present (PATCH -> replace).
      '/widgets/{id}/relationships/gadgets': { get: {}, patch: {} },
      // labels: NO relationship endpoint; related present.
      '/widgets/{id}/labels': { get: {} },
    },
    components: {
      schemas: {
        WidgetsResource: {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'widgets' },
            relationships: {
              type: 'object',
              properties: {
                parts: { $ref: '#/components/schemas/WidgetsPartsRelationship' },
                gadgets: { $ref: '#/components/schemas/WidgetsGadgetsRelationship' },
                labels: { $ref: '#/components/schemas/WidgetsLabelsRelationship' },
              },
            },
          },
        },
        WidgetsCollection: { type: 'object' },
        WidgetsPartsRelationship: rel('Parts'),
        WidgetsGadgetsRelationship: rel('Gadgets'),
        WidgetsLabelsRelationship: rel('Labels'),
        PartsIdentifier: {
          type: 'object',
          properties: { type: { type: 'string', const: 'parts' } },
        },
        GadgetsIdentifier: {
          type: 'object',
          properties: { type: { type: 'string', const: 'gadgets' } },
        },
        LabelsIdentifier: {
          type: 'object',
          properties: { type: { type: 'string', const: 'labels' } },
        },
      },
    },
  }

  it('emits closed exposure signals so a suppressed relation cannot fail open', () => {
    const relations = buildDescriptor(doc)['widgets']!.relations
    // Fully exposed: no suppression flags, mutation verbs from the advertised methods.
    expect(relations['parts']).toEqual({
      cardinality: 'many',
      types: ['parts'],
      pivot: false,
      mutations: { add: true },
    })
    // Related endpoint suppressed -> `related: false` (gates `.related()` off).
    expect(relations['gadgets']).toEqual({
      cardinality: 'many',
      types: ['gadgets'],
      pivot: false,
      related: false,
      mutations: { replace: true },
    })
    // Relationship endpoint suppressed -> `relationship: false` + closed `mutations: {}` (no verb
    // callable), rather than an absent block that the client would read as "all verbs callable".
    expect(relations['labels']).toEqual({
      cardinality: 'many',
      types: ['labels'],
      pivot: false,
      relationship: false,
      mutations: {},
    })
  })
})

describe('buildDescriptor — drift warnings (D28)', () => {
  it('warns and drops a relationship whose linkage shape is unrecognized', () => {
    const doc: OpenApiDocument = {
      openapi: '3.1.0',
      paths: {
        '/widgets': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/vnd.api+json': {
                    schema: { $ref: '#/components/schemas/WidgetsCollection' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          WidgetsResource: {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'widgets' },
              relationships: {
                type: 'object',
                properties: {
                  mystery: { $ref: '#/components/schemas/WidgetsMysteryRelationship' },
                },
              },
            },
          },
          WidgetsCollection: { type: 'object' },
          // An unrecognized linkage shape: `data` is neither an array, a `$ref`, nor an anyOf.
          WidgetsMysteryRelationship: { type: 'object', properties: { data: { type: 'object' } } },
        },
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const relations = buildDescriptor(doc)['widgets']!.relations
      expect(relations['mystery']).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('mystery'))
    } finally {
      warn.mockRestore()
    }
  })

  it('warns when a collection advertises page params matching no known paginator kind', () => {
    const doc: OpenApiDocument = {
      openapi: '3.1.0',
      paths: {
        '/widgets': {
          get: {
            parameters: [{ name: 'page[weird]', in: 'query' }],
            responses: {
              '200': {
                content: {
                  'application/vnd.api+json': {
                    schema: { $ref: '#/components/schemas/WidgetsCollection' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          WidgetsResource: {
            type: 'object',
            properties: { type: { type: 'string', const: 'widgets' } },
          },
          WidgetsCollection: { type: 'object' },
        },
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(buildDescriptor(doc)['widgets']!.paginator).toBe('none')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('paginator'))
    } finally {
      warn.mockRestore()
    }
  })
})

describe('buildDescriptor — synthetic stub skipping (D27)', () => {
  it('drops a type-only permissive stub, but keeps a real collection-less resource', () => {
    const doc: OpenApiDocument = {
      openapi: '3.1.0',
      paths: {
        '/widgets': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/vnd.api+json': {
                    schema: { $ref: '#/components/schemas/WidgetsCollection' },
                  },
                },
              },
            },
          },
        },
        // widgets exposes a related endpoint for `ghost`, an unregistered related type.
        '/widgets/{id}/ghost': { get: {} },
      },
      components: {
        schemas: {
          WidgetsResource: {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'widgets' },
              id: { type: 'string' },
              relationships: {
                type: 'object',
                properties: { ghost: { $ref: '#/components/schemas/WidgetsGhostRelationship' } },
              },
            },
          },
          WidgetsCollection: { type: 'object' },
          WidgetsGhostRelationship: {
            type: 'object',
            properties: {
              data: { anyOf: [{ $ref: '#/components/schemas/GhostResource' }, { type: 'null' }] },
            },
          },
          // The synthetic stub: a `<Rel>Resource` carrying ONLY a `type` const, exactly what
          // core's `permissiveResourceObject` emits for an unregistered related type.
          GhostResource: {
            type: 'object',
            properties: { type: { type: 'string', const: 'ghost' } },
          },
        },
      },
    }
    const built = buildDescriptor(doc)
    // The real widgets type stays; the type-only ghost stub is NOT a phantom top-level accessor.
    expect(built['widgets']).toBeDefined()
    expect(built['ghost']).toBeUndefined()
    // The relation to the (unregistered) ghost type is still declared on the parent.
    expect(built['widgets']!.relations['ghost']?.types).toEqual(['ghost'])
  })
})
