import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import { fixture, source } from './test-fixtures'

/**
 * Core documents `relatedQuery` on every operation whose primary data is resources of one type,
 * as a `<Type>RelatedQuery` parameter component per rendered type. A tool's arguments name only
 * the query families it offers, and `relatedQuery` isn't one of them, so no tool takes it.
 */
describe('generator contract 37 (relatedQuery wherever resources of one type answer)', () => {
  it.each(['contract-witness', 'music-catalog'] as const)('reads the %s document', (name) => {
    const { document } = source(name)
    expect(document.info?.['x-generator']?.contract).toBe(38)
    const components = Object.keys(document.components?.parameters ?? {})
    expect(components.some((component) => component.endsWith('RelatedQuery'))).toBe(true)
    expect(components).not.toContain('relatedQuery')
    expect(createJsonApiMcp(fixture(name)).contract).toBe(38)
  })

  it('offers relatedQuery on no tool', () => {
    for (const name of ['contract-witness', 'music-catalog'] as const) {
      for (const tool of createJsonApiMcp(fixture(name)).tools) {
        expect(tool.inputSchema['properties'] ?? {}, tool.name).not.toHaveProperty('relatedQuery')
      }
    }
  })
})
