import { describe, expect, it, vi } from 'vitest'
import { createJsonApiMcp, satisfiesSecurity } from './mcp'
import type { OpenApiDocument } from './openapi'
import { fakeTransport, fixture, modelOf, source } from './test-fixtures'
import type { McpOperation } from './types'

/** The music catalogue with OAuth scopes on some operations and a vendor extension on others. */
function scoped() {
  const { document, descriptor } = source('music-catalog')
  const doc = structuredClone(document) as OpenApiDocument
  doc.paths!['/albums']!.get!.security = [{ oauth: ['albums:read'] }]
  doc.paths!['/albums']!.post!.security = [{ oauth: ['albums:write'] }]
  doc.paths!['/albums/{id}']!.delete!.security = [
    { oauth: ['albums:manage'] },
    { apiKey: ['admin:manage'] },
  ]
  doc.paths!['/artists']!.get!['x-feature'] = 'artists'
  return modelOf(doc, descriptor)
}

const names = (tools: readonly { name: string }[]) => tools.map((t) => t.name)

describe('scopes', () => {
  it('applies OpenAPI security semantics: any requirement, all of its scopes', () => {
    expect(satisfiesSecurity([], [])).toBe(true)
    expect(satisfiesSecurity([{ bearer: [] }], [])).toBe(true)
    expect(satisfiesSecurity([{ oauth: ['a', 'b'] }], ['a'])).toBe(false)
    expect(satisfiesSecurity([{ oauth: ['a', 'b'] }], ['a', 'b'])).toBe(true)
    expect(satisfiesSecurity([{ oauth: ['a'] }, { key: ['b'] }], ['b'])).toBe(true)
    expect(
      scoped().model.tools.find((t) => t.operation.operationId === 'fetchCollection.albums')!
        .operation.security,
    ).toEqual([{ oauth: ['albums:read'] }])
  })

  it('filters by granted scopes, exactly by default', async () => {
    const mcp = createJsonApiMcp(scoped())
    const tools = names(
      (await mcp.forRequest({ grantedScopes: ['albums:read'], context: {} })).tools,
    )
    expect(tools).toContain('albums_list')
    expect(tools).not.toContain('albums_create')
    expect(tools).not.toContain('albums_delete')
    // No scopes in the operation's security, or the document's bearer default: kept.
    expect(tools).toContain('albums_get')
  })

  it('leaves scope semantics to the host matcher', async () => {
    const levels = ['read', 'write', 'manage']
    const scopeMatcher = vi.fn((granted: readonly string[], required: readonly string[]) =>
      required.every((need) => {
        const [area, level] = need.split(':')
        return granted.some((g) => {
          const [gArea, gLevel] = g.split(':')
          return (
            (gArea === '*' || gArea === area) && levels.indexOf(gLevel!) >= levels.indexOf(level!)
          )
        })
      }),
    )
    const mcp = createJsonApiMcp({ ...scoped(), hooks: { scopeMatcher } })
    const tools = names((await mcp.forRequest({ grantedScopes: ['*:write'], context: {} })).tools)
    expect(tools).toContain('albums_list')
    expect(tools).toContain('albums_create')
    expect(tools).not.toContain('albums_delete')
    expect(scopeMatcher).toHaveBeenCalledWith(['*:write'], ['albums:manage'])
  })

  it('skips scope filtering when the request names no scopes', async () => {
    const mcp = createJsonApiMcp(scoped())
    expect((await mcp.forRequest({ context: {} })).tools).toHaveLength(mcp.tools.length)
  })
})

describe('capabilities and includeOperation', () => {
  it('runs scopes, then capabilities, then includeOperation, once each per list', async () => {
    const calls: string[] = []
    const capabilities = vi.fn(() => {
      calls.push('capabilities')
      return { 'fetchCollection.artists': 'denied', 'fetchOne.albums': 'depends' } as const
    })
    const includeOperation = vi.fn((op: McpOperation, ctx: { features: string[] }) => {
      calls.push(op.operationId)
      const feature = op.operation['x-feature']
      return typeof feature !== 'string' || ctx.features.includes(feature)
    })
    const mcp = createJsonApiMcp({ ...scoped(), hooks: { capabilities, includeOperation } })
    const session = await mcp.forRequest({
      grantedScopes: ['albums:read'],
      context: { features: [] },
    })
    const tools = names(session.tools)
    expect(capabilities).toHaveBeenCalledTimes(1)
    expect(calls[0]).toBe('capabilities')
    // Filtered by scope before the hook saw it.
    expect(calls).not.toContain('create.albums')
    // Denied by capabilities before the hook saw it.
    expect(calls).not.toContain('fetchCollection.artists')
    expect(tools).toContain('albums_get')
    expect(tools).not.toContain('artists_list')
    const op = includeOperation.mock.calls.find(([o]) => o.operationId === 'fetchOne.albums')![0]
    expect(op.resource.paths['fetchOne']).toBe('/albums/{id}')
    expect(op.operation.operationId).toBe('fetchOne.albums')
    expect(op.kind).toBe('get')
  })

  it('drops what includeOperation rejects, reading vendor extensions untouched', async () => {
    const mcp = createJsonApiMcp<{ features: string[] }>({
      ...scoped(),
      hooks: {
        includeOperation: (op, ctx) => {
          const feature = op.operation['x-feature']
          return typeof feature !== 'string' || ctx.features.includes(feature)
        },
      },
    })
    expect(names((await mcp.forRequest({ context: { features: [] } })).tools)).not.toContain(
      'artists_list',
    )
    expect(names((await mcp.forRequest({ context: { features: ['artists'] } })).tools)).toContain(
      'artists_list',
    )
  })

  it('accepts capabilities as a Map', async () => {
    const mcp = createJsonApiMcp({
      ...fixture('music-catalog'),
      hooks: { capabilities: async () => new Map([['delete.albums', 'denied' as const]]) },
    })
    expect(names((await mcp.forRequest({ context: undefined })).tools)).not.toContain(
      'albums_delete',
    )
  })

  it('refuses a call to a tool the caller was not given', async () => {
    const { transport, requests } = fakeTransport(() => ({ json: { data: [] } }))
    const mcp = createJsonApiMcp({ ...scoped(), transport })
    const session = await mcp.forRequest({ grantedScopes: [], context: {} })
    const result = await session.callTool('albums_create', { title: 'x' })
    expect(result.isError).toBe(true)
    expect(requests).toHaveLength(0)
  })
})

describe('decorateTool, requestInit and mapError', () => {
  it('lets the host decorate a tool without touching the catalogue', async () => {
    const mcp = createJsonApiMcp({
      ...scoped(),
      hooks: {
        decorateTool: (tool, op) =>
          typeof op.operation['x-feature'] === 'string'
            ? {
                ...tool,
                description: `${tool.description} Requires the \`${op.operation['x-feature']}\` feature.`,
              }
            : tool,
      },
    })
    const session = await mcp.forRequest({ context: {} })
    expect(session.tools.find((t) => t.name === 'artists_list')!.description).toMatch(
      /Requires the `artists` feature\.$/,
    )
    expect(mcp.tools.find((t) => t.name === 'artists_list')!.description).not.toMatch(/Requires/)
  })

  it('sends the headers and base URL requestInit returns, per call', async () => {
    const { transport, requests } = fakeTransport(() => ({ json: { data: [] } }))
    const requestInit = vi.fn((_op: McpOperation, ctx: { token: string; host: string }) => ({
      baseUrl: `https://${ctx.host}/api/v5`,
      headers: { Authorization: `Bearer ${ctx.token}`, 'X-Actor-Type': 'ai' },
    }))
    const mcp = createJsonApiMcp({ ...fixture('music-catalog'), transport, hooks: { requestInit } })
    const session = await mcp.forRequest({ context: { token: 't0k', host: 'acme.example' } })
    await session.callTool('albums_list', {})
    expect(requests[0]!.url).toBe('https://acme.example/api/v5/albums?page[size]=10')
    expect(requests[0]!.headers).toMatchObject({
      Authorization: 'Bearer t0k',
      'X-Actor-Type': 'ai',
    })
    expect(requestInit.mock.calls[0]![0].operationId).toBe('fetchCollection.albums')

    // A pageLink is checked against the base URL requestInit gave, path prefix included.
    const ok = await session.callTool('albums_list', {
      pageLink: 'https://acme.example/api/v5/albums?page[number]=2',
    })
    expect(ok.isError).toBeUndefined()
    const off = await session.callTool('albums_list', {
      pageLink: 'https://acme.example/albums?page[number]=2',
    })
    expect(off.isError).toBe(true)
  })

  it('lets mapError rewrite a tool error', async () => {
    const { transport } = fakeTransport(() => ({
      status: 403,
      json: {
        errors: [{ status: '403', code: 'INSUFFICIENT_SCOPE', detail: 'Needs albums:write.' }],
      },
    }))
    const mcp = createJsonApiMcp({
      ...fixture('music-catalog'),
      transport,
      hooks: {
        mapError: (error, op) => ({
          ...error,
          message: `${op.toolName} needs a scope the token lacks. Ask the user to reconnect.`,
        }),
      },
    })
    const result = await (
      await mcp.forRequest({ context: undefined })
    ).callTool('albums_create', {
      title: 'x',
    })
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      error: 'albums_create needs a scope the token lacks. Ask the user to reconnect.',
      status: 403,
      errors: [{ code: 'INSUFFICIENT_SCOPE', detail: 'Needs albums:write.' }],
    })
  })

  it('fails a call clearly when there is no base URL', async () => {
    const { document, descriptor } = source('music-catalog')
    const mcp = createJsonApiMcp(modelOf({ ...document, servers: [] }, descriptor))
    const result = await (await mcp.forRequest({ context: undefined })).callTool('albums_list', {})
    expect(JSON.parse((result.content[0] as { text: string }).text).error).toMatch(/No base URL/)
  })
})
