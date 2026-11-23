import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema } from './openapi'
import { modelOf, source } from './test-fixtures'

const { document: witness } = source('contract-witness')

/**
 * A `Range` or `DateRange` filter refuses any member but `min` and `max`, so its `filter[<key>]`
 * object is closed with `additionalProperties: false`. A tool's filter argument already closes
 * every object, so the tools come out as they did from the open ranges.
 */
describe('generator contract 44 (closed range filters)', () => {
  it('reads the witness', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(45)
    expect(createJsonApiMcp(modelOf(witness)).contract).toBe(45)
  })

  it('takes a range filter as an object of its bounds and nothing else', () => {
    const list = createJsonApiMcp(modelOf(witness)).tools.find(
      (tool) => tool.name === 'articles_list',
    )!
    const filter = (list.inputSchema['properties'] as Record<string, JsonSchema>)['filter']!
    const rating = (filter['properties'] as Record<string, JsonSchema>)['rating']!
    expect(rating).toMatchObject({
      type: ['object', 'null'],
      properties: { min: expect.anything(), max: expect.anything() },
      additionalProperties: false,
    })
  })
})
