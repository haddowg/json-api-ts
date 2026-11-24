import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema } from './openapi'
import { modelOf, source } from './test-fixtures'

const { document: witness } = source('contract-witness')

const filterOf = (tool: string): Record<string, JsonSchema> => {
  const found = createJsonApiMcp(modelOf(witness)).tools.find(
    (candidate) => candidate.name === tool,
  )!
  const filter = (found.inputSchema['properties'] as Record<string, JsonSchema>)['filter']!
  return filter['properties'] as Record<string, JsonSchema>
}

/**
 * A comparison or list filter over a `DateTime`, `Date` or `Time` field documents the RFC 3339
 * `format` that field writes. Every model API takes those formats, so a tool's filter argument
 * carries the format to the model.
 */
describe('generator contract 45 (date formats on filter values)', () => {
  it('reads the witness', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(47)
    expect(createJsonApiMcp(modelOf(witness)).contract).toBe(47)
  })

  it("carries a date filter's format into the tool's filter argument", () => {
    expect(filterOf('articles_list')['releasedOn']).toMatchObject({ format: 'date' })
  })

  it("carries a list filter's item format into the tool's filter argument", () => {
    expect(filterOf('articles_list')['publishedOn']).toMatchObject({
      type: ['array', 'null'],
      items: { type: 'string', format: 'date-time' },
    })
  })

  it('carries the format of a filter that reaches a date field through a relation', () => {
    const tags = filterOf('tags_list')
    expect(tags['articleReleasedOn']).toMatchObject({ format: 'date' })
    expect(tags['articlesPublishedAt']).toMatchObject({
      items: { type: 'string', format: 'date-time' },
    })
  })
})
