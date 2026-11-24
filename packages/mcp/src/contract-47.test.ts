import { describe, expect, it } from 'vitest'
import { MAXIMUM_CONTRACT } from './contract'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument } from './openapi'
import { modelOf, source } from './test-fixtures'

const { document: witness } = source('contract-witness')

/**
 * The witness as a server projects it now: an action declaring `application/octet-stream` leaves
 * its location's `type` open, with the declared type as its example, and the document is stamped
 * 47. No core release carries 47 yet, so this grafts that change onto the pinned witness.
 */
function varying(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc)
  const schema = (copy.paths!['/articles/{id}/-actions/revision']!['get'] as JsonSchema)[
    'responses'
  ] as Record<string, JsonSchema>
  const ok = (schema['200']!['content'] as Record<string, JsonSchema>)['application/vnd.api+json']!
  const arms = (ok['schema'] as JsonSchema)['oneOf'] as JsonSchema[]
  const narrowing = (arms[1]!['allOf'] as JsonSchema[])[1]!
  const links = (narrowing['properties'] as Record<string, JsonSchema>)['links']!
  const location = (links['properties'] as Record<string, JsonSchema>)['location']!
  ;(location['properties'] as Record<string, JsonSchema>)['type'] = {
    type: 'string',
    examples: ['application/octet-stream'],
  }
  copy.info!['x-generator'] = { contract: 47 }
  return copy
}

const outputOf = (doc: OpenApiDocument, tool: string): JsonSchema =>
  createJsonApiMcp(modelOf(doc)).tools.find((candidate) => candidate.name === tool)!
    .outputSchema as unknown as JsonSchema

/**
 * An action whose URL's media type varies declares `application/octet-stream`, and its location
 * document's `type` is any string rather than a `const`. The tool's output keeps the URL's `type`
 * a string, as it was for the fixed type.
 */
describe('generator contract 47 (a location type that varies)', () => {
  const doc = varying(witness)

  it('reads the document, and refuses one past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(47)
    expect(createJsonApiMcp(modelOf(doc)).contract).toBe(47)
    const newer = structuredClone(doc)
    newer.info!['x-generator']!.contract = 48
    expect(() => createJsonApiMcp(modelOf(newer))).toThrow('newer than this package reads')
  })

  it('outputs the same location as for the fixed type', () => {
    expect(outputOf(doc, 'articles_revision')).toEqual(outputOf(witness, 'articles_revision'))
  })
})
