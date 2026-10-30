import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import { fixture } from './test-fixtures'
import type { JsonSchema } from './openapi'

describe('generator contract 18 (shared links components)', () => {
  const mcp = createJsonApiMcp(fixture('contract-witness'))

  it('reads the witness', () => {
    expect(mcp.contract).toBe(18)
  })

  it('leaves no reference to the document in any tool schema', () => {
    for (const tool of mcp.tools) {
      const schemas = JSON.stringify([tool.inputSchema, tool.outputSchema])
      expect(schemas, tool.name).not.toContain('#/components/')
    }
  })

  it('keeps only named links on a resource, and only pagination links on a collection', () => {
    const get = mcp.tools.find((t) => t.name === 'images_get')!
    const images = (get.outputSchema!['$defs'] as Record<string, JsonSchema>)['images']!
    const links = (images['properties'] as Record<string, JsonSchema>)['links']!
    expect(Object.keys(links['properties'] as object)).toEqual(['download', 'thumbnail'])
    const list = mcp.tools.find((t) => t.name === 'images_list')!
    const pages = (list.outputSchema!['properties'] as Record<string, { properties: object }>)[
      'links'
    ]!
    expect(Object.keys(pages.properties)).toEqual(['first', 'prev', 'next', 'last'])
  })
})
