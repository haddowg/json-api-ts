import { describe, expect, it } from 'vitest'
import { assertContract, MAXIMUM_CONTRACT, MINIMUM_CONTRACT } from './contract'
import { createJsonApiMcp } from './mcp'
import { parseOperationId, ToolNameError } from './names'
import type { OpenApiDocument } from './openapi'
import { readActionSafety, SAFETY_EXTENSION } from './safety'
import { fixture, modelOf, source } from './test-fixtures'
import type { McpTool } from './types'

const tool = (tools: readonly McpTool[], name: string): McpTool => {
  const found = tools.find((t) => t.name === name)
  if (found === undefined) throw new Error(`no tool ${name}`)
  return found
}

/** The music catalogue with one path's operation changed. */
function withOperation(
  path: string,
  method: 'get' | 'post',
  change: (op: Record<string, unknown>) => Record<string, unknown>,
) {
  const { document, descriptor } = source('music-catalog')
  const doc = structuredClone(document) as OpenApiDocument
  const item = doc.paths![path]!
  item[method] = change(item[method] as Record<string, unknown>)
  return { document: doc, descriptor }
}

/** The model for the music catalogue with one path's operation changed. */
function withOperationModel(...args: Parameters<typeof withOperation>) {
  const { document, descriptor } = withOperation(...args)
  return modelOf(document, descriptor)
}

describe('names', () => {
  it('parses the operation ids that become tools, and only those', () => {
    expect(parseOperationId('fetchCollection.albums')).toEqual({ kind: 'list', type: 'albums' })
    expect(parseOperationId('fetchRelated.albums.artist')).toEqual({
      kind: 'related',
      type: 'albums',
      relation: 'artist',
    })
    expect(parseOperationId('action.files.complete')).toEqual({
      kind: 'action',
      type: 'files',
      action: 'complete',
    })
    expect(parseOperationId('action.files.purge.post')).toEqual({
      kind: 'action',
      type: 'files',
      action: 'purge',
      method: 'post',
    })
    expect(parseOperationId('fetchRelationship.albums.artist')).toBeUndefined()
    expect(parseOperationId('updateRelationship.albums.tracks')).toBeUndefined()
    expect(parseOperationId('atomic.operations')).toBeUndefined()
  })

  it('names tools noun first, by verb and relation cardinality, snake_casing kebab-case', () => {
    const mcp = createJsonApiMcp(fixture('music-catalog'))
    const names = mcp.tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'albums_list',
        'albums_get',
        'albums_create',
        'albums_update',
        'albums_delete',
        'albums_artist_get',
        'albums_tracks_list',
        'albums_reissue',
        'albums_export',
        'catalog_exports_list',
        'public_profiles_get',
      ]),
    )
    expect(names.some((n) => n.includes('relationship') || n.includes('atomic'))).toBe(false)
    expect(names.filter((n) => n.startsWith('albums_tracks'))).toEqual(['albums_tracks_list'])
    // oxlint-disable-next-line no-underscore-dangle -- MCP names the field `_meta`
    expect(tool(mcp.tools, 'albums_get')._meta).toEqual({ operationId: 'fetchOne.albums' })
    expect(createJsonApiMcp(fixture('contract-witness')).tools.map((t) => t.name)).toContain(
      'articles_bulk_import',
    )
  })

  it('adds the method to each tool of a multi-method action', () => {
    const mcp = createJsonApiMcp(fixture('contract-witness'))
    const names = mcp.tools.map((t) => t.name)
    expect(names).toContain('articles_export_get')
    expect(names).toContain('articles_export_post')
    expect(names).not.toContain('articles_export')
    expect(tool(mcp.tools, 'articles_export_get').inputSchema['properties']).toEqual({})
  })

  it('fails the build on a clash, naming both operations', () => {
    const options = withOperation('/albums/-actions/summary', 'post', (op) => ({
      ...op,
      operationId: 'action.albums.list',
    }))
    const descriptor = structuredClone(options.descriptor) as typeof options.descriptor
    const albums = descriptor['albums']!
    ;(albums as { actions: Record<string, unknown> }).actions = {
      ...albums.actions,
      list: albums.actions!['summary']!,
    }
    expect(() => modelOf(options.document, descriptor)).toThrow(
      /"albums_list" is the tool name of fetchCollection\.albums and action\.albums\.list/,
    )
  })

  it('fails the build on a name over 64 characters or outside [a-zA-Z0-9_-]', () => {
    const { document, descriptor } = source('music-catalog')
    const long = 'a'.repeat(60)
    const doc = structuredClone(document) as OpenApiDocument
    doc.paths![`/${long}`] = { get: { operationId: `fetchCollection.${long}`, responses: {} } }
    doc.paths!['/café'] = { get: { operationId: 'fetchCollection.café', responses: {} } }
    const wider = {
      ...descriptor,
      [long]: descriptor['albums']!,
      café: descriptor['albums']!,
    }
    let error: unknown
    try {
      modelOf(doc, wider)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ToolNameError)
    expect((error as ToolNameError).problems).toEqual([
      `"${long}_list" (fetchCollection.${long}) is 65 characters; tool names allow 64`,
      '"café_list" (fetchCollection.café) has characters outside [a-zA-Z0-9_-]',
    ])
  })

  it('skips an action whose only bodies a model cannot send, and says why', () => {
    const mcp = createJsonApiMcp(fixture('music-catalog'))
    expect(mcp.skipped).toEqual([
      {
        operationId: 'action.albums.artwork',
        reason:
          'every request media type it accepts is one a model cannot send, such as a binary upload',
      },
    ])
  })
})

const document = (contract: unknown): OpenApiDocument => ({
  info: contract === undefined ? {} : { 'x-generator': { contract } },
})

describe('contract', () => {
  it('reads the range it pins', () => {
    expect(MINIMUM_CONTRACT).toBe(13)
    expect(MAXIMUM_CONTRACT).toBe(17)
    for (const contract of [13, 14, 15, 16, 17]) {
      expect(assertContract(document(contract))).toBe(contract)
    }
  })

  it.each([
    [12, /older than this package reads \(13 to 17\)/],
    [18, /newer than this package reads \(13 to 17\)\. Upgrade @haddowg\/json-api-mcp/],
    [undefined, /declares no generator contract/],
  ])('fails clearly on contract %s', (contract, message) => {
    expect(() => assertContract(document(contract))).toThrow(message)
    const { descriptor } = source('music-catalog')
    expect(() => modelOf(document(contract), descriptor)).toThrow(message)
  })

  it.each([12, 18])('refuses a model built from contract %s at runtime', (contract) => {
    const { model } = fixture('music-catalog')
    expect(() => createJsonApiMcp({ model: { ...model, contract } })).toThrow(
      new RegExp(`generator contract ${contract}, and this runtime reads contracts 13 to 17`),
    )
  })

  it('refuses something that is not a model, or a model of another format', () => {
    const { model } = fixture('music-catalog')
    expect(() => createJsonApiMcp({ model: {} })).toThrow(/isn't a model written by/)
    expect(() => createJsonApiMcp({ model: { ...model, format: 4 } })).toThrow(
      /format 4 and this runtime reads formats 1, 2 and 3/,
    )
    const { credentialSchemes: _schemes, ...listless } = model
    expect(() => createJsonApiMcp({ model: listless })).toThrow(/no credentialSchemes list/)
  })
})

describe('annotations', () => {
  it('derives hints from the operation kind', () => {
    const tools = createJsonApiMcp(fixture('music-catalog')).tools
    expect(tool(tools, 'albums_list').annotations).toEqual({ readOnlyHint: true })
    expect(tool(tools, 'albums_artist_get').annotations).toEqual({ readOnlyHint: true })
    expect(tool(tools, 'albums_create').annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    })
    expect(tool(tools, 'albums_delete').annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    })
  })

  it('gives an action no hints until it declares its safety', () => {
    const tools = createJsonApiMcp(fixture('music-catalog')).tools
    expect(tool(tools, 'albums_import').annotations).toBeUndefined()
    expect(tool(tools, 'albums_reissue').annotations).toBeUndefined()
    expect(tool(tools, 'albums_export').annotations).toEqual({ readOnlyHint: true })
  })

  it('reads the declared flags from x-safety', () => {
    expect(SAFETY_EXTENSION).toBe('x-safety')
    const mcp = createJsonApiMcp(
      withOperationModel('/albums/{id}/-actions/reissue', 'post', (op) => ({
        ...op,
        'x-safety': { destructive: true, idempotent: true },
      })),
    )
    expect(tool(mcp.tools, 'albums_reissue').annotations).toEqual({
      destructiveHint: true,
      idempotentHint: true,
    })
    const readOnly = createJsonApiMcp(
      withOperationModel('/albums/-actions/summary', 'post', (op) => ({
        ...op,
        'x-safety': { readOnly: true },
      })),
    )
    expect(tool(readOnly.tools, 'albums_summary').annotations).toEqual({ readOnlyHint: true })
  })

  it('reads the safety the contract witness declares', () => {
    const tools = createJsonApiMcp(fixture('contract-witness')).tools
    expect(tool(tools, 'articles_preview').annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    })
    expect(tool(tools, 'articles_purge').annotations).toEqual({ destructiveHint: true })
    expect(tool(tools, 'articles_publish').annotations).toBeUndefined()
  })

  it('reads the safety a descriptor carries without x-safety on the operation', () => {
    const catalog = source('music-catalog')
    const albums = catalog.descriptor['albums']!
    const withSafety = {
      ...catalog.descriptor,
      albums: {
        ...albums,
        actions: { ...albums.actions, summary: { ...albums.actions!['summary']!, readOnly: true } },
      },
    }
    const tools = createJsonApiMcp(modelOf(catalog.document, withSafety)).tools
    expect(tool(tools, 'albums_summary').annotations).toEqual({ readOnlyHint: true })
  })

  it('reads nothing from a malformed x-safety', () => {
    expect(readActionSafety({ 'x-safety': true })).toEqual({})
    expect(readActionSafety({ 'x-safety': { readOnly: 'yes', destructive: false } })).toEqual({
      destructive: false,
    })
  })
})

describe('descriptions', () => {
  it('uses the operation description, with the summary as the title', () => {
    const albums = tool(createJsonApiMcp(fixture('music-catalog')).tools, 'albums_import')
    expect(albums.title).toBe('Import albums from a file')
    expect(albums.description).toMatch(/^Creates albums from a CSV export/)
  })
})
