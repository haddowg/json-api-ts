import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import { fakeTransport, fixture } from './test-fixtures'
import type { JsonSchema } from './openapi'

const names = (tools: readonly { name: string }[]) => tools.map((t) => t.name)

const article = {
  type: 'articles',
  id: '1',
  attributes: { title: 'Hello' },
  relationships: {
    author: { data: { type: 'people', id: '7' } },
    subject: { data: { type: 'people', id: '9' } },
    gallery: { data: [{ type: 'images', id: '3' }] },
  },
}

describe('generator contract 16', () => {
  it('reads the witness', () => {
    expect(createJsonApiMcp(fixture('contract-witness')).contract).toBe(16)
  })

  it("filters the music catalogue's writes by the scopes it declares", async () => {
    // Its reads need the bearer scheme, which an OAuth token here also satisfies.
    const mcp = createJsonApiMcp({
      ...fixture('music-catalog'),
      credentialSchemes: ['oauth2', 'bearer'],
    })
    const playlists = mcp.operations.find((o) => o.toolName === 'playlists_delete')!
    expect(playlists.security).toEqual([{ oauth2: ['library:write', 'library:admin'] }])
    expect(playlists.scopes).toEqual(['library:write', 'library:admin'])
    const tools = names(
      (await mcp.forRequest({ grantedScopes: ['library:write'], context: {} })).tools,
    )
    expect(tools).toContain('albums_list')
    expect(tools).toContain('playlists_update')
    expect(tools).not.toContain('playlists_delete')
    expect(tools).not.toContain('albums_create')
  })

  describe('operation scopes', () => {
    const mcp = createJsonApiMcp(fixture('contract-witness'))
    const op = (tool: string) => mcp.operations.find((o) => o.toolName === tool)!

    it('puts the scopes in the security and on the operation', () => {
      expect(op('articles_get').security).toEqual([{ oauth2: ['articles:read'] }])
      expect(op('articles_get').scopes).toEqual(['articles:read'])
      expect(op('articles_author_get').scopes).toEqual(['articles:read', 'people:read'])
      expect(op('articles_publish').scopes).toEqual(['articles:publish'])
    })

    it('leaves them out when the operation needs none', () => {
      expect(op('people_list').scopes).toBeUndefined()
      expect(op('tags_get').scopes).toBeUndefined()
      expect(op('articles_report').scopes).toBeUndefined()
      expect('scopes' in op('tags_get')).toBe(false)
    })

    it('filters the tools by them', async () => {
      const tools = names(
        (await mcp.forRequest({ grantedScopes: ['articles:read'], context: {} })).tools,
      )
      expect(tools).toContain('articles_list')
      expect(tools).toContain('articles_get')
      expect(tools).toContain('articles_gallery_list')
      expect(tools).not.toContain('articles_create')
      expect(tools).not.toContain('articles_publish')
      // The related read also needs the read scope of the type it returns.
      expect(tools).not.toContain('articles_author_get')
      expect(tools).not.toContain('people_get')
      // Needs the bearer scheme, which isn't a credential scheme: left out.
      expect(tools).not.toContain('tags_get')
      // Public: kept.
      expect(tools).toContain('people_list')
    })

    it('hands them to the hooks', async () => {
      const seen = new Map<string, readonly string[] | undefined>()
      const hooked = createJsonApiMcp({
        ...fixture('contract-witness'),
        hooks: {
          includeOperation: (operation) => {
            seen.set(operation.toolName, operation.scopes)
            return true
          },
        },
      })
      await hooked.forRequest({ context: {} })
      expect(seen.get('articles_update')).toEqual(['articles:write'])
      expect(seen.get('tags_update')).toBeUndefined()
    })
  })

  describe('a polymorphic relation with one type', () => {
    const mcp = createJsonApiMcp(fixture('contract-witness'))
    const tool = (name: string) => mcp.tools.find((t) => t.name === name)!
    const input = (name: string) =>
      (tool(name).inputSchema as unknown as { properties: Record<string, JsonSchema> }).properties

    it('takes the type and id in inputs', () => {
      const identifier = {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['people'] },
          id: { type: 'string' },
        },
        required: ['type', 'id'],
        additionalProperties: false,
      }
      expect(input('articles_update')['subject']).toMatchObject({
        ...identifier,
        type: ['object', 'null'],
      })
      expect((input('articles_update')['gallery'] as { items: unknown }).items).toEqual({
        ...identifier,
        properties: { ...identifier.properties, type: { type: 'string', enum: ['images'] } },
      })
      // A to-one to a single type that isn't polymorphic still takes the id.
      expect(input('articles_update')['author']).toMatchObject({ type: ['string', 'null'] })
    })

    it('sends and returns the type and id', async () => {
      const { transport, requests } = fakeTransport(() => ({ json: { data: article } }))
      const session = await createJsonApiMcp({
        ...fixture('contract-witness'),
        transport,
      }).forRequest({ context: {} })
      const args = Object.fromEntries(
        Object.keys(input('articles_update')).map((key) => [key, null]),
      ) as Record<string, unknown>
      const result = await session.callTool('articles_update', {
        ...args,
        id: '1',
        subject: { type: 'people', id: '9' },
        gallery: [{ type: 'images', id: '3' }],
      })
      expect(result.isError).toBeUndefined()
      const sent = JSON.parse(requests[0]!.body!) as {
        data: { relationships: Record<string, unknown> }
      }
      expect(sent.data.relationships).toEqual({
        subject: { data: { type: 'people', id: '9' } },
        gallery: { data: [{ type: 'images', id: '3' }] },
      })
      expect(result.structuredContent).toMatchObject({
        author: '7',
        subject: { type: 'people', id: '9' },
        gallery: [{ type: 'images', id: '3' }],
      })
    })

    it('rejects a bare id', async () => {
      const session = await createJsonApiMcp({
        ...fixture('contract-witness'),
        transport: fakeTransport(() => ({ json: { data: article } })).transport,
      }).forRequest({ context: {} })
      const args = Object.fromEntries(
        Object.keys(input('articles_update')).map((key) => [key, null]),
      ) as Record<string, unknown>
      const result = await session.callTool('articles_update', { ...args, id: '1', subject: '9' })
      expect(result.isError).toBe(true)
    })

    it('outputs the type and id', () => {
      const output = JSON.stringify(tool('articles_get').outputSchema)
      expect(output).toContain(
        '"subject":{"anyOf":[{"type":"object","properties":{"type":{"type":"string","enum":["people"]}',
      )
    })
  })
})
