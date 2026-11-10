import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema } from './openapi'
import { fakeTransport, modelOf, source } from './test-fixtures'

/**
 * Core's witness declares two actions answering `201 Created` with the article they created:
 * `duplicate` declares only that document, `restore` declares a `200` document beside it.
 */
const { model } = modelOf(source('contract-witness').document)

describe('generator contract 26 (actions answering 201 Created)', () => {
  const mcp = createJsonApiMcp({ model })
  const tool = (name: string) => mcp.tools.find((t) => t.name === name)!

  it('reads the document', () => {
    expect(mcp.contract).toBe(31)
  })

  it('describes the created resource as the tool output', () => {
    for (const name of ['articles_duplicate', 'articles_restore']) {
      const data = (tool(name).outputSchema!['properties'] as Record<string, JsonSchema>)['data']
      expect(data).toEqual({
        anyOf: [{ $ref: '#/$defs/articles' }, { type: 'null' }],
        description: 'The resource the action returned.',
      })
    }
  })

  it('returns the created resource from a 201', async () => {
    const { transport, requests } = fakeTransport(() => ({
      status: 201,
      json: { data: { type: 'articles', id: 'art-2', attributes: { title: 'Copy' } } },
    }))
    const tools = await createJsonApiMcp({ model, transport }).forRequest({ context: undefined })
    const result = await tools.callTool('articles_duplicate', { id: 'art-1' })
    expect(result.isError).toBeUndefined()
    expect(requests[0]!.method).toBe('POST')
    expect(requests[0]!.url).toMatch(/\/articles\/art-1\/-actions\/duplicate$/)
    expect(JSON.stringify(result.structuredContent)).toContain('"id":"art-2"')
  })
})
