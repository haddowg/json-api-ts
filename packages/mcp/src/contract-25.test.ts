import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument, OperationObject, ParameterObject } from './openapi'
import { fakeTransport, modelOf, source } from './test-fixtures'

/**
 * The witness with the two filtered collection actions core's witness declares: `count` takes
 * every filter of the collection read and `bulk-archive` takes `status`, `rating` and `labels`.
 */
function withActionFilters(doc: OpenApiDocument): OpenApiDocument {
  const out = structuredClone(doc)
  out.info!['x-generator'] = { ...out.info!['x-generator'], contract: 25 }
  const paths = out.paths!
  const filters = (paths['/articles']!.get!.parameters ?? []).filter(
    (param): param is ParameterObject => 'name' in param && param.name.startsWith('filter['),
  )
  const action = (from: OperationObject, id: string, keys?: readonly string[]) => {
    const op = structuredClone(from)
    delete op.requestBody
    op.operationId = `action.articles.${id}`
    op.parameters = filters.filter(
      (param) => keys === undefined || keys.includes(param.name.slice(7, -1)),
    )
    return op
  }
  paths['/articles/-actions/count'] = {
    get: action(paths['/articles/-actions/stats']!.get!, 'count'),
  }
  paths['/articles/-actions/bulk-archive'] = {
    post: action(paths['/articles/-actions/import']!.post!, 'bulk-archive', [
      'status',
      'rating',
      'labels',
    ]),
  }
  return out
}

const { model } = modelOf(withActionFilters(source('contract-witness').document))

type Mcp = ReturnType<typeof createJsonApiMcp>

const tool = (mcp: Mcp, name: string) => mcp.tools.find((t) => t.name === name)!

const properties = (mcp: Mcp, name: string) =>
  tool(mcp, name).inputSchema['properties'] as Record<string, JsonSchema>

describe('generator contract 25 (action filters)', () => {
  const mcp = createJsonApiMcp({ model })

  it('reads the document', () => {
    expect(mcp.contract).toBe(25)
  })

  it('offers a collection action the filter input its list tool has', () => {
    expect(properties(mcp, 'articles_count')['filter']).toEqual(
      properties(mcp, 'articles_list')['filter'],
    )
    expect(tool(mcp, 'articles_count').inputSchema['required']).toEqual(['filter'])
  })

  it('offers only the filters an action takes', () => {
    const filter = properties(mcp, 'articles_bulk_archive')['filter']!
    expect(filter['type']).toEqual(['object', 'null'])
    expect(Object.keys(filter['properties'] as object)).toEqual(['status', 'rating', 'labels'])
    expect(filter['required']).toEqual(['status', 'rating', 'labels'])
    expect(filter['additionalProperties']).toBe(false)
  })

  it('leaves an action without filters as it was', () => {
    expect(properties(mcp, 'articles_stats')).toEqual({})
  })

  it('sends the filters in the query string', async () => {
    const { transport, requests } = fakeTransport(() => ({ status: 204 }))
    const tools = await createJsonApiMcp({ model, transport }).forRequest({ context: undefined })
    const result = await tools.callTool('articles_bulk_archive', {
      filter: { status: 'draft', rating: { min: 2, max: null }, labels: ['a', 'b'] },
    })
    expect(result.isError).toBeUndefined()
    expect(requests[0]!.method).toBe('POST')
    expect(decodeURIComponent(requests[0]!.url)).toMatch(
      /\/articles\/-actions\/bulk-archive\?filter\[status\]=draft&filter\[rating\]\[min\]=2&filter\[labels\]=a,b$/,
    )
  })

  it('sends no query when the filters are null', async () => {
    const { transport, requests } = fakeTransport(() => ({ json: { meta: { total: 3 } } }))
    const tools = await createJsonApiMcp({ model, transport }).forRequest({ context: undefined })
    await tools.callTool('articles_count', { filter: null })
    expect(requests[0]!.method).toBe('GET')
    expect(requests[0]!.url).toMatch(/\/articles\/-actions\/count$/)
  })
})
