import { describe, expect, it } from 'vitest'
import { MAXIMUM_CONTRACT } from './contract'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument } from './openapi'
import { modelOf, source } from './test-fixtures'

const { document: pinned } = source('contract-witness')

/**
 * Give every `releasedOn` filter, the witness's comparison filter over a `Date` field, the `date`
 * format and stamp the document 45. Applied to the pinned 2.23.0 witness, this reproduces what core
 * main's projector does to that filter, which no release has published yet. It goes once the pins
 * move to a core release at 45.
 */
function dateFilters(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc)
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (typeof node !== 'object' || node === null) {
      return
    }
    const object = node as Record<string, unknown>
    if (object['name'] === 'filter[releasedOn]' && typeof object['schema'] === 'object') {
      ;(object['schema'] as Record<string, unknown>)['format'] = 'date'
    }
    const filter = (object['properties'] as Record<string, unknown> | undefined)?.['filter']
    const releasedOn = (filter as { properties?: Record<string, unknown> } | undefined)
      ?.properties?.['releasedOn']
    if (typeof releasedOn === 'object' && releasedOn !== null) {
      ;(releasedOn as Record<string, unknown>)['format'] = 'date'
    }
    Object.values(object).forEach(visit)
  }
  visit(copy)
  copy.info!['x-generator'] = { contract: 45 }
  return copy
}

const dated = dateFilters(pinned)
const toolsOf = (doc: OpenApiDocument) => createJsonApiMcp(modelOf(doc)).tools
const filterOf = (doc: OpenApiDocument, tool: string): Record<string, JsonSchema> => {
  const found = toolsOf(doc).find((candidate) => candidate.name === tool)!
  const filter = (found.inputSchema['properties'] as Record<string, JsonSchema>)['filter']!
  return filter['properties'] as Record<string, JsonSchema>
}

/**
 * A comparison or list filter over a `DateTime`, `Date` or `Time` field documents the RFC 3339
 * `format` that field writes. Every model API takes those formats, so a tool's filter argument
 * carries the format to the model, and nothing else about the tools moves.
 */
describe('generator contract 45 (date formats on filter values)', () => {
  it('reads a document stamped 45, and refuses one past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(45)
    expect(createJsonApiMcp(modelOf(dated)).contract).toBe(45)
    const newer = structuredClone(dated)
    newer.info!['x-generator']!.contract = 46
    expect(() => createJsonApiMcp(modelOf(newer))).toThrow('newer than this package reads')
  })

  it("carries a date filter's format into the tool's filter argument", () => {
    expect(filterOf(pinned, 'articles_list')['releasedOn']).not.toHaveProperty('format')
    expect(filterOf(dated, 'articles_list')['releasedOn']).toMatchObject({ format: 'date' })
  })

  it('changes no tool beyond that format', () => {
    const shapes = (doc: OpenApiDocument) =>
      JSON.parse(
        JSON.stringify(
          toolsOf(doc).map(({ name, inputSchema, outputSchema }) => ({
            name,
            inputSchema,
            outputSchema,
          })),
        ).replaceAll(',"format":"date"', ''),
      ) as unknown
    expect(shapes(dated)).toEqual(shapes(pinned))
  })
})
