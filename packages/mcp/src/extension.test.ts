import { describe, expect, it } from 'vitest'
import { MCP_EXTENSION } from './extension'
import { createJsonApiMcp } from './mcp'
import { ToolNameError } from './names'
import type { HttpMethod, OpenApiDocument } from './openapi'
import { modelOf, source } from './test-fixtures'

/** The music catalogue model with `x-mcp` set on the given operations. */
function withXMcp(...ops: [path: string, method: HttpMethod, value: unknown][]) {
  const { document, descriptor } = source('music-catalog')
  const doc = structuredClone(document) as OpenApiDocument
  for (const [path, method, value] of ops) {
    doc.paths![path]![method]![MCP_EXTENSION] = value
  }
  return modelOf(doc, descriptor)
}

const names = (model: ReturnType<typeof withXMcp>['model']): string[] =>
  createJsonApiMcp({ model }).tools.map((t) => t.name)

const albumsGet = (model: ReturnType<typeof withXMcp>['model']) =>
  model.tools.find((t) => t.tool.name === 'albums_get')!.tool

describe('x-mcp', () => {
  it('leaves out a CRUD operation, a related read and an action set to false', () => {
    const { model } = withXMcp(
      ['/albums/{id}', 'delete', false],
      ['/albums/{id}/tracks', 'get', false],
      ['/albums/{id}/-actions/reissue', 'post', false],
    )
    const listed = names(model)
    expect(listed).not.toContain('albums_delete')
    expect(listed).not.toContain('albums_tracks_list')
    expect(listed).not.toContain('albums_reissue')
    expect(listed).toContain('albums_get')
    expect(model.tools.map((t) => t.operation.operationId)).not.toEqual(
      expect.arrayContaining(['delete.albums']),
    )
    expect(model.skipped).toEqual(
      expect.arrayContaining([
        { operationId: 'delete.albums', reason: 'excluded by x-mcp' },
        { operationId: 'fetchRelated.albums.tracks', reason: 'excluded by x-mcp' },
        { operationId: 'action.albums.reissue', reason: 'excluded by x-mcp' },
      ]),
    )
  })

  it('drops the tool before includeOperation runs, so it cannot be called', async () => {
    const { model } = withXMcp(['/albums/{id}', 'delete', false])
    const seen: string[] = []
    const mcp = createJsonApiMcp({
      model,
      hooks: {
        includeOperation: (op) => {
          seen.push(op.operationId)
          return true
        },
      },
    })
    const session = await mcp.forRequest({ context: {} })
    expect(seen).not.toContain('delete.albums')
    expect(seen).toContain('fetchOne.albums')
    const result = await session.callTool('albums_delete', { id: '1' })
    expect(result.isError).toBe(true)
  })

  it('keeps the tool unchanged for true', () => {
    const plain = modelOf(source('music-catalog').document).model
    const { model } = withXMcp(['/albums/{id}', 'get', true])
    expect(albumsGet(model)).toEqual(albumsGet(plain))
    expect(model.skipped).toEqual(plain.skipped)
  })

  it('ignores x-mcp on a relationship endpoint, which is never a tool', () => {
    const plain = modelOf(source('music-catalog').document).model
    const { model } = withXMcp(['/albums/{id}/relationships/artist', 'get', 'not even valid'])
    expect(model.tools.map((t) => t.tool.name)).toEqual(plain.tools.map((t) => t.tool.name))
    expect(model.skipped).toEqual(plain.skipped)
  })

  it('replaces the name, title and description an object sets, ignoring other members', () => {
    const { model } = withXMcp(
      ['/albums', 'get', { name: 'browse_albums', colour: 'blue' }],
      ['/albums/{id}', 'get', { title: 'Look up an album' }],
      ['/albums/{id}/-actions/reissue', 'post', { description: 'Reissue an album.' }],
    )
    const byOp = (id: string) => model.tools.find((t) => t.operation.operationId === id)!

    const list = byOp('fetchCollection.albums')
    expect(list.tool.name).toBe('browse_albums')
    expect(list.operation.toolName).toBe('browse_albums')
    expect(list.tool.title).toBe('List albums')
    expect(names(model)).not.toContain('albums_list')

    const get = byOp('fetchOne.albums')
    expect(get.tool.name).toBe('albums_get')
    expect(get.tool.title).toBe('Look up an album')

    const reissue = byOp('action.albums.reissue')
    expect(reissue.tool.description).toBe('Reissue an album.')
    expect(reissue.tool.title).toBe('Invoke the `reissue` action')
  })

  it('calls a renamed tool by its new name', async () => {
    const { model } = withXMcp(['/albums', 'get', { name: 'browse_albums' }])
    const session = await createJsonApiMcp({ model }).forRequest({ context: {} })
    expect(session.tools.map((t) => t.name)).toContain('browse_albums')
    const missing = await session.callTool('albums_list', {})
    expect(missing.isError).toBe(true)
  })

  it('holds a name override to the tool name rules', () => {
    const long = 'a'.repeat(65)
    let error: unknown
    try {
      withXMcp(['/albums', 'get', { name: long }], ['/artists', 'get', { name: 'list artists' }])
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ToolNameError)
    expect((error as ToolNameError).problems).toEqual([
      `"${long}" (fetchCollection.albums) is 65 characters; tool names allow 64`,
      '"list artists" (fetchCollection.artists) has characters outside [a-zA-Z0-9_-]',
    ])
  })

  it('reports a name override that clashes with another tool', () => {
    expect(() => withXMcp(['/albums/{id}', 'get', { name: 'artists_list' }])).toThrow(
      /"artists_list" is the tool name of (fetchOne\.albums and fetchCollection\.artists|fetchCollection\.artists and fetchOne\.albums)/,
    )
  })

  it.each([
    ['a string', 'no', /fetchOne\.albums declares x-mcp as "no"/],
    ['a number', 0, /fetchOne\.albums declares x-mcp as 0/],
    ['null', null, /fetchOne\.albums declares x-mcp as null/],
    ['a list', [], /fetchOne\.albums declares x-mcp as \[\]/],
    ['a member of the wrong type', { title: 3 }, /fetchOne\.albums declares x-mcp\.title as 3/],
  ])('fails the build on %s', (_, value, message) => {
    expect(() => withXMcp(['/albums/{id}', 'get', value])).toThrow(message)
  })
})
