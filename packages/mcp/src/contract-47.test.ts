import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument } from './openapi'
import { locationOutput } from './outputs'
import { modelOf, source } from './test-fixtures'

const { document: witness } = source('contract-witness')

const outputOf = (doc: OpenApiDocument, tool: string): JsonSchema =>
  createJsonApiMcp(modelOf(doc)).tools.find((candidate) => candidate.name === tool)!
    .outputSchema as unknown as JsonSchema

/**
 * An action whose URL's media type varies declares `application/octet-stream`, and its location
 * document's `type` is any string rather than a `const`. The tool's output keeps the URL's `type`
 * a string, as it was for the fixed type.
 */
describe('generator contract 47 (a location type that varies)', () => {
  it('reads the document', () => {
    expect(createJsonApiMcp(modelOf(witness)).contract).toBe(47)
  })

  it('outputs the location of the declared octet-stream type', () => {
    const output = outputOf(witness, 'articles_revision')['anyOf'] as JsonSchema[]
    expect(output[1]).toEqual(locationOutput('application/octet-stream'))
  })
})
