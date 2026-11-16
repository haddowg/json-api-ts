import { describe, expect, it } from 'vitest'
import { MAXIMUM_CONTRACT } from './contract'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument } from './openapi'
import { fakeTransport, fixture, modelOf, source } from './test-fixtures'

const singleton = source('contract-witness').document

const inbox = (attributes: Record<string, unknown> = { unseen: 3, unread: 5, seenUpTo: null }) => ({
  type: 'inboxes',
  id: '42',
  attributes,
  relationships: { owner: { data: { type: 'people', id: 'per-1' } } },
})

const properties = (schema: unknown): string[] =>
  Object.keys(((schema as JsonSchema)['properties'] ?? {}) as Record<string, unknown>)

async function session(doc: OpenApiDocument = singleton) {
  const { transport, requests } = fakeTransport((req) =>
    req.url.endsWith('/inbox/owner')
      ? { json: { data: { type: 'people', id: 'per-1', attributes: { name: 'Ada' } } } }
      : req.method === 'PATCH'
        ? { json: { data: inbox({ unseen: 0, unread: 5, seenUpTo: '2026-11-16T09:30:00+00:00' }) } }
        : { json: { data: inbox() } },
  )
  const mcp = createJsonApiMcp({ ...modelOf(doc), transport })
  return { requests, mcp, tools: await mcp.forRequest({ context: undefined }) }
}

// The witness's inbox needs no scope, so this copy gives its read and update one each.
const scoped = (hideGet = false): OpenApiDocument => {
  const doc = structuredClone(singleton)
  const item = doc.paths!['/inbox']!
  item.get!.security = [{ oauth2: ['inbox:read'] }]
  item.patch!.security = [{ oauth2: ['inbox:write'] }]
  if (hideGet) {
    item.get!['x-mcp'] = false
  }
  return doc
}
const listed = async (
  doc: OpenApiDocument,
  grantedScopes: string[],
  hooks: Parameters<typeof createJsonApiMcp>[0]['hooks'] = {},
) =>
  (
    await createJsonApiMcp({ ...modelOf(doc), hooks }).forRequest({
      grantedScopes,
      context: {},
    })
  ).tools
    .map((tool) => tool.name)
    .filter((name) => name === 'inboxes_get' || name === 'inboxes_update')

const denyRead = () => ({ 'fetchOne.inboxes': 'denied' as const })

/**
 * A singleton type serves each caller one resource at a path with no id. Its tools are named from
 * its operation ids as any type's are, and take no id. Its update reads the resource first, since
 * the body must carry the id the path leaves out.
 */
describe('generator contract 40 (singleton types)', () => {
  it('reads a document stamped 40, and refuses one past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(40)
    expect(createJsonApiMcp(modelOf(singleton)).contract).toBe(40)
    const newer = structuredClone(singleton)
    newer.info!['x-generator']!.contract = 41
    expect(() => createJsonApiMcp(modelOf(newer))).toThrow('newer than this package reads')
  })

  it('gives the singleton tools without an id, and every other tool what it had', () => {
    const tools = createJsonApiMcp(modelOf(singleton)).tools
    const inboxTools = tools.filter((tool) => tool.name.startsWith('inboxes_'))
    expect(inboxTools.map((tool) => tool.name)).toEqual([
      'inboxes_get',
      'inboxes_mark_all_read',
      'inboxes_owner_get',
      'inboxes_update',
    ])
    for (const tool of inboxTools) {
      expect(properties(tool.inputSchema)).not.toContain('id')
      expect(tool.inputSchema['required'] ?? []).not.toContain('id')
    }
    const update = inboxTools.find((tool) => tool.name === 'inboxes_update')!
    expect(properties(update.inputSchema)).toEqual(expect.arrayContaining(['seenUpTo', 'owner']))
  })

  it('records no preceding read for a document without a singleton', () => {
    // Core's second witness leaves out every structure only some documents carry, the singleton too.
    const mcp = createJsonApiMcp(fixture('contract-witness-baseline'))
    expect(mcp.contract).toBe(39)
    expect(mcp.tools.some((tool) => tool.name.startsWith('inboxes_'))).toBe(false)
    expect(mcp.operations.some((op) => op.reads !== undefined)).toBe(false)
  })

  it('reads, relates and runs actions at the singleton path', async () => {
    const { requests, tools } = await session()
    const got = await tools.callTool('inboxes_get', {})
    expect(got.isError).toBeUndefined()
    expect(got.structuredContent).toMatchObject({ data: { id: '42', type: 'inboxes', unread: 5 } })
    await tools.callTool('inboxes_owner_get', {})
    await tools.callTool('inboxes_mark_all_read', {})
    expect(requests.map((req) => `${req.method} ${new URL(req.url).pathname}`)).toEqual([
      'GET /inbox',
      'GET /inbox/owner',
      'POST /inbox/-actions/mark-all-read',
    ])
  })

  it('updates with the id a read of the singleton returns', async () => {
    const { requests, tools } = await session()
    const result = await tools.callTool('inboxes_update', {
      seenUpTo: '2026-11-16T09:30:00+00:00',
      owner: null,
      clear: null,
    })
    expect(result.isError).toBeUndefined()
    expect(requests.map((req) => `${req.method} ${new URL(req.url).pathname}`)).toEqual([
      'GET /inbox',
      'PATCH /inbox',
    ])
    expect(JSON.parse(requests[1]!.body!)).toEqual({
      data: { type: 'inboxes', id: '42', attributes: { seenUpTo: '2026-11-16T09:30:00+00:00' } },
    })
    expect(result.structuredContent).toMatchObject({ data: { id: '42', unseen: 0 } })
  })

  it('names and hides singleton tools by x-mcp on their operations', () => {
    const doc = structuredClone(singleton)
    doc.paths!['/inbox']!.patch!['x-mcp'] = { name: 'mark_inbox_seen' }
    doc.paths!['/inbox/owner']!.get!['x-mcp'] = false
    const names = createJsonApiMcp(modelOf(doc)).tools.map((tool) => tool.name)
    expect(names).toContain('mark_inbox_seen')
    expect(names).not.toContain('inboxes_update')
    expect(names).not.toContain('inboxes_owner_get')
  })

  describe('scope filtering of the update, which reads first', () => {
    it('carries the read and its security on the update', () => {
      const { model } = modelOf(scoped())
      const update = model.tools.find((tool) => tool.tool.name === 'inboxes_update')!
      expect(update.operation.reads).toEqual({
        operationId: 'fetchOne.inboxes',
        security: [{ oauth2: ['inbox:read'] }],
      })
      const get = model.tools.find((tool) => tool.tool.name === 'inboxes_get')!
      expect(get.operation.reads).toBeUndefined()
    })

    it('lists the update only for a caller holding both scopes', async () => {
      expect(await listed(scoped(), ['inbox:write'])).toEqual([])
      expect(await listed(scoped(), ['inbox:read'])).toEqual(['inboxes_get'])
      expect(await listed(scoped(), ['inbox:read', 'inbox:write'])).toEqual([
        'inboxes_get',
        'inboxes_update',
      ])
    })

    it('still needs the read scope when the get tool is hidden', async () => {
      expect(await listed(scoped(true), ['inbox:write'])).toEqual([])
      expect(await listed(scoped(true), ['inbox:read', 'inbox:write'])).toEqual(['inboxes_update'])
    })

    it('leaves the update out when the capabilities deny the read', async () => {
      const capabilities = denyRead
      expect(await listed(scoped(), ['inbox:read', 'inbox:write'], { capabilities })).toEqual([])
    })

    it('shows the read to hooks', async () => {
      const seen: unknown[] = []
      await createJsonApiMcp({
        ...modelOf(scoped()),
        hooks: {
          includeOperation: (op) => {
            if (op.toolName === 'inboxes_update') seen.push(op.reads)
            return true
          },
        },
      }).forRequest({ context: {} })
      expect(seen).toEqual([
        { operationId: 'fetchOne.inboxes', security: [{ oauth2: ['inbox:read'] }] },
      ])
    })
  })
})
