import { describe, expect, it } from 'vitest'
import { MAXIMUM_CONTRACT } from './contract'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument } from './openapi'
import { modelOf, source } from './test-fixtures'

const { document: pinned } = source('contract-witness')

/**
 * Close every object of a range filter's `min` and `max` bounds and stamp the document 44. Applied
 * to the pinned 2.22.0 witness, this reproduces the witness core main exports, which no release
 * has published yet. It goes once the pins move to a core release at 44.
 */
function closeRanges(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc)
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (typeof node !== 'object' || node === null) {
      return
    }
    const schema = node as Record<string, unknown>
    const properties = schema['properties']
    if (
      schema['type'] === 'object' &&
      typeof properties === 'object' &&
      properties !== null &&
      Object.keys(properties).length === 2 &&
      'min' in properties &&
      'max' in properties &&
      !('additionalProperties' in schema)
    ) {
      schema['additionalProperties'] = false
    }
    Object.values(schema).forEach(visit)
  }
  visit(copy)
  copy.info!['x-generator'] = { contract: 44 }
  return copy
}

const closed = closeRanges(pinned)
const toolsOf = (doc: OpenApiDocument) => createJsonApiMcp(modelOf(doc)).tools

/**
 * A `Range` or `DateRange` filter refuses any member but `min` and `max`, so its `filter[<key>]`
 * object is closed with `additionalProperties: false`. A tool's filter argument already closes
 * every object, so the tools come out as they did from the open ranges.
 */
describe('generator contract 44 (closed range filters)', () => {
  it('reads a document stamped 44, and refuses one past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(44)
    expect(createJsonApiMcp(modelOf(closed)).contract).toBe(44)
    const newer = structuredClone(closed)
    newer.info!['x-generator']!.contract = 45
    expect(() => createJsonApiMcp(modelOf(newer))).toThrow('newer than this package reads')
  })

  it('takes a range filter as an object of its bounds and nothing else', () => {
    const list = toolsOf(closed).find((tool) => tool.name === 'articles_list')!
    const filter = (list.inputSchema['properties'] as Record<string, JsonSchema>)['filter']!
    const rating = (filter['properties'] as Record<string, JsonSchema>)['rating']!
    expect(rating).toMatchObject({
      type: ['object', 'null'],
      properties: { min: expect.anything(), max: expect.anything() },
      additionalProperties: false,
    })
  })

  it('gives every tool the input and output it had from the open ranges', () => {
    const shapes = (doc: OpenApiDocument) =>
      toolsOf(doc).map(({ name, inputSchema, outputSchema }) => ({
        name,
        inputSchema,
        outputSchema,
      }))
    expect(shapes(closed)).toEqual(shapes(pinned))
  })
})
