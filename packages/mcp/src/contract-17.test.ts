import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import { fakeTransport, fixture } from './test-fixtures'
import type { JsonSchema } from './openapi'

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

const data = (branch: JsonSchema) => (branch['properties'] as Record<string, JsonSchema>)['data']!

describe('generator contract 17', () => {
  const mcp = createJsonApiMcp(fixture('contract-witness'))
  const tool = (name: string) => mcp.tools.find((t) => t.name === name)!

  it('reads the witness', () => {
    expect(mcp.contract).toBe(18)
  })

  describe('an action that answers with a URL', () => {
    it('outputs the URL, its type and its expiry', () => {
      expect(tool('articles_download').outputSchema).toEqual({
        type: 'object',
        properties: {
          data: {
            type: 'object',
            description:
              'The URL the action produced, such as a short-lived download link. The tool does not fetch it.',
            properties: {
              url: { type: 'string', format: 'uri-reference', description: 'The URL.' },
              type: {
                type: 'string',
                description: 'The media type the URL serves. The action declares `text/csv`.',
              },
              expiresAt: {
                type: 'string',
                format: 'date-time',
                description: 'When the URL stops working. Absent when it does not expire.',
              },
            },
            required: ['url', 'type'],
            additionalProperties: false,
          },
        },
        required: ['data'],
      })
    })

    it('takes its read-only hint from x-safety', () => {
      expect(tool('articles_download').annotations).toEqual({ readOnlyHint: true })
    })

    it('returns the URL as structured content and never fetches it', async () => {
      const { transport, requests } = fakeTransport(() => ({ json: locationDocument }))
      const session = await createJsonApiMcp({
        ...fixture('contract-witness'),
        transport,
      }).forRequest({ context: {} })
      const result = await session.callTool('articles_download', { id: 'art-1' })
      expect(result.isError).toBeUndefined()
      expect(result.structuredContent).toEqual({
        data: {
          url: 'https://storage.example.com/1.csv?signature=abc',
          type: 'text/csv',
          expiresAt: '2030-01-01T00:00:00+00:00',
        },
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]!.url).toBe('https://api.example.com/articles/art-1/-actions/download')
      expect(requests[0]!.headers['Accept']).toBe('application/vnd.api+json')
    })

    it('leaves expiresAt out when the URL does not expire', async () => {
      const { transport } = fakeTransport(() => ({
        json: {
          links: { location: { href: 'https://storage.example.com/1.csv', type: 'text/csv' } },
          meta: { expiresAt: null },
        },
      }))
      const session = await createJsonApiMcp({
        ...fixture('contract-witness'),
        transport,
      }).forRequest({ context: {} })
      const result = await session.callTool('articles_download', { id: 'art-1' })
      expect(result.structuredContent).toEqual({
        data: { url: 'https://storage.example.com/1.csv', type: 'text/csv' },
      })
    })
  })

  describe('an action that answers with a resource or a URL', () => {
    it('outputs either', () => {
      const output = tool('articles_revision').outputSchema as unknown as JsonSchema & {
        anyOf: JsonSchema[]
      }
      expect(output['type']).toBe('object')
      expect(output.anyOf).toHaveLength(2)
      expect(data(output.anyOf[0]!)['anyOf']).toEqual([
        { $ref: '#/$defs/articles' },
        { type: 'null' },
      ])
      expect(data(output.anyOf[1]!)['required']).toEqual(['url', 'type'])
      expect(Object.keys(output['$defs'] as object)).toContain('articles')
    })

    it('returns whichever the server sent', async () => {
      let body: unknown = { data: { type: 'articles', id: 'art-1', attributes: { title: 'Hi' } } }
      const { transport } = fakeTransport(() => ({ json: body }))
      const session = await createJsonApiMcp({
        ...fixture('contract-witness'),
        transport,
      }).forRequest({ context: {} })
      const args = Object.fromEntries(
        Object.keys(
          (
            tool('articles_revision').inputSchema as unknown as {
              properties: Record<string, unknown>
            }
          ).properties,
        ).map((key) => [key, null]),
      ) as Record<string, unknown>
      const resource = await session.callTool('articles_revision', { ...args, id: 'art-1' })
      expect(resource.structuredContent).toMatchObject({ data: { id: 'art-1', type: 'articles' } })
      body = locationDocument
      const url = await session.callTool('articles_revision', { ...args, id: 'art-1' })
      expect(url.structuredContent).toEqual({
        data: {
          url: 'https://storage.example.com/1.csv?signature=abc',
          type: 'text/csv',
          expiresAt: '2030-01-01T00:00:00+00:00',
        },
      })
    })
  })

  it('leaves a bare 303 action without an output schema', () => {
    expect(tool('articles_archive').outputSchema).toBeUndefined()
  })
})

describe('the music catalogue at contract 17', () => {
  it('returns the URL from albums_download', async () => {
    const { transport, requests } = fakeTransport(() => ({
      json: {
        links: {
          location: {
            href: 'https://storage.example.com/downloads/1.csv?signature=abc',
            type: 'text/csv',
            meta: { expiresAt: '2030-01-01T00:00:00+00:00' },
          },
        },
        meta: { expiresAt: '2030-01-01T00:00:00+00:00' },
      },
    }))
    const mcp = createJsonApiMcp({ ...fixture('music-catalog'), transport })
    expect(mcp.contract).toBeGreaterThanOrEqual(17)
    const download = mcp.tools.find((t) => t.name === 'albums_download')!
    expect(download.annotations).toEqual({ readOnlyHint: true })
    expect(download.outputSchema?.['required']).toEqual(['data'])
    const session = await mcp.forRequest({ context: {} })
    const result = await session.callTool('albums_download', { id: '1' })
    expect(result.structuredContent).toEqual({
      data: {
        url: 'https://storage.example.com/downloads/1.csv?signature=abc',
        type: 'text/csv',
        expiresAt: '2030-01-01T00:00:00+00:00',
      },
    })
    expect(requests[0]!.method).toBe('GET')
    expect(requests[0]!.url).toMatch(/\/albums\/1\/-actions\/download$/)
  })
})
