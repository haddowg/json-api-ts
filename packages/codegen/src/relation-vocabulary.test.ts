import { readFileSync } from 'node:fs'
import type { TransportRequest } from '@haddowg/json-api-client'
import { describe, expect, it } from 'vitest'
import { createClient as createWitnessClient } from '../test/generated/contract-witness.client.gen'
import { createClient as createCatalogClient } from '../test/generated/music-catalog.client.gen'
import { buildDescriptor } from './build-descriptor'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { type DocumentName, documentPath } from '../test/documents'

function load(name: DocumentName): OpenApiDocument {
  return JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument
}

const witness = load('contract-witness.json')
const catalog = load('music-catalog.openapi.json')

/** Whether a parameter is one of a read's sorts or filters. */
function queryParam(name: string | undefined): boolean {
  return name === 'sort' || name === 'filter' || (name?.startsWith('filter[') ?? false)
}

/** The block of an emitted relation, from its key to the next relation at the same depth. */
function relationBlock(source: string, type: string, relation: string): string {
  const from = source.indexOf(`\n      ${relation}: {`, source.indexOf(`\n  ${type}: {`))
  return source.slice(from, source.indexOf('\n      },', from))
}

function recording(body: unknown) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest) => {
    requests.push(req)
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }
  return { requests, transport, urls: () => requests.map((req) => decodeURIComponent(req.url)) }
}

/** The relations of a descriptor that record their own sorts or filters, monomorphic ones only. */
function ownVocabularies(descriptor: ReturnType<typeof buildDescriptor>): string[] {
  return Object.entries(descriptor).flatMap(([type, spec]) =>
    Object.entries(spec.relations)
      .filter(([, relation]) => relation.polymorphic !== true)
      .filter(([, relation]) => relation.sortable ?? relation.filterable)
      .map(([name]) => `${type}.${name}`),
  )
}

describe("a monomorphic relation's own sorts and filters (contract witness)", () => {
  const descriptor = buildDescriptor(witness)
  const source = emit(witness, descriptor)
  const tags = descriptor['articles']!.relations['tags']!

  it('records the `label` sort the tags collection does not offer', () => {
    expect(descriptor['tags']!.sortable).toEqual(['id', '-id'])
    expect(tags.sortable).toEqual(['id', '-id', 'label', '-label'])
  })

  it('records the filters of the related read, which takes `label` as no list and no defaults', () => {
    expect(descriptor['tags']!.listFilters).toEqual(['label'])
    expect(tags.filterable).toEqual(['color', 'excludeId', 'label'])
    expect(tags.listFilters).toBeUndefined()
  })

  it('records nothing for a relation whose reads match its related type', () => {
    expect(ownVocabularies(descriptor)).toEqual(['articles.tags'])
  })

  it("documents the relation's described sort and leaves out the collection's defaults", () => {
    const block = relationBlock(source, 'articles', 'tags')
    expect(block).toContain(
      '        /**\n         * What each sort orders by, in either direction:\n         * - `label`: Alphabetical by label.\n         */\n        sortable: [',
    )
    expect(block).not.toContain('defaults to')
  })

  it('records nothing once the related read takes what the collection read takes', () => {
    const doc = structuredClone(witness)
    const collection = doc.paths!['/tags']!.get!.parameters!
    for (const path of ['/articles/{id}/tags', '/articles/{id}/relationships/tags']) {
      const read = doc.paths![path]!.get!
      read.parameters = [
        ...read.parameters!.filter((param) => !queryParam(param.name)),
        ...collection.filter((param) => queryParam(param.name)),
      ]
    }
    const relation = buildDescriptor(doc)['articles']!.relations['tags']!
    expect(relation.sortable).toBeUndefined()
    expect(relation.filterable).toBeUndefined()
  })

  it("sends the relation's sort and its `label` filter as its own read takes them", async () => {
    const { transport, urls } = recording({ data: [] })
    const client = createWitnessClient({ baseUrl: 'https://api.example.com', transport })
    await client.articles.id('art-1').tags.related({ sort: '-label', filter: { label: ['php'] } })
    await client.tags.list({ filter: { label: ['php'] } })
    expect(urls()).toEqual([
      'https://api.example.com/articles/art-1/tags?filter[label]=php&sort=-label',
      'https://api.example.com/tags?filter[label][]=php',
    ])
  })

  it("types the relation's reads and its relatedQuery entry from its own sorts", async () => {
    const { transport } = recording({ data: [] })
    const client = createWitnessClient({ baseUrl: 'https://api.example.com', transport })
    await client.articles.list({ include: ['tags'], relatedQuery: { tags: { sort: 'label' } } })
    // @ts-expect-error — `title` is not a sort of the relation.
    await client.articles.id('art-1').tags.related({ sort: 'title' })
    // @ts-expect-error — `title` is not a sort of the relation.
    await client.articles.list({ include: ['tags'], relatedQuery: { tags: { sort: 'title' } } })
  })
})

describe("a monomorphic relation's own sorts and filters (music catalog)", () => {
  const descriptor = buildDescriptor(catalog)
  const source = emit(catalog, descriptor)

  it('records the reads that differ from their related type', () => {
    expect(ownVocabularies(descriptor)).toEqual([
      'albums.artist',
      'albums.tracklist',
      'albums.tracks',
      'playlists.orderedTracks',
    ])
  })

  it("records the tracks relation's `duration` sort, which the tracks collection lacks", () => {
    expect(descriptor['tracks']!.sortable).not.toContain('duration')
    expect(descriptor['albums']!.relations['tracks']!.sortable).toEqual([
      'title',
      '-title',
      'trackNumber',
      '-trackNumber',
      'duration',
      '-duration',
    ])
    expect(relationBlock(source, 'albums', 'tracks')).toContain(
      "         * What each sort orders by, in either direction:\n         * - `duration`: The track's length in seconds.\n         */\n        sortable: [",
    )
  })

  it('records the filters of a relation that drops a default, without naming it', () => {
    const tracklist = descriptor['albums']!.relations['tracklist']!
    expect(tracklist.sortable).toBeUndefined()
    expect(tracklist.filterable).toEqual(descriptor['tracks']!.filterable)
    expect(relationBlock(source, 'albums', 'tracklist')).not.toContain('defaults to')
    expect(relationBlock(source, 'albums', 'tracks')).toContain(
      '        /** The `explicit` filter defaults to `false`. */\n        filterable: [',
    )
  })

  it("types and sends the relation's own sort", async () => {
    const { transport, urls } = recording({ data: [] })
    const client = createCatalogClient({ baseUrl: 'https://api.example.com', transport })
    await client.albums.id('1').tracks.related({ sort: '-duration' })
    await client.albums.list({
      include: ['tracks'],
      relatedQuery: { tracks: { sort: 'duration' } },
    })
    // @ts-expect-error — `name` is not a sort of the tracks relation.
    await client.albums.id('1').tracks.related({ sort: 'name' })
    expect(urls()[0]).toBe('https://api.example.com/albums/1/tracks?sort=-duration')
  })
})
