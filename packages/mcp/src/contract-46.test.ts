import { describe, expect, it } from 'vitest'
import { MAXIMUM_CONTRACT } from './contract'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument } from './openapi'
import { allowsNull } from './portable'
import { modelOf, source } from './test-fixtures'

const { document: witness } = source('contract-witness')

const inputOf = (doc: OpenApiDocument, tool: string): JsonSchema =>
  createJsonApiMcp(modelOf(doc)).tools.find((candidate) => candidate.name === tool)!.inputSchema

const argument = (doc: OpenApiDocument, tool: string, name: string): JsonSchema | undefined =>
  (inputOf(doc, tool)['properties'] as Record<string, JsonSchema>)[name]

/** A write request's relationship properties, to narrow one in place. */
const writeRelationships = (doc: OpenApiDocument, request: string): Record<string, JsonSchema> => {
  const data = (
    (doc.components!.schemas![request] as JsonSchema)['properties'] as Record<string, JsonSchema>
  )['data']!
  const relationships = (data['properties'] as Record<string, JsonSchema>)['relationships']!
  return relationships['properties'] as Record<string, JsonSchema>
}

/** `doc` with the relation narrowed beside its reference to `minItems: 1` in each request. */
function bounded(doc: OpenApiDocument, relation: string, requests: string[]): OpenApiDocument {
  const copy = structuredClone(doc)
  for (const request of requests) {
    const properties = writeRelationships(copy, request)
    const { writeOnly, ...reference } = properties[relation]!
    properties[relation] = {
      allOf: [reference, { properties: { data: { minItems: 1 } } }],
      ...(writeOnly === undefined ? {} : { writeOnly }),
    }
  }
  return copy
}

/**
 * A create lists the relationships it must send in `relationships.required`, and a write narrows
 * a required relation's shared relationship object beside its reference in an `allOf`: no `null`
 * on a to-one, `minItems: 1` on a to-many. A create tool requires those relations, and an update
 * tool can't clear a to-one the server won't take as `null`.
 */
describe('generator contract 46 (required writes)', () => {
  it('reads the witness, and refuses a document past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(46)
    expect(witness.info?.['x-generator']?.contract).toBe(46)
    expect(createJsonApiMcp(modelOf(witness)).contract).toBe(46)
    const newer = structuredClone(witness)
    newer.info!['x-generator']!.contract = 47
    expect(() => createJsonApiMcp(modelOf(newer))).toThrow('newer than this package reads')
  })

  it('requires the relations a create must send', () => {
    // A tool's arguments are all listed, and an optional one takes null to leave it out.
    expect(allowsNull(argument(witness, 'people_create', 'company')!)).toBe(false)
    expect(allowsNull(argument(witness, 'tags_create', 'articles')!)).toBe(false)
    expect(allowsNull(argument(witness, 'articles_create', 'author')!)).toBe(true)
  })

  it('offers no clearing of a to-one the server requires', () => {
    const clear = (tool: string) =>
      JSON.stringify(argument(witness, tool, 'clear')?.['items'] ?? {})
    expect(clear('people_update')).not.toContain('company')
    expect(clear('articles_update')).toContain('author')
  })

  // The witness narrows no pivot or write-only relation, so these narrow one in the write bodies,
  // as item bounds would, and check the tool reads the relation as it did unnarrowed.
  it('keeps the pivot of a polymorphic to-many whose write narrows it', () => {
    const sponsors = (doc: OpenApiDocument) => argument(doc, 'articles_create', 'sponsors')
    expect(JSON.stringify(sponsors(witness))).toContain('pivot')
    expect(sponsors(bounded(witness, 'sponsors', ['ArticlesCreateRequest']))).toEqual(
      sponsors(witness),
    )
  })

  it('keeps a write-only relation whose writes both narrow it', () => {
    const watchers = (doc: OpenApiDocument) => argument(doc, 'articles_create', 'watchers')
    const narrowed = bounded(witness, 'watchers', [
      'ArticlesCreateRequest',
      'ArticlesUpdateRequest',
    ])
    expect(watchers(narrowed)).toEqual(watchers(witness))
  })
})
