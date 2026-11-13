import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema } from './openapi'
import { fixture, source } from './test-fixtures'

/**
 * Core's witness documents `withCount` on reading, creating and updating one article, with the
 * relations each can count and no `_self_`, and moves the atomic relationship operations'
 * identifiers into components. A tool offers `withCount` only to count a collection, so a
 * single-resource tool takes none, and the Atomic Operations endpoint is never a tool.
 */
describe('generator contract 35 (single-resource counts)', () => {
  const mcp = createJsonApiMcp(fixture('contract-witness'))
  const properties = (name: string): Record<string, JsonSchema> =>
    mcp.tools.find((t) => t.name === name)!.inputSchema['properties'] as Record<string, JsonSchema>

  it('reads the witness', () => {
    expect(source('contract-witness').document.info?.['x-generator']?.contract).toBe(37)
    expect(mcp.contract).toBe(37)
  })

  it('offers withCount on a collection tool and on no single-resource tool', () => {
    expect(properties('articles_list')).toHaveProperty('withCount')
    for (const name of ['articles_get', 'articles_create', 'articles_update']) {
      expect(properties(name)).not.toHaveProperty('withCount')
    }
  })

  it('builds no tool for the Atomic Operations endpoint', () => {
    expect(mcp.tools.map((t) => t.name).filter((name) => name.includes('operations'))).toEqual([])
  })
})
