import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema } from './openapi'
import { fakeTransport, modelOf, source } from './test-fixtures'

const { model } = modelOf(source('contract-witness').document)

/**
 * Core's witness declares list filters on articles, `categories` (comma form too) and `columns`
 * (array form only), and filter families: `value` and `exact` take lists, `meta` one value and
 * `legacy` is deprecated.
 */
describe('generator contract 27 (list filters and filter families)', () => {
  const mcp = createJsonApiMcp({ model })
  const filter = (name: string) =>
    (
      mcp.tools.find((t) => t.name === name)!.inputSchema['properties'] as Record<
        string,
        JsonSchema
      >
    )['filter']!
  const members = (name: string) => filter(name)['properties'] as Record<string, JsonSchema>

  it('reads the document', () => {
    expect(mcp.contract).toBe(27)
  })

  it('takes a list filter as one array member', () => {
    const properties = members('articles_list')
    expect(properties['columns']).toMatchObject({
      type: ['array', 'null'],
      items: { type: 'string' },
    })
    expect(properties['categories']).toMatchObject({ type: ['array', 'null'] })
    expect(Object.keys(properties).filter((key) => key.includes('['))).toEqual([])
  })

  it('takes each family as a list of named entries, closed for strict tool schemas', () => {
    const properties = members('articles_list')
    expect(properties['value.']).toEqual({
      type: ['array', 'null'],
      description:
        'Filters on keys of the form `value.<name>`, one entry per key. Leave null to apply none.',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'The part of the key after `value.`, matching the regular expression `.+`.',
          },
          value: {
            type: 'array',
            items: { type: 'string' },
            description: 'The values to match, any of them.',
          },
        },
        required: ['name', 'value'],
        additionalProperties: false,
      },
    })
    expect(properties['meta.']).toMatchObject({
      items: { properties: { value: { type: 'string', description: 'The value to match.' } } },
    })
    expect(String(properties['legacy.']!['description'])).toMatch(/^Deprecated\. /)
    expect(filter('articles_list')['additionalProperties']).toBe(false)
  })

  it('offers the same filter input on a collection action taking every filter', () => {
    expect(filter('articles_count')).toEqual(filter('articles_list'))
  })

  it('sends list members and family entries as the server reads them', async () => {
    const { transport, requests } = fakeTransport(() => ({ json: { data: [] } }))
    const tools = await createJsonApiMcp({ model, transport }).forRequest({ context: undefined })
    const result = await tools.callTool('articles_list', {
      filter: {
        columns: ['last,first', 'email'],
        'value.': [{ name: 'cap', value: ['x,y'] }],
        'meta.': [{ name: 'colour', value: 'red' }],
        'exact.': null,
      },
    })
    expect(result.isError).toBeUndefined()
    const query = decodeURIComponent(requests[0]!.url.split('?')[1]!)
    expect(query).toContain(
      'filter[columns][]=last,first&filter[columns][]=email&filter[value.cap][]=x,y&filter[meta.colour]=red',
    )
    expect(query).not.toContain('exact')
  })
})
