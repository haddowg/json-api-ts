import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  type ActionLocation,
  isActionLocation,
  type TransportRequest,
} from '@haddowg/json-api-client'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from '../test/generated/contract-witness.client.gen'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'

function load(): OpenApiDocument {
  const path = fileURLToPath(
    new URL('../test/fixtures/contract-witness.openapi.json', import.meta.url),
  )
  return JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument
}

const witness = load()
const descriptor = buildDescriptor(witness)
const actions = descriptor['articles']!.actions!

const locationDocument = {
  links: {
    self: 'https://api.example.com/articles/art-1/-actions/download',
    location: {
      href: 'https://storage.example.com/1.csv?signature=abc',
      type: 'text/csv',
      meta: { expiresAt: '2030-01-01T00:00:00+00:00' },
    },
  },
  meta: { expiresAt: '2030-01-01T00:00:00+00:00' },
}

function witnessClient(body: unknown) {
  const requests: TransportRequest[] = []
  const client = createClient({
    baseUrl: 'https://api.example.com',
    transport: async (req) => {
      requests.push(req)
      return { status: 200, headers: {}, body: JSON.stringify(body) }
    },
  })
  return { client, requests }
}

describe('generator contract 17 (actions that answer with a URL)', () => {
  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(18)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('marks an action answering only with a URL, with its declared media type', () => {
    expect(actions['download']).toEqual({
      scope: 'resource',
      path: '/articles/{id}/-actions/download',
      input: 'none',
      output: 'location',
      method: 'GET',
      readOnly: true,
      location: { mediaType: 'text/csv' },
    })
  })

  it('keeps the resource output of an action that answers with a resource or a URL', () => {
    expect(actions['revision']).toMatchObject({
      output: 'document',
      outputType: 'articles',
      outputCardinality: 'one',
      location: { mediaType: 'application/octet-stream' },
    })
  })

  it('leaves a bare 303 action as it was', () => {
    expect(actions['archive']).toEqual({
      scope: 'collection',
      path: '/articles/-actions/archive',
      input: 'none',
      output: 'none',
      method: 'GET',
    })
  })

  it('marks no other action', () => {
    const marked = Object.entries(descriptor).flatMap(([type, resource]) =>
      Object.entries(resource.actions ?? {})
        .filter(([, action]) => action.location !== undefined)
        .map(([name]) => `${type}.${name}`),
    )
    expect(marked).toEqual(['articles.download', 'articles.revision'])
  })

  it('says what the method returns in its JSDoc', () => {
    const source = emit(witness, descriptor)
    expect(source).toContain(
      "       * Returns a URL serving `text/csv` as an `ActionLocation`. The client doesn't follow it.",
    )
    expect(source).toContain(
      'May return a URL serving `application/octet-stream` instead, as an `ActionLocation`.',
    )
  })

  it('falls back to application/octet-stream when the schema fixes no type', () => {
    const doc = load()
    const ok = doc.paths!['/articles/{id}/-actions/download']!.get!.responses!['200']!
    ok.content!['application/vnd.api+json']!.schema = {
      $ref: '#/components/schemas/LocationDocument',
    }
    expect(buildDescriptor(doc)['articles']!.actions!['download']).toMatchObject({
      output: 'location',
      location: { mediaType: 'application/octet-stream' },
    })
  })

  describe('the generated client', () => {
    it('returns the URL from download without following it', async () => {
      const { client, requests } = witnessClient(locationDocument)
      const location = await client.articles.id('art-1').actions.download()
      expectTypeOf(location).toEqualTypeOf<ActionLocation>()
      expect(location).toEqual({
        url: 'https://storage.example.com/1.csv?signature=abc',
        type: 'text/csv',
        expiresAt: '2030-01-01T00:00:00+00:00',
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]!.headers['Accept']).toBe('application/vnd.api+json')
    })

    it('returns an article or a URL from revision', async () => {
      const article = witnessClient({
        data: { type: 'articles', id: 'art-1', attributes: { title: 'Hello' } },
      })
      const result = await article.client.articles.id('art-1').actions.revision()
      expect(isActionLocation(result)).toBe(false)
      if (!isActionLocation(result)) {
        expectTypeOf(result.title).toEqualTypeOf<string>()
        expect(result.title).toBe('Hello')
      }
      const url = witnessClient({
        ...locationDocument,
        links: { location: { href: 'https://storage.example.com/1', type: 'application/zip' } },
        meta: { expiresAt: null },
      })
      expect(await url.client.articles.id('art-1').actions.revision()).toEqual({
        url: 'https://storage.example.com/1',
        type: 'application/zip',
      })
    })

    it('types a bare 303 action as before', () => {
      const { client } = witnessClient({})
      expectTypeOf(client.articles.actions.archive).returns.toEqualTypeOf<Promise<void>>()
    })
  })
})

describe('the music catalogue at contract 17', () => {
  const path = fileURLToPath(
    new URL('../test/fixtures/music-catalog.openapi.json', import.meta.url),
  )
  const music = JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument

  it('marks the albums download action as answering with a CSV URL', () => {
    expect(music.info?.['x-generator']?.contract).toBeGreaterThanOrEqual(17)
    expect(checkContract(music)).toBeUndefined()
    expect(buildDescriptor(music)['albums']!.actions?.['download']).toEqual({
      scope: 'resource',
      path: '/albums/{id}/-actions/download',
      input: 'none',
      output: 'location',
      method: 'GET',
      readOnly: true,
      location: { mediaType: 'text/csv' },
    })
  })
})
