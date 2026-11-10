import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument } from './openapi'
import type { McpCallToolResult } from './types'
import { fakeTransport, modelOf, source } from './test-fixtures'

const MEMBERSHIP = 'MEMBERSHIP_CHANGE_PROHIBITED'

const witness = source('contract-witness').document

/** The witness without the fixed membership code: its branch, its example and its mentions. */
function withoutFixedMembership(): OpenApiDocument {
  return JSON.parse(JSON.stringify(witness), (key, value: unknown) => {
    if (key === MEMBERSHIP) {
      return undefined
    }
    return Array.isArray(value)
      ? value.filter(
          (entry: unknown) =>
            !(typeof entry === 'object' && entry !== null && 'const' in entry) ||
            entry.const !== MEMBERSHIP,
        )
      : value
  }) as OpenApiDocument
}

/**
 * The witness without its identified `MorphToMany`: no `sponsors` endpoints, no `sponsors` member
 * on any resource or request, and none of its components.
 */
function withoutIdentifiedPivots(): OpenApiDocument {
  const doc = JSON.parse(JSON.stringify(witness), (key, value: unknown) =>
    key === 'sponsors' ? undefined : value,
  ) as OpenApiDocument & {
    paths: Record<string, unknown>
    components: { schemas: Record<string, unknown> }
  }
  for (const path of Object.keys(doc.paths)) {
    if (path.endsWith('/sponsors')) {
      delete doc.paths[path]
    }
  }
  for (const name of Object.keys(doc.components.schemas)) {
    if (name.startsWith('ArticlesSponsors')) {
      delete doc.components.schemas[name]
    }
  }
  return doc
}

const json = (result: McpCallToolResult): unknown =>
  JSON.parse((result.content[0] as { text: string }).text)

function toolsOf(document: OpenApiDocument) {
  return createJsonApiMcp(modelOf(document))
}

function argument(mcp: ReturnType<typeof createJsonApiMcp>, tool: string, name: string) {
  const schema = mcp.tools.find((t) => t.name === tool)!.inputSchema as JsonSchema
  return (schema['properties'] as Record<string, JsonSchema>)[name]
}

const article = { data: { type: 'articles', id: 'art-1', attributes: { title: 'Hello' } } }

/**
 * Core's witness has two contract 30 tiers. Articles' `sponsors` is a polymorphic to-many
 * identified by its link rows: its reads filter by `minRank` and sort by the pivot fields `rank`
 * and `since`, and a write may set each member's `rank` as its `meta.pivot`. Its `tags` fix their
 * members, so a replacement that changes them fails with `MEMBERSHIP_CHANGE_PROHIBITED`.
 */
describe('generator contract 30 (identified pivots and fixed membership)', () => {
  const mcp = toolsOf(witness)

  it('reads the witness', () => {
    expect(mcp.contract).toBe(31)
  })

  it("offers the relation's own filters and sorts on its related read", () => {
    expect(argument(mcp, 'articles_sponsors_list', 'filter')).toMatchObject({
      type: ['object', 'null'],
      properties: { minRank: { type: ['integer', 'null'] } },
      required: ['minRank'],
    })
    expect(argument(mcp, 'articles_sponsors_list', 'sort')).toMatchObject({
      type: ['array', 'null'],
      items: { type: 'string', enum: ['rank', '-rank', 'since', '-since'] },
    })
  })

  it('sends them', async () => {
    const { transport, requests } = fakeTransport(() => ({ json: { data: [] } }))
    const tools = await createJsonApiMcp({ ...modelOf(witness), transport }).forRequest({
      context: undefined,
    })
    const result = await tools.callTool('articles_sponsors_list', {
      id: 'art-1',
      filter: { minRank: 2 },
      sort: ['-rank', 'since'],
    })
    expect(result.isError).toBeUndefined()
    expect(decodeURIComponent(requests[0]!.url)).toMatch(
      /\/articles\/art-1\/sponsors\?filter\[minRank\]=2&sort=-rank,since(&|$)/,
    )
  })

  it.each(['articles_create', 'articles_update'])(
    'takes %s a pivot on each polymorphic member',
    (tool) => {
      expect(argument(mcp, tool, 'sponsors')).toEqual({
        type: ['array', 'null'],
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['people', 'images'] },
            id: { type: 'string' },
            pivot: {
              type: ['object', 'null'],
              properties: { rank: { type: 'integer' } },
              required: ['rank'],
              additionalProperties: false,
              description:
                'The values stored on this membership, sent as its `meta.pivot`. Leave null to send none.',
            },
          },
          required: ['type', 'id', 'pivot'],
          additionalProperties: false,
        },
        description:
          'The sponsors relationship: every related resource, as its type (people or images) and id, with any values stored on its membership.',
      })
    },
  )

  it('takes no pivot on a polymorphic relation without one', () => {
    const attachments = argument(mcp, 'articles_update', 'attachments')!
    expect(JSON.stringify(attachments)).not.toContain('pivot')
  })

  it('sends each pivot as the member’s meta.pivot', async () => {
    const { transport, requests } = fakeTransport(() => ({ json: article }))
    const tools = await createJsonApiMcp({ ...modelOf(witness), transport }).forRequest({
      context: undefined,
    })
    const result = await tools.callTool('articles_update', {
      id: 'art-1',
      sponsors: [
        { type: 'people', id: 'per-1', pivot: { rank: 1 } },
        { type: 'images', id: 'img-1', pivot: null },
      ],
    })
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(requests[0]!.body!) as { data: { relationships: unknown } }
    expect(body.data.relationships).toEqual({
      sponsors: {
        data: [
          { type: 'people', id: 'per-1', meta: { pivot: { rank: 1 } } },
          { type: 'images', id: 'img-1' },
        ],
      },
    })
  })

  it('reports a membership change the relation refuses with its code', async () => {
    const { transport } = fakeTransport(() => ({
      status: 403,
      json: {
        errors: [
          {
            status: '403',
            code: MEMBERSHIP,
            detail: "Changing the members of relationship 'tags' is prohibited!",
            source: { pointer: '/data/relationships/tags' },
          },
        ],
      },
    }))
    const tools = await createJsonApiMcp({ ...modelOf(witness), transport }).forRequest({
      context: undefined,
    })
    const result = await tools.callTool('articles_update', { id: 'art-1', tags: ['tag-2'] })
    expect(result.isError).toBe(true)
    expect(json(result)).toMatchObject({
      status: 403,
      errors: [{ code: MEMBERSHIP, path: 'tags' }],
    })
  })
})

/** A document stamped 30 may carry one tier without the other. */
describe('generator contract 30 from identified pivots alone', () => {
  const document = withoutFixedMembership()
  const mcp = toolsOf(document)

  it('reads the document', () => {
    expect(document.info?.['x-generator']?.contract).toBe(31)
    expect(JSON.stringify(document)).not.toContain(MEMBERSHIP)
    expect(mcp.contract).toBe(31)
  })

  it('offers the same sponsors inputs as the full witness', () => {
    const full = toolsOf(witness)
    for (const [tool, name] of [
      ['articles_sponsors_list', 'filter'],
      ['articles_sponsors_list', 'sort'],
      ['articles_update', 'sponsors'],
    ] as const) {
      expect(argument(mcp, tool, name)).toEqual(argument(full, tool, name))
    }
  })
})

describe('generator contract 30 from fixed membership alone', () => {
  const document = withoutIdentifiedPivots()
  const mcp = toolsOf(document)

  it('reads the document', () => {
    expect(document.info?.['x-generator']?.contract).toBe(31)
    expect(JSON.stringify(document)).toContain(MEMBERSHIP)
    expect(mcp.contract).toBe(31)
  })

  it('offers no sponsors and no pivot', () => {
    expect(mcp.tools.map((tool) => tool.name)).not.toContain('articles_sponsors_list')
    expect(argument(mcp, 'articles_update', 'sponsors')).toBeUndefined()
    expect(JSON.stringify(mcp.tools.map((tool) => tool.inputSchema))).not.toContain('"pivot"')
  })
})
