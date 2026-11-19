import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument } from './openapi'
import { fakeTransport, fixture, modelOf, source } from './test-fixtures'

const typed = source('contract-witness').document

const notice = { type: 'notices', id: 'n-1', attributes: { message: 'Hi' } }

const toolsOf = (doc: OpenApiDocument) => createJsonApiMcp(modelOf(doc)).tools
const tool = (name: string) => toolsOf(typed).find((entry) => entry.name === name)!

/** A property of an output schema, or of its first `anyOf` member that has it. */
function property(schema: JsonSchema | undefined, name: string): JsonSchema | undefined {
  const own = (schema?.['properties'] as Record<string, JsonSchema> | undefined)?.[name]
  if (own !== undefined) return own
  for (const member of (schema?.['anyOf'] as JsonSchema[] | undefined) ?? []) {
    const found = property(member, name)
    if (found !== undefined) return found
  }
  return undefined
}

async function call(name: string, args: Record<string, unknown>, json: unknown, status = 200) {
  const { transport, requests } = fakeTransport(() => ({ status, json }))
  const mcp = createJsonApiMcp({ ...modelOf(typed), transport })
  const tools = await mcp.forRequest({ context: undefined })
  return { result: await tools.callTool(name, args), requests }
}

/**
 * An operation declaring its top-level `meta` answers with a document component of its own,
 * marked `x-document-meta`. Its tool's output schema types that `meta` from the component, and
 * its description names the members.
 */
describe('generator contract 41 (typed document meta)', () => {
  it('reads a document stamped 41', () => {
    expect(createJsonApiMcp(modelOf(typed)).contract).toBe(41)
  })

  it('types the collection meta it declares, page and total beside them', () => {
    const list = tool('notices_list')
    const meta = property(list.outputSchema, 'meta')!
    expect(meta).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['unread'],
      properties: {
        unread: { type: 'integer', description: 'How many notices are unread.' },
        digest: { type: ['string', 'null'] },
        page: { type: 'object' },
        total: { type: 'integer' },
      },
    })
    expect(meta['description']).toBe(
      'The document meta, carrying `unread`, `digest`, `page` and `total`.',
    )
    expect(list.outputSchema?.['required']).toEqual(['data', 'links', 'meta'])
    expect(list.description).toContain(
      "The result's `meta` carries `unread`, `digest`, `page` and `total`.",
    )
  })

  it('types the single read, update, related read and delete meta', () => {
    expect(property(tool('notices_get').outputSchema, 'meta')).toMatchObject({
      properties: { etag: { type: 'string' } },
      required: ['etag'],
    })
    // No member of the update's meta is required, so its document may leave `meta` out.
    const update = tool('notices_update')
    expect(property(update.outputSchema, 'meta')).toMatchObject({
      properties: { etag: { type: ['string', 'null'] } },
    })
    expect(update.outputSchema?.['required']).toEqual(['data'])
    expect(property(tool('notices_replies_list').outputSchema, 'meta')).toMatchObject({
      required: ['unread'],
    })
    const deleted = tool('notices_delete')
    expect(property(deleted.outputSchema, 'meta')).toMatchObject({
      properties: { archived: { type: 'integer' } },
    })
    expect(deleted.outputSchema?.['required']).toEqual(['data', 'meta'])
    // The create declares none and keeps the shared document's meta.
    const create = tool('notices_create')
    expect(property(create.outputSchema, 'meta')?.['properties']).toBeUndefined()
    expect(create.description ?? '').not.toContain("The result's `meta`")
  })

  it('takes either result from an action whose 200 is meta-only', () => {
    const snapshot = tool('notices_snapshot')
    const [resource, meta] = snapshot.outputSchema!['anyOf'] as JsonSchema[]
    expect(property(resource, 'meta')).toMatchObject({
      properties: { snapshotOf: { type: 'string' } },
    })
    expect(property(meta, 'meta')).toMatchObject({
      properties: { unchanged: { type: 'boolean' } },
    })
    expect(snapshot.description).toContain(
      "The result's `meta` carries `unchanged` and `snapshotOf`.",
    )
    expect(property(tool('notices_mark_read').outputSchema, 'meta')).toMatchObject({
      properties: { marked: { type: 'integer' } },
    })
  })

  it('returns the meta each call answers with', async () => {
    const listed = await call('notices_list', {}, { data: [notice], meta: { unread: 3 } })
    expect(listed.result.structuredContent).toMatchObject({ meta: { unread: 3 } })
    const deleted = await call('notices_delete', { id: 'n-1' }, { meta: { archived: 1 } })
    expect(deleted.result.structuredContent).toEqual({ data: null, meta: { archived: 1 } })
    const unchanged = await call('notices_snapshot', { id: 'n-1' }, { meta: { unchanged: true } })
    expect(unchanged.result.structuredContent).toEqual({ meta: { unchanged: true } })
    const created = await call(
      'notices_snapshot',
      { id: 'n-1' },
      { data: notice, meta: { snapshotOf: 'n-1' } },
      201,
    )
    expect(created.result.structuredContent).toMatchObject({
      data: { id: 'n-1', type: 'notices', message: 'Hi' },
      meta: { snapshotOf: 'n-1' },
    })
  })

  it('adds no meta sentence to a document that declares none', () => {
    // Core's second witness leaves out every structure only some documents carry, typed meta too.
    const mcp = createJsonApiMcp(fixture('contract-witness-baseline'))
    expect(mcp.contract).toBe(39)
    expect(mcp.tools.some((entry) => entry.description?.includes("The result's `meta`"))).toBe(
      false,
    )
  })

  it('keeps an x-mcp description as written', () => {
    const doc = structuredClone(typed)
    doc.paths!['/notices']!.get!['x-mcp'] = { description: 'List the notices.' }
    const list = toolsOf(doc).find((entry) => entry.name === 'notices_list')!
    expect(list.description).toBe('List the notices.')
  })
})
