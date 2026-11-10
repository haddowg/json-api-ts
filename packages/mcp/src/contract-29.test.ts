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

/**
 * Core's witness declares objects open to members they do not declare. Strict mode closes every
 * object, so each one is taken as JSON text, its description saying what the members take.
 */
describe('generator contract 29 (open objects)', () => {
  const mcp = createJsonApiMcp(fixture('contract-witness'))

  it('reads the witness', () => {
    expect(mcp.contract).toBe(31)
  })

  it.each(['articles_create', 'articles_update'])(
    'takes %s open objects as JSON text describing their members',
    (tool) => {
      expect(argument(mcp, tool, 'labels')).toEqual({
        type: ['string', 'null'],
        description:
          'At most 20 members. Any member is a string. At most 40 characters. Send the value as JSON text.',
      })
      expect(argument(mcp, tool, 'rows')).toEqual({
        type: ['array', 'null'],
        items: {
          type: 'string',
          description:
            'Between 1 and 50 members. Any member other than `Key` is a string or null. At most 200 characters. Send the value as JSON text.',
        },
        description: 'At most 1000 items.',
      })
    },
  )

  it('keeps every input schema closed', () => {
    for (const tool of mcp.tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"additionalProperties":(?!false)/)
    }
  })

  it('sends the parsed members', async () => {
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
      labels: '{"a/b":"x"}',
      rows: ['{"Key":"RFP-123","Vendor":"Acme Media","CPL":"42"}'],
    })
    const body = JSON.parse(requests[0]!.body!) as { data: { attributes: unknown } }
    expect(body.data.attributes).toEqual({
      title: 'Hello',
      labels: { 'a/b': 'x' },
      rows: [{ Key: 'RFP-123', Vendor: 'Acme Media', CPL: '42' }],
    })
  })
})
