import { readFileSync } from 'node:fs'
import type { ApiDescriptor, TransportRequest } from '@haddowg/json-api-client'
import { isPolymorphic } from '@haddowg/json-api-client'
import { describe, expect, it } from 'vitest'
import { createClient as createWitnessClient } from '../test/generated/contract-witness.client.gen'
import { createClient as createCatalogClient } from '../test/generated/music-catalog.client.gen'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import type { OpenApiDocument } from './openapi'
import { documentPath, type DocumentName } from '../test/documents'

const read = (name: DocumentName): OpenApiDocument =>
  JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument

const witness = read('contract-witness.json')
const catalog = read('music-catalog.openapi.json')
const admin = read('music-catalog-admin.openapi.json')

type Json = Record<string, unknown>

/**
 * Every operation documenting `relatedQuery`, read straight from the JSON: its path, method and
 * the relation names its component's schema lists.
 */
function oracle(doc: OpenApiDocument) {
  const parameters = (doc.components?.parameters ?? {}) as Record<string, Json>
  const out: { key: string; component: string; relations: string[] }[] = []
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item as Record<string, Json>)) {
      for (const raw of (op['parameters'] as Json[] | undefined) ?? []) {
        const component = String(raw['$ref'] ?? '')
          .split('/')
          .pop()!
        const param = parameters[component]
        if (param?.['name'] !== 'relatedQuery') continue
        const schema = param['schema'] as Json
        out.push({
          key: `${method.toUpperCase()} ${path}`,
          component,
          relations: Object.keys((schema['properties'] as Json | undefined) ?? {}),
        })
      }
    }
  }
  return out
}

/**
 * Where the descriptor says each operation takes `relatedQuery`, keyed as {@link oracle} keys it,
 * with the type whose relations it addresses.
 */
function marked(descriptor: ApiDescriptor): Map<string, string> {
  const out = new Map<string, string>()
  const methods = { fetchMany: 'GET', fetchOne: 'GET', create: 'POST', update: 'PATCH' } as const
  for (const [type, spec] of Object.entries(descriptor)) {
    for (const operation of spec.relatedQuery?.operations ?? []) {
      out.set(`${methods[operation]} ${spec.paths[operation]}`, type)
    }
    for (const [name, relation] of Object.entries(spec.relations)) {
      if (relation.relatedQuery === true) {
        const path = spec.paths['fetchRelated']!.replace('{rel}', relation.uriField ?? name)
        out.set(`GET ${path}`, relation.types[0]!)
      }
    }
    for (const action of Object.values(spec.actions ?? {})) {
      if (action.relatedQuery === true) {
        out.set(`${action.method ?? 'POST'} ${action.path}`, action.outputType!)
      }
    }
  }
  return out
}

/**
 * Core documents the Relationship Queries `relatedQuery` parameter on every operation whose
 * primary data is resources of one type, as a `<Type>RelatedQuery` component keyed by the
 * rendered type's monomorphic relations that aren't write-only.
 */
describe('generator contract 37 (relatedQuery wherever resources of one type answer)', () => {
  it('reads the witness and both catalog servers without a warning', () => {
    for (const doc of [witness, catalog, admin]) {
      expect(doc.info?.['x-generator']?.contract).toBe(37)
      expect(checkContract(doc)).toBeUndefined()
    }
  })

  it.each([
    ['contract witness', witness],
    ['music catalog', catalog],
    ['music catalog admin', admin],
  ])('marks exactly the %s operations that document it', (_, doc) => {
    const expected = oracle(doc)
    expect(expected.length).toBeGreaterThan(0)
    const descriptor = buildDescriptor(doc)
    const found = marked(descriptor)
    // oxlint-disable-next-line no-array-sort -- sorting freshly-created arrays
    expect([...found.keys()].sort()).toEqual(expected.map((entry) => entry.key).sort())
    for (const { key, relations } of expected) {
      expect(descriptor[found.get(key)!]!.relatedQuery?.relations, key).toEqual(relations)
    }
  })

  it.each([
    ['contract witness', witness],
    ['music catalog', catalog],
  ])('addresses only monomorphic relations a %s response renders', (_, doc) => {
    const descriptor = buildDescriptor(doc)
    for (const [type, spec] of Object.entries(descriptor)) {
      for (const name of spec.relatedQuery?.relations ?? []) {
        const relation = spec.relations[name]
        expect(relation, `${type}.${name}`).toBeDefined()
        expect(isPolymorphic(relation!), `${type}.${name}`).toBe(false)
        expect(relation!.writeOnly, `${type}.${name}`).toBeUndefined()
      }
    }
  })

  it('records each operation kind on the witness', () => {
    const descriptor = buildDescriptor(witness)
    expect(descriptor['articles']!.relatedQuery?.operations).toEqual([
      'fetchMany',
      'fetchOne',
      'create',
      'update',
    ])
    // A related read under its URI field, typed by the related type.
    expect(descriptor['articles']!.relations['publisher']).toMatchObject({
      uriField: 'published-by',
      relatedQuery: true,
    })
    // A GET action answering with an article, and a POST one.
    expect(descriptor['articles']!.actions?.['preview']?.relatedQuery).toBe(true)
    expect(descriptor['articles']!.actions?.['publish']?.relatedQuery).toBe(true)
    // An action answering with another type takes that type's relatedQuery.
    expect(descriptor['videos']!.actions?.['credit']).toMatchObject({
      outputType: 'credits',
      relatedQuery: true,
    })
    expect(descriptor['credits']!.relatedQuery?.operations).toEqual([])
  })

  it("keys each type's relatedQuery by relation rather than include path", () => {
    const albums = buildDescriptor(catalog)['albums']!
    expect(albums.relatedQuery?.relations).toEqual(['artist', 'tracks', 'tracklist'])
    expect(albums.includable).toContain('tracks.album')
    expect(albums.relatedQuery?.relations).not.toContain('tracks.album')
  })
})

const PROFILE = 'https://haddowg.github.io/json-api/profiles/relationship-queries/'

function recording(body: unknown) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest) => {
    requests.push(req)
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }
  return { requests, transport }
}

describe('the generated clients take relatedQuery where the documents offer it', () => {
  it('sends it on a create, an update, a related read and an action', async () => {
    const { requests, transport } = recording({ data: null })
    const catalogClient = createCatalogClient({ baseUrl: 'https://api.example.com', transport })
    await catalogClient.artists.create(
      { name: 'Ada' },
      { relatedQuery: { albums: { sort: '-title' } } },
    )
    await catalogClient.albums
      .id('1')
      .update({}, { relatedQuery: { artist: { filter: { q: 'x' } } } })
    await catalogClient.tracks
      .id('1')
      .album.related({ relatedQuery: { tracks: { sort: 'title' } } })
    await catalogClient.albums
      .id('1')
      .actions.reissue(
        { releasedAt: '2026-01-01T00:00:00+00:00' },
        { relatedQuery: { tracklist: { sort: '-trackNumber' } } },
      )
    expect(requests.map((req) => `${req.method} ${decodeURI(req.url)}`)).toEqual([
      'POST https://api.example.com/artists?relatedQuery[albums][sort]=-title',
      'PATCH https://api.example.com/albums/1?relatedQuery[artist][filter][q]=x',
      'GET https://api.example.com/tracks/1/album?relatedQuery[tracks][sort]=title',
      'POST https://api.example.com/albums/1/-actions/reissue?relatedQuery[tracklist][sort]=-trackNumber',
    ])
    for (const req of requests) {
      expect(req.headers['Accept']).toBe(`application/vnd.api+json; profile="${PROFILE}"`)
    }
  })

  it('types it from each operation and rejects what the server rejects', async () => {
    const { transport } = recording({ data: null })
    const catalogClient = createCatalogClient({ baseUrl: 'https://api.example.com', transport })
    const witnessClient = createWitnessClient({ baseUrl: 'https://api.example.com', transport })
    // @ts-expect-error — a dotted path is not a relation.
    await catalogClient.albums.list({ relatedQuery: { 'tracks.album': {} } })
    // @ts-expect-error — a to-one takes no sort.
    await catalogClient.albums.get('1', { relatedQuery: { artist: { sort: 'name' } } })
    // @ts-expect-error — relatedQuery doesn't address a polymorphic relation.
    await catalogClient.favorites.list({ relatedQuery: { favoritable: {} } })
    // @ts-expect-error — a dotted path is not a relation.
    await catalogClient.artists.create({ name: 'Ada' }, { relatedQuery: { 'albums.tracks': {} } })
    // @ts-expect-error — an album's relatedQuery doesn't address `playlists`.
    await catalogClient.tracks.id('1').album.related({ relatedQuery: { playlists: {} } })
    // @ts-expect-error — the polymorphic related read takes no relatedQuery.
    await catalogClient.favorites.id('1').favoritable.related({ relatedQuery: {} })
    await catalogClient.albums.id('1').actions.reissue(
      { releasedAt: '2026-01-01T00:00:00+00:00' },
      // @ts-expect-error — a to-one takes no sort.
      { relatedQuery: { artist: { sort: 'name' } } },
    )
    // An action answering with a credit takes the credits' relatedQuery.
    await witnessClient.videos.id('1').actions.credit({} as never, { relatedQuery: { person: {} } })
  })
})
