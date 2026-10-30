import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import { fixture } from './test-fixtures'
import type { JsonSchema } from './openapi'
import type { McpCallToolResult, McpTool } from './types'

const tools = createJsonApiMcp(fixture('music-catalog')).tools
const witness = createJsonApiMcp(fixture('contract-witness')).tools
const find = (list: readonly McpTool[], name: string): McpTool => list.find((t) => t.name === name)!
const props = (schema: JsonSchema) => schema['properties'] as Record<string, JsonSchema>

describe('input schemas', () => {
  it('says a relationship only has a value when it is also included', () => {
    expect(props(find(tools, 'albums_get').inputSchema)['fields']!['description']).toContain(
      'A relationship only has a value in the result when it is also included.',
    )
  })

  it('gives a get tool an id, include and fields, and no paging', () => {
    expect(Object.keys(props(find(tools, 'albums_get').inputSchema))).toEqual([
      'id',
      'include',
      'fields',
    ])
    expect(find(tools, 'albums_get').inputSchema['required']).toEqual(['id', 'include', 'fields'])
  })

  it('requires only what the API requires on a create, and leaves out a forbidden client id', () => {
    const input = find(tools, 'albums_create').inputSchema
    expect(props(input)['title']).toMatchObject({ type: 'string' })
    expect(props(input)['releasedAt']).toMatchObject({
      type: ['string', 'null'],
      format: 'date-time',
    })
    expect(props(input)['id']).toBeUndefined()
    expect(props(input)['artist']).toMatchObject({ type: ['string', 'null'] })
    expect(props(input)['tracks']).toMatchObject({
      type: ['array', 'null'],
      items: { type: 'string' },
    })
  })

  it('takes a polymorphic relation as type and id', () => {
    const attachments = props(find(witness, 'articles_create').inputSchema)['attachments']!
    expect(attachments).toMatchObject({
      type: ['array', 'null'],
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['images', 'videos'] },
          id: { type: 'string' },
        },
        required: ['type', 'id'],
        additionalProperties: false,
      },
    })
  })

  it('moves constraints a strict schema cannot hold into the description', () => {
    expect(props(find(tools, 'albums_create').inputSchema)['title']!['description']).toBe(
      'Between 1 and 200 characters.',
    )
  })

  it('offers pageSize and pageLink only where a collection paginates', () => {
    expect(props(find(tools, 'albums_list').inputSchema)['pageSize']).toBeDefined()
    expect(props(find(tools, 'countries_list').inputSchema)['pageSize']).toBeUndefined()
    expect(props(find(tools, 'countries_list').inputSchema)['pageLink']).toBeUndefined()
    expect(props(find(witness, 'tags_list').inputSchema)['pageSize']!['description']).toBe(
      'How many results a page holds, 1 to 100. Leave null for 10.',
    )
  })

  it('takes no arguments for a collection action without a body', () => {
    expect(find(tools, 'albums_summary').inputSchema).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    })
  })
})

describe('output schemas', () => {
  it('flattens a resource with optional attributes and id-or-resource relations', () => {
    const get = find(tools, 'albums_get').outputSchema!
    expect(get['required']).toEqual(['data'])
    expect(props(get)['data']).toEqual({ $ref: '#/$defs/albums', description: 'The resource.' })
    const output = find(tools, 'albums_update').outputSchema!
    expect(output['required']).toEqual(['data'])
    const defs = output['$defs'] as Record<string, JsonSchema>
    expect(new Set(Object.keys(defs))).toEqual(new Set(['albums', 'artists', 'tracks']))
    expect(defs['albums']!['required']).toEqual(['id', 'type'])
    expect(props(defs['albums']!)['title']).toMatchObject({ type: 'string' })
    expect(props(defs['albums']!)['artist']).toEqual({
      anyOf: [{ type: 'string' }, { $ref: '#/$defs/artists' }, { type: 'null' }],
      description: 'The related artists: its id, or the resource itself when included.',
    })
    expect(JSON.stringify(tools.map((t) => t.outputSchema))).not.toMatch(/"examples?"/)
  })

  it('wraps a create in data', () => {
    const output = find(tools, 'albums_create').outputSchema!
    expect(output['required']).toEqual(['data'])
    expect(props(output)['data']).toEqual({ $ref: '#/$defs/albums', description: 'The resource.' })
  })

  it('describes a collection as data, pagination links and meta', () => {
    const output = find(tools, 'albums_list').outputSchema!
    expect(output['required']).toEqual(['data', 'links'])
    expect(props(output)['data']).toMatchObject({
      type: 'array',
      items: { $ref: '#/$defs/albums' },
    })
    expect(Object.keys(props(props(output)['links']!))).toEqual(['first', 'prev', 'next', 'last'])
  })

  it('describes a delete as null data', () => {
    const output = find(tools, 'albums_delete').outputSchema!
    expect(output['required']).toEqual(['data'])
    expect(props(output)['data']).toMatchObject({ type: 'null' })
  })

  it('describes a meta-only action as meta with no data', () => {
    const output = find(tools, 'albums_summary').outputSchema!
    expect(output['required']).toEqual(['meta'])
    expect(props(output)['data']).toBeUndefined()
  })

  it('wraps a to-one related read in data, nullable', () => {
    const output = find(tools, 'albums_artist_get').outputSchema!
    expect(output['required']).toEqual(['data'])
    expect(props(output)['data']!['anyOf']).toEqual([{ $ref: '#/$defs/artists' }, { type: 'null' }])
  })
})

describe('MCP SDK compatibility', () => {
  it('assigns to the SDK types without depending on the SDK', () => {
    const tool: Tool = find(tools, 'albums_list')
    const result: McpCallToolResult = { content: [{ type: 'text', text: 'ok' }], isError: false }
    const sdkResult: CallToolResult = result
    expect(tool.name).toBe('albums_list')
    expect(sdkResult.isError).toBe(false)
  })
})

describe('withCount', () => {
  it('is offered only where the endpoint counts its own collection', () => {
    expect(props(find(witness, 'articles_list').inputSchema)['withCount']).toMatchObject({
      type: ['boolean', 'null'],
    })
    // The albums collection counts only its tracks relation, not itself.
    expect(props(find(tools, 'albums_list').inputSchema)['withCount']).toBeUndefined()
    expect(
      witness.filter((t) => props(t.inputSchema)['withCount'] !== undefined).map((t) => t.name),
    ).toEqual(expect.arrayContaining(['articles_list']))
  })
})
