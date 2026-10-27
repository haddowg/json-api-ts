import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import { JsonApiError } from './errors'
import { type ActionLocation, isActionLocation } from './location'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'

// Shaped like core's contract-17 witness: `download` answers only with a URL, `revision` with an
// article or a URL, and `archive` is a bare 303 the transport follows.
const descriptor = {
  articles: {
    attributes: { title: 'string' },
    relations: {},
    paths: { fetchOne: '/articles/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    actions: {
      download: {
        scope: 'resource',
        path: '/articles/{id}/-actions/download',
        method: 'GET',
        input: 'none',
        output: 'location',
        location: { mediaType: 'text/csv' },
        readOnly: true,
      },
      revision: {
        scope: 'resource',
        path: '/articles/{id}/-actions/revision',
        method: 'GET',
        input: 'none',
        output: 'document',
        outputType: 'articles',
        outputCardinality: 'one',
        location: { mediaType: 'application/octet-stream' },
      },
      archive: {
        scope: 'collection',
        path: '/articles/-actions/archive',
        method: 'GET',
        input: 'none',
        output: 'none',
      },
    },
  },
} as const satisfies ApiDescriptor

type Attributes = { articles: { title: string } }

function recorder(reply: (req: TransportRequest) => TransportResponse) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    return reply(req)
  }
  return { requests, transport }
}

const ok = (doc: unknown): TransportResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(doc),
})

const client = (transport: (req: TransportRequest) => Promise<TransportResponse>) =>
  createClient<typeof descriptor, Attributes>(descriptor, { baseUrl: BASE, transport })

const locationDocument = (location: Record<string, unknown>, expiresAt: string | null = null) => ({
  links: { self: `${BASE}/articles/1/-actions/download`, location },
  meta: { expiresAt },
  jsonapi: { version: '1.1' },
})

describe('actions that answer with a URL', () => {
  it('asks for JSON:API and returns the location without following it', async () => {
    const { requests, transport } = recorder(() =>
      ok(
        locationDocument(
          {
            href: 'https://storage.example/1.csv?signature=abc',
            type: 'text/csv',
            meta: { expiresAt: '2026-10-27T12:00:00+00:00' },
          },
          '2026-10-27T12:00:00+00:00',
        ),
      ),
    )
    const location = await client(transport).articles.id('1').actions.download()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.method).toBe('GET')
    expect(requests[0]!.url).toBe(`${BASE}/articles/1/-actions/download`)
    expect(requests[0]!.headers['Accept']).toBe('application/vnd.api+json')
    expect(location).toEqual({
      url: 'https://storage.example/1.csv?signature=abc',
      type: 'text/csv',
      expiresAt: '2026-10-27T12:00:00+00:00',
    })
    expectTypeOf(location).toEqualTypeOf<ActionLocation>()
  })

  it('leaves expiresAt out for a URL that does not expire', async () => {
    const { transport } = recorder(() =>
      ok(locationDocument({ href: 'https://storage.example/1.csv', type: 'text/csv' })),
    )
    const location = await client(transport).articles.id('1').actions.download()
    expect(location).toEqual({ url: 'https://storage.example/1.csv', type: 'text/csv' })
    expect('expiresAt' in location).toBe(false)
  })

  it("takes the type the server names over the declared one, and the declared one when it's missing", async () => {
    const named = recorder(() =>
      ok(locationDocument({ href: 'https://storage.example/1.pdf', type: 'application/pdf' })),
    )
    expect((await client(named.transport).articles.id('1').actions.download()).type).toBe(
      'application/pdf',
    )
    const unnamed = recorder(() => ok(locationDocument({ href: 'https://storage.example/1.csv' })))
    expect((await client(unnamed.transport).articles.id('1').actions.download()).type).toBe(
      'text/csv',
    )
  })

  it('reads the top-level expiry when the link carries none', async () => {
    const { transport } = recorder(() =>
      ok(
        locationDocument(
          { href: 'https://storage.example/1.csv', type: 'text/csv' },
          '2030-01-01T00:00:00+00:00',
        ),
      ),
    )
    const location = await client(transport).articles.id('1').actions.download()
    expect(location.expiresAt).toBe('2030-01-01T00:00:00+00:00')
  })

  it('throws when a location-only action answers with something else', async () => {
    const { transport } = recorder(() => ok({ meta: { expiresAt: null } }))
    await expect(client(transport).articles.id('1').actions.download()).rejects.toThrow(
      'without the location document it declares',
    )
  })

  it('keeps errors as JsonApiError', async () => {
    const { transport } = recorder(() => ({
      status: 404,
      headers: {},
      body: JSON.stringify({ errors: [{ status: '404', code: 'RESOURCE_NOT_FOUND' }] }),
    }))
    await expect(client(transport).articles.id('9').actions.download()).rejects.toBeInstanceOf(
      JsonApiError,
    )
  })

  describe('an action answering with a resource or a URL', () => {
    it('materialises the resource document', async () => {
      const { transport } = recorder(() =>
        ok({ data: { type: 'articles', id: '1', attributes: { title: 'Hello' } } }),
      )
      const result = await client(transport).articles.id('1').actions.revision()
      expect(isActionLocation(result)).toBe(false)
      if (!isActionLocation(result)) {
        expect(result.title).toBe('Hello')
        expectTypeOf(result.title).toEqualTypeOf<string>()
      }
    })

    it('returns the location for a location document', async () => {
      const { transport } = recorder(() =>
        ok(locationDocument({ href: 'https://storage.example/1.bin' })),
      )
      const result = await client(transport).articles.id('1').actions.revision()
      expect(result).toEqual({
        url: 'https://storage.example/1.bin',
        type: 'application/octet-stream',
      })
      expect(isActionLocation(result)).toBe(true)
      if (isActionLocation(result)) {
        expectTypeOf(result).toEqualTypeOf<ActionLocation>()
      }
    })
  })

  it('leaves a bare 303 action as it was', async () => {
    const { requests, transport } = recorder(() => ({ status: 204, headers: {}, body: '' }))
    const result = await client(transport).articles.actions.archive()
    expect(result).toBeUndefined()
    expect(requests[0]!.headers['Accept']).toBe('application/vnd.api+json')
    expectTypeOf(result).toEqualTypeOf<void>()
  })
})

describe('isActionLocation', () => {
  it('tells a location from a resource', () => {
    expect(isActionLocation({ url: 'https://x', type: 'text/csv' })).toBe(true)
    expect(isActionLocation({ id: '1', type: 'articles', url: 'https://x' })).toBe(false)
    expect(isActionLocation(null)).toBe(false)
    expect(isActionLocation([])).toBe(false)
  })
})
