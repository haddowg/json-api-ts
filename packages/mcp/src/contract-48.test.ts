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

/** A schema node the atomic graft reads and writes: any JSON, walked without checks. */
// oxlint-disable-next-line typescript/no-explicit-any
type Node = any

/** The typed relations a relationship operation can answer for, in the order the server lists them. */
const TYPED_LINKAGE = [
  ['articles', 'author'],
  ['articles', 'tags'],
  ['articles', 'attachments'],
  ['articles', 'sponsors'],
  ['bookings', 'rooms'],
] as const

/** A component name's part for a type or relation name. */
const pascal = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

/**
 * The witness's atomic results as a server projects them now. Each relation typing its identifiers'
 * `meta` adds its response linkage to `AtomicResult.data`, described by the relation, and a type only
 * those relations link to leaves the shared identifier union. The mutation-locked relation declares
 * identifier meta where the witness declares any, and adds no branch.
 */
function atomicLinkage(copy: OpenApiDocument): void {
  const schemas = (copy as unknown as { components: { schemas: Record<string, Node> } }).components
    .schemas
  const branches: Node[] = []
  for (const [type, relation] of TYPED_LINKAGE) {
    const data =
      schemas[`${pascal(type)}${pascal(relation)}RelationshipDocument`]?.['properties']?.['data']
    const description = `The linkage of the "${relation}" relationship of the "${type}" type.`
    if (data?.['items']?.['allOf'] !== undefined) {
      branches.push({ type: 'array', description, items: data['items'] } as unknown as Node)
    } else if (data?.['anyOf']?.[0]?.['allOf'] !== undefined) {
      branches.push({ description, ...data['anyOf'][0] } as unknown as Node)
    }
  }
  const union = schemas['AtomicResult']!['properties']['data']['anyOf'] as unknown as Node[]
  for (const shared of [union[1]!, union[2]!['items']]) {
    shared['oneOf'] = (shared['oneOf'] as unknown as Node[]).filter(
      (entry) => entry['$ref'] !== ('#/components/schemas/TagsResourceIdentifier' as unknown),
    ) as unknown as Node
    delete shared['discriminator']['mapping']['tags']
  }
  union.splice(union.length - 1, 0, ...structuredClone(branches))

  if (schemas['ArticlesAttachmentsIdentifierMeta'] === undefined) {
    return
  }
  const meta = {
    type: 'object',
    properties: { lockedBy: { type: ['string', 'null'], examples: ['editor'] } },
    required: ['lockedBy'],
    additionalProperties: false,
  } as unknown as Node
  const entries = Object.entries(schemas)
  const at = entries.findIndex(([name]) => name === 'ArticlesLockedFetchRelationship404') + 1
  entries.splice(at, 0, ['ArticlesLockedIdentifierMeta', meta])
  for (const name of Object.keys(schemas)) {
    delete schemas[name]
  }
  Object.assign(schemas, Object.fromEntries(entries))
  for (const name of ['ArticlesLockedRelationship', 'ArticlesLockedRelationshipDocument']) {
    const data = schemas[name]!['properties']['data']
    data['items'] = {
      allOf: [
        data['items'],
        {
          type: 'object',
          properties: { meta: { $ref: '#/components/schemas/ArticlesLockedIdentifierMeta' } },
        },
      ],
    } as unknown as Node
  }
  const paths = (copy as unknown as { paths: Record<string, Node> }).paths
  const example =
    paths['/articles/{id}/relationships/locked']!['get']['responses']['200']['content'][
      'application/vnd.api+json'
    ]['example']
  example['data'][0]!['meta'] = { lockedBy: 'editor' } as unknown as Node
}

/**
 * The witness as a server projects it now: each response linkage identifier of a pivot relation
 * requires `meta`, and its `meta` requires `pivot`, inline or in the declared identifier meta it
 * refs. Its relationship object's example carries that `meta`, or it has none where a field
 * declares no example, its atomic results carry each typed relation's linkage, and the document
 * is stamped 48. No core release carries 48 yet, so this grafts that change onto the pinned witness.
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
  atomicLinkage(copy)
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

  it('builds the same model whatever the atomic results carry', () => {
    const schemas = (doc as unknown as { components: { schemas: Record<string, Node> } }).components
      .schemas
    const union = schemas['AtomicResult']!['properties']['data']['anyOf'] as unknown as Node[]
    expect(union.filter((branch) => branch['description'] !== undefined)).toHaveLength(
      TYPED_LINKAGE.length,
    )
    const withoutResults = structuredClone(doc) as unknown as {
      components: { schemas: Record<string, unknown> }
    }
    withoutResults.components.schemas['AtomicResult'] = (
      witness as unknown as { components: { schemas: Record<string, unknown> } }
    ).components.schemas['AtomicResult']
    const plain = withoutResults as unknown as OpenApiDocument
    expect(tools(doc)).toEqual(tools(plain))
    expect(modelOf(doc).model.descriptor).toEqual(modelOf(plain).model.descriptor)
  })

  it("carries the relation's mark in the descriptor the client calls through", () => {
    const relations = modelOf(doc).model.descriptor['articles']!.relations
    expect(relations['sponsors']!.pivotRendered).toBe(true)
    expect(relations['tags']!.pivotRendered).toBe(true)
  })
})
