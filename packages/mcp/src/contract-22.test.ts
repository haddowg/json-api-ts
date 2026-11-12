import { describe, expect, it } from 'vitest'
import { MCP_EXTENSION } from './extension'
import { createJsonApiMcp } from './mcp'
import { MODEL_FORMAT } from './model'
import type { JsonSchema, OpenApiDocument } from './openapi'
import { fixture, modelOf, source } from './test-fixtures'

type Mcp = ReturnType<typeof createJsonApiMcp>

const tool = (mcp: Mcp, name: string) => mcp.tools.find((t) => t.name === name)!

const argument = (mcp: Mcp, name: string, member: string): JsonSchema =>
  (tool(mcp, name).inputSchema['properties'] as Record<string, JsonSchema>)[member]!

/** The witness model after `edit` has changed a copy of the document. */
function edited(edit: (doc: OpenApiDocument) => void): Mcp {
  const { document } = source('contract-witness')
  const doc = structuredClone(document)
  edit(doc)
  return createJsonApiMcp(modelOf(doc))
}

describe('generator contract 22 (deprecation)', () => {
  const mcp = createJsonApiMcp(fixture('contract-witness'))

  it('reads the witness', () => {
    expect(mcp.contract).toBe(34)
  })

  it('starts a deprecated operation tool description with Deprecated.', () => {
    expect(tool(mcp, 'tags_list').description).toBe(
      'Deprecated. Returns a paginated collection of tags.\n\nThis operation may stop responding on or after 2027-06-30, its sunset date.',
    )
    expect(tool(mcp, 'articles_author_get').description).toBe('Deprecated. Who wrote it.')
    expect(tool(mcp, 'articles_retract').description).toMatch(/^Deprecated\. Invokes the/)
    expect(tool(mcp, 'articles_update').description).not.toMatch(/Deprecated/)
  })

  it('prefixes an x-mcp description too, unless it already says so', () => {
    const custom = edited((doc) => {
      doc.paths!['/tags']!.get![MCP_EXTENSION] = { description: 'List the tags.' }
      doc.paths!['/tags']!.post![MCP_EXTENSION] = { description: 'Deprecated: use labels.' }
    })
    expect(tool(custom, 'tags_list').description).toBe('Deprecated. List the tags.')
    expect(tool(custom, 'tags_create').description).toBe('Deprecated: use labels.')
  })

  it('describes a deprecated operation with no prose as Deprecated.', () => {
    const bare = edited((doc) => {
      const op = doc.paths!['/tags/{id}']!.get!
      delete op.description
      delete op.summary
    })
    expect(tool(bare, 'tags_get').description).toBe('Deprecated.')
  })

  it('notes a deprecated attribute and relation in create and update input', () => {
    for (const name of ['articles_create', 'articles_update']) {
      expect(argument(mcp, name, 'subtitle')).toEqual({
        type: ['string', 'null'],
        description: 'Deprecated.',
      })
      expect(argument(mcp, name, 'formerAuthor')).toEqual({
        type: ['string', 'null'],
        description:
          'Deprecated. The formerAuthor relationship: the id of the related `people` resource.',
      })
    }
  })

  it('notes a deprecated member of a nested object', () => {
    const nested = edited((doc) => {
      const schemas = doc.components!['schemas'] as Record<string, JsonSchema>
      const attributes = schemas['ArticlesCreateAttributes']!['properties'] as Record<
        string,
        JsonSchema
      >
      const address = attributes['address']!
      const members = (
        Array.isArray(address['anyOf'])
          ? (address['anyOf'] as JsonSchema[]).find((b) => b['type'] === 'object')!
          : address
      )['properties'] as Record<string, JsonSchema>
      members['city'] = { ...members['city'], deprecated: true }
    })
    const address = JSON.stringify(argument(nested, 'articles_create', 'address'))
    expect(address).toContain('"city":{"type":["string","null"],"description":"Deprecated."}')
  })

  it('notes a deprecated filter', () => {
    const filter = argument(mcp, 'articles_list', 'filter')
    const members = (filter['properties'] as Record<string, JsonSchema>)!
    expect(members['state']).toEqual({
      type: ['string', 'null'],
      description: 'Deprecated. Filter the collection by `state`.',
    })
    expect(members['status']!['description']).not.toMatch(/Deprecated/)
  })

  it('offers deprecated sort keys and families in branches noted as deprecated', () => {
    const items = argument(mcp, 'articles_list', 'sort')['items'] as JsonSchema
    expect((items['anyOf'] as JsonSchema[]).slice(0, 3)).toEqual([
      {
        type: 'string',
        enum: ['title', '-title', 'wordCount', '-wordCount'],
        description:
          'What each sort orders by, in either direction:\n- `title`: Alphabetical by title.',
      },
      { type: 'string', enum: ['length', '-length'], description: 'Deprecated.' },
      {
        type: 'string',
        description:
          'Deprecated. `legacy.` followed by a name matching the regular expression `[^,]+`, optionally with a leading `-`.',
      },
    ])
  })

  it('keeps the deprecated keyword out of every input schema', () => {
    for (const t of mcp.tools) {
      expect(JSON.stringify(t.inputSchema)).not.toContain('"deprecated"')
    }
  })

  it('keeps the model format', () => {
    expect(fixture('contract-witness').model.format).toBe(MODEL_FORMAT)
    expect(MODEL_FORMAT).toBe(4)
  })
})
