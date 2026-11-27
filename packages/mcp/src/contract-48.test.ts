import { describe, expect, it } from 'vitest'
import { MAXIMUM_CONTRACT } from './contract'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument } from './openapi'
import { modelOf, source } from './test-fixtures'

const { document: witness } = source('contract-witness')
const { document: baseline } = source('contract-witness-baseline')

type Schema = JsonSchema & {
  $ref?: string
  properties?: Record<string, Schema>
  items?: Schema
  allOf?: Schema[]
  required?: string[]
}

/**
 * The example a pivot relation's relationship object carries: its member's `meta.pivot` and
 * declared identifier meta, from each field's example. One with a field declaring no example has
 * none.
 */
const EXAMPLES: Record<string, unknown[]> = {
  ArticlesSponsorsRelationship: [
    {
      data: [
        {
          type: 'people',
          id: 'per-1',
          meta: { pivot: { rank: 1, since: '2026-01-01T00:00:00+00:00' } },
        },
      ],
    },
  ],
  BookingsRoomsRelationship: [
    { data: [{ type: 'rooms', id: 'rm-1', meta: { view: 'sea', pivot: { nights: 2 } } }] },
  ],
}

/**
 * The witness as a server projects it now: each response linkage identifier of a pivot relation
 * requires `meta`, and its `meta` requires `pivot`, inline or in the declared identifier meta it
 * refs. Its relationship object's example carries that `meta`, or it has none where a field
 * declares no example, and the document is stamped 48. No core release carries 48 yet, so this
 * grafts that change onto the pinned witness.
 */
function rendered(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc)
  const schemas = (copy as { components: { schemas: Record<string, Schema> } }).components.schemas
  for (const [name, schema] of Object.entries(schemas)) {
    if (!/Relationship(Document)?$/.test(name) || /(Write|Request)Relationship$/.test(name)) {
      continue
    }
    const part = schema.properties?.['data']?.items?.allOf?.find(
      (entry) => entry.properties?.['meta'] !== undefined,
    )
    const meta = part?.properties?.['meta']
    const target = meta?.$ref === undefined ? meta : schemas[meta.$ref.split('/').pop()!]
    if (part === undefined || target?.properties?.['pivot'] === undefined) {
      continue
    }
    part.required = ['meta']
    if (!(target.required ?? []).includes('pivot')) {
      target.required = [...(target.required ?? []), 'pivot']
    }
    if (EXAMPLES[name] === undefined) {
      delete (schema as Record<string, unknown>)['examples']
    } else {
      ;(schema as Record<string, unknown>)['examples'] = EXAMPLES[name]
    }
  }
  copy.info!['x-generator'] = { contract: 48 }
  return copy
}

/** What a model's tools take and answer with, without the stamp and the document it came from. */
function tools(doc: OpenApiDocument): unknown {
  const { tools, skipped, resourceLinks, includeDepth } = modelOf(doc).model
  return { tools, skipped, resourceLinks, includeDepth }
}

/**
 * A pivot relation's response linkage renders `meta.pivot` on every member, so its response
 * identifiers require `meta` and its `pivot`. A tool's output carries a related resource as its
 * id or the included resource, not the linkage meta, and a write still takes the pivot as an
 * optional argument, so the tools come out as they did.
 */
describe('generator contract 48 (a pivot rendered on every linkage member)', () => {
  const doc = rendered(witness)

  it('reads the document, and refuses one past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(48)
    expect(createJsonApiMcp(modelOf(doc)).contract).toBe(48)
    expect(createJsonApiMcp(modelOf(rendered(baseline))).contract).toBe(48)
    const newer = structuredClone(doc)
    newer.info!['x-generator']!.contract = 49
    expect(() => createJsonApiMcp(modelOf(newer))).toThrow('newer than this package reads')
  })

  it('builds the same tools, inputs and outputs as before', () => {
    expect(tools(doc)).toEqual(tools(witness))
    expect(tools(rendered(baseline))).toEqual(tools(baseline))
  })

  it("carries the relation's mark in the descriptor the client calls through", () => {
    const relations = modelOf(doc).model.descriptor['articles']!.relations
    expect(relations['sponsors']!.pivotRendered).toBe(true)
    expect(relations['tags']!.pivotRendered).toBe(true)
  })
})
