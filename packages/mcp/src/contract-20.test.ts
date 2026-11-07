import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema } from './openapi'
import { fakeTransport, fixture, modelOf, source } from './test-fixtures'

const sortArgument = (mcp: ReturnType<typeof createJsonApiMcp>, tool: string): JsonSchema => {
  const schema = mcp.tools.find((t) => t.name === tool)!.inputSchema as JsonSchema
  return (schema['properties'] as Record<string, JsonSchema>)['sort']!
}

describe('generator contract 20 (sort families)', () => {
  const mcp = createJsonApiMcp(fixture('contract-witness'))

  it('reads the witness', () => {
    expect(mcp.contract).toBe(23)
  })

  it('offers the fixed keys and describes each family in its own branch', () => {
    expect(sortArgument(mcp, 'articles_list')).toEqual({
      type: ['array', 'null'],
      items: {
        anyOf: [
          { type: 'string', enum: ['title', '-title', 'wordCount', '-wordCount'] },
          { type: 'string', enum: ['length', '-length'], description: 'Deprecated.' },
          {
            type: 'string',
            description:
              'Deprecated. `legacy.` followed by a name matching the regular expression `[^,]+`, optionally with a leading `-`.',
          },
          {
            type: 'string',
            description:
              '`meta.` followed by a name matching the regular expression `[a-z][a-z_]*`, optionally with a leading `-`.',
          },
          {
            type: 'string',
            description:
              '`custom.fields.` followed by a name matching the regular expression `[^,]+`, optionally with a leading `-`.',
          },
        ],
      },
      description:
        'Fields to sort by, in order. A leading `-` sorts that field descending. Leave null for the default order.',
    })
  })

  it('offers a lone family without the enum', () => {
    const { document } = source('contract-witness')
    const familyOnly = JSON.parse(JSON.stringify(document), (key, value: unknown) => {
      if (key !== 'parameters' || !Array.isArray(value)) {
        return value
      }
      return value.map((param: { name?: string; schema?: JsonSchema }) =>
        param.name === 'sort'
          ? {
              ...param,
              schema: {
                ...param.schema,
                items: { type: 'string', pattern: '^-?meta\\.(?:[a-z]+)$' },
                'x-sort-families': [{ prefix: 'meta', suffixPattern: '[a-z]+' }],
              },
            }
          : param,
      )
    }) as typeof document
    const items = sortArgument(createJsonApiMcp(modelOf(familyOnly)), 'articles_list')['items']
    expect(items).toEqual({
      type: 'string',
      description:
        '`meta.` followed by a name matching the regular expression `[a-z]+`, optionally with a leading `-`.',
    })
  })

  it('sends a family key as the model wrote it', async () => {
    const { transport, requests } = fakeTransport(() => ({ json: { data: [] } }))
    const session = await createJsonApiMcp({
      ...fixture('contract-witness'),
      transport,
    }).forRequest({ context: {} })
    await session.callTool('articles_list', { sort: ['-meta.views', 'title'] })
    expect(decodeURIComponent(requests[0]!.url)).toContain('sort=-meta.views,title')
  })
})
