import { describe, expect, it } from 'vitest'
import { MAXIMUM_CONTRACT } from './contract'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema } from './openapi'
import { allowsNull } from './portable'
import { modelOf, source } from './test-fixtures'
import { boundedWriteOnly, requiredWrites } from './test-required-writes'

const { document: pinned } = source('contract-witness')
const witness = requiredWrites(pinned)

const inputOf = (doc: typeof pinned, tool: string): JsonSchema =>
  createJsonApiMcp(modelOf(doc)).tools.find((candidate) => candidate.name === tool)!.inputSchema

const propertiesOf = (input: JsonSchema): Record<string, JsonSchema> =>
  input['properties'] as Record<string, JsonSchema>

/**
 * A create lists the relationships it must send in `relationships.required`, and a write narrows
 * a required relation's shared relationship object beside its reference in an `allOf`: no `null`
 * on a to-one, `minItems: 1` on a to-many. A create tool requires those relations, and an update
 * tool can't clear a to-one the server won't take as `null`.
 */
describe('generator contract 46 (required writes)', () => {
  it('reads a document stamped 46, and refuses one past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(46)
    expect(createJsonApiMcp(modelOf(witness)).contract).toBe(46)
    const newer = structuredClone(witness)
    newer.info!['x-generator']!.contract = 47
    expect(() => createJsonApiMcp(modelOf(newer))).toThrow('newer than this package reads')
  })

  it('requires the relations a create must send', () => {
    // A tool's arguments are all listed, and an optional one takes null to leave it out.
    const argument = (doc: typeof pinned, tool: string, name: string) =>
      propertiesOf(inputOf(doc, tool))[name]!
    expect(allowsNull(argument(witness, 'people_create', 'company'))).toBe(false)
    expect(allowsNull(argument(witness, 'tags_create', 'articles'))).toBe(false)
    expect(allowsNull(argument(pinned, 'people_create', 'company'))).toBe(true)
    expect(allowsNull(argument(pinned, 'tags_create', 'articles'))).toBe(true)
  })

  it('offers no clearing of a to-one the server requires', () => {
    const clear = (doc: typeof pinned) =>
      (propertiesOf(inputOf(doc, 'people_update'))['clear'] as JsonSchema | undefined)?.['items']
    expect(JSON.stringify(clear(pinned) ?? {})).toContain('company')
    expect(JSON.stringify(clear(witness) ?? {})).not.toContain('company')
  })

  it('keeps the pivot of a polymorphic to-many whose write narrows it', () => {
    const bounded = structuredClone(witness)
    const relationships = (
      (bounded.components!.schemas!['ArticlesCreateRequest'] as JsonSchema)['properties'] as Record<
        string,
        JsonSchema
      >
    )['data']!['properties'] as Record<string, JsonSchema>
    const properties = relationships['relationships']!['properties'] as Record<string, JsonSchema>
    properties['sponsors'] = {
      allOf: [properties['sponsors']!, { properties: { data: { minItems: 1 } } }],
    }
    const sponsors = (doc: typeof pinned) =>
      propertiesOf(inputOf(doc, 'articles_create'))['sponsors']
    expect(JSON.stringify(sponsors(pinned))).toContain('pivot')
    expect(sponsors(bounded)).toEqual(sponsors(pinned))
  })

  it('keeps a write-only relation whose writes both narrow it', () => {
    const create = (doc: typeof pinned) => propertiesOf(inputOf(doc, 'articles_create'))['watchers']
    expect(create(boundedWriteOnly(witness))).toEqual(create(pinned))
  })
})
