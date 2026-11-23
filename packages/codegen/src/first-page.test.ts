import { readFileSync } from 'node:fs'
import { loadAll, type TransportRequest, type TransportResponse } from '@haddowg/json-api-client'
import { describe, expect, it } from 'vitest'
import { createClient as catalogClient } from '../test/generated/music-catalog.client.gen'
import { createClient as witnessClient } from '../test/generated/contract-witness.client.gen'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'

type Json = Record<string, unknown>

const load = (name: 'contract-witness.json' | 'music-catalog.openapi.json') =>
  JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument
const witness = load('contract-witness.json')
const catalog = load('music-catalog.openapi.json')

/** The worked `200` example an operation declares, a whole JSON:API document. */
function example(doc: OpenApiDocument, path: string): Json {
  const response = doc.paths![path]!.get!.responses!['200'] as {
    content: Record<string, { example: Json }>
  }
  return structuredClone(response.content['application/vnd.api+json']!.example)
}

const href = (link: unknown): string =>
  typeof link === 'string' ? link : ((link as { href: string }).href as string)

/** A transport answering each URL from a map, recording what it sent. */
function replay(routes: Record<string, Json>) {
  const requests: string[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req.url)
    const body = routes[req.url]
    if (body === undefined) {
      throw new Error(`unmapped request: ${req.url}`)
    }
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }
  return { transport, requests }
}

/**
 * Core renders a paginated to-many's linkage, included or declared withData, as the first page of
 * its members, with the page links and a counted page's total on the relationship object. The
 * document only says so in a description, so the contract stays where it was.
 */
describe('a rendered to-many is its first page', () => {
  it('describes each paginated relationship object as a first page without a contract bump', () => {
    for (const name of ['ArticlesTagsRelationship', 'ArticlesSponsorsRelationship']) {
      expect(witness.components!.schemas![name]!.description).toContain(
        "is the first page of the relationship's members",
      )
    }
    expect(catalog.components!.schemas!['AlbumsTracksRelationship']!.description).toContain(
      'first page',
    )
    expect(checkContract(witness)).toBeUndefined()
    expect(witness.info?.['x-generator']?.contract).toBe(45)
  })

  it("pages an included to-many built from the witness's own tags page", async () => {
    // The related read's second page supplies the members and the page query core links with.
    const page = example(witness, '/articles/{id}/tags')
    const links = page['links'] as Json
    const related = 'https://api.example.com/articles/art-1/tags'
    const relationship = 'https://api.example.com/articles/art-1/relationships/tags'
    const toRelationship = (link: unknown) => href(link).replace(related, relationship)
    const members = page['data'] as Json[]
    const article = {
      data: {
        type: 'articles',
        id: 'art-1',
        attributes: { title: 'Hello' },
        relationships: {
          tags: {
            links: {
              self: relationship,
              related,
              first: toRelationship(links['first']),
              next: toRelationship(links['next']),
              last: toRelationship(links['last']),
            },
            meta: { total: (page['meta'] as Json)['total'] },
            data: members.map((member) => ({ type: member['type'], id: member['id'] })),
          },
        },
      },
      included: members,
    }
    const last = { ...page, links: { self: href(links['next']) } }
    const { transport, requests } = replay({
      'https://api.example.com/articles/art-1?include=tags': article,
      [href(links['next'])]: last,
    })
    const client = witnessClient({ baseUrl: 'https://api.example.com', transport })

    const read = await client.articles.get('art-1', { include: ['tags'] })
    expect(read.tags.map((tag) => tag.label)).toEqual(['php'])
    expect(read.tags.$count).toBe(75)
    expect(read.tags.$page.links.next).toBe(toRelationship(links['next']))

    // The next page is read from the related endpoint with the same query, as resources.
    const next = await read.tags.$next()
    expect(requests[1]).toBe(href(links['next']))
    expect(next?.map((tag) => tag.label)).toEqual(['php'])
    expect(await loadAll(read.tags)).toHaveLength(2)
  })

  it("reads the catalog's relationship page as linkage, its links counted", async () => {
    const page = example(catalog, '/albums/{id}/relationships/tracks')
    const links = page['links'] as Json
    const { transport, requests } = replay({
      'https://music.example/albums/1/relationships/tracks': page,
      [href(links['next'])]: { ...page, links: { self: href(links['next']) } },
    })
    const client = catalogClient({ baseUrl: 'https://music.example', transport })

    const linkage = await client.albums.id('1').rel('tracks').get()
    expect(linkage.$page.links.next).toContain('withCount=_self_')
    expect(linkage.$meta?.['total']).toBe(10)
    const next = await linkage.$next()
    expect(requests[1]).toBe(href(links['next']))
    expect(next).toEqual([{ type: 'tracks', id: '1' }])
  })

  it("carries a relationship object's description onto the relation in the generated client", () => {
    const source = emit(witness, buildDescriptor(witness))
    const relationDoc = (type: string, relation: string): string => {
      const start = source.indexOf(`  ${type}: {\n    attributes:`)
      const relations = source.indexOf('    relations: {\n', start)
      const at = source.indexOf(`\n      ${relation}: {\n`, relations)
      const docStart = source.lastIndexOf('{\n', at)
      return source.slice(docStart, at)
    }
    expect(relationDoc('articles', 'tags')).toContain(
      "Its `data`, when present, is the first page of the relationship's members",
    )
    expect(relationDoc('articles', 'sponsors')).toContain('is the first page')
    // An author's own description of a relationship object rides along the same way.
    expect(relationDoc('articles', 'author')).toContain('Who wrote it.')
    const catalogSource = emit(catalog, buildDescriptor(catalog))
    expect(catalogSource).toContain(
      "      /** Its `data`, when present, is the first page of the relationship's members in the order its related endpoint serves them, its `links` reach the other pages, and a countable relation's `meta.total` is the member count when that page is counted. */\n      playlists: {",
    )
  })
})
