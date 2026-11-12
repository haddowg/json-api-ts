import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema } from './openapi'
import { fakeTransport, fixture } from './test-fixtures'

const argument = (
  mcp: ReturnType<typeof createJsonApiMcp>,
  tool: string,
  name: string,
): JsonSchema => {
  const schema = mcp.tools.find((t) => t.name === tool)!.inputSchema as JsonSchema
  return (schema['properties'] as Record<string, JsonSchema>)[name]!
}

const writeSources: JsonSchema = {
  type: ['array', 'null'],
  items: {
    type: 'object',
    properties: {
      href: { type: 'string', description: 'At least 1 characters. Format: uri.' },
      retrievedAt: { type: ['string', 'null'], format: 'date-time' },
    },
    required: ['href', 'retrievedAt'],
    additionalProperties: false,
  },
  description: 'At most 5 items.',
}

const writeSteps: JsonSchema = {
  type: ['array', 'null'],
  items: {
    anyOf: [
      {
        type: 'object',
        properties: { operation: { type: 'string', enum: ['trim'] } },
        required: ['operation'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          params: {
            type: ['object', 'null'],
            properties: {
              find: { type: ['string', 'null'] },
              replace: { type: ['string', 'null'] },
            },
            required: ['find', 'replace'],
            additionalProperties: false,
          },
          operation: { type: 'string', enum: ['find_replace'] },
        },
        required: ['params', 'operation'],
        additionalProperties: false,
      },
    ],
  },
  description: 'At most 50 items.',
}

describe('generator contract 21 (structured list elements)', () => {
  const mcp = createJsonApiMcp(fixture('contract-witness'))

  it('reads the witness', () => {
    expect(mcp.contract).toBe(35)
  })

  it.each(['articles_create', 'articles_update'])(
    'gives %s a closed object schema for each list element',
    (tool) => {
      expect(argument(mcp, tool, 'sources')).toEqual(writeSources)
    },
  )

  it.each(['articles_create', 'articles_update'])(
    'gives %s an anyOf of closed branches keyed by the discriminator enum',
    (tool) => {
      const steps = argument(mcp, tool, 'steps')
      expect(steps).toEqual(writeSteps)
      expect(JSON.stringify(steps)).not.toMatch(/"(oneOf|discriminator|maxItems)"/)
    },
  )

  it('sends the elements, dropping a null the conversion added to an object element', async () => {
    const { transport, requests } = fakeTransport(() => ({
      status: 201,
      json: { data: { type: 'articles', id: 'art-1', attributes: { title: 'Hello' } } },
    }))
    const session = await createJsonApiMcp({
      ...fixture('contract-witness'),
      transport,
    }).forRequest({ context: {} })
    await session.callTool('articles_create', {
      title: 'Hello',
      sources: [{ href: 'https://example.com/a', retrievedAt: null }],
      steps: [
        { operation: 'trim' },
        { operation: 'find_replace', params: { find: 'colour', replace: 'color' } },
      ],
    })
    const body = JSON.parse(requests[0]!.body!) as { data: { attributes: unknown } }
    expect(body.data.attributes).toEqual({
      title: 'Hello',
      sources: [{ href: 'https://example.com/a' }],
      steps: [
        { operation: 'trim' },
        { operation: 'find_replace', params: { find: 'colour', replace: 'color' } },
      ],
    })
  })
})
