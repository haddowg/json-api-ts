import type { ApiDescriptor } from '@haddowg/json-api-client'
import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { McpModelTool } from './model'
import { deref, type JsonSchema, type OpenApiDocument, type OperationObject } from './openapi'
import { fixture, source } from './test-fixtures'

type Fixture = 'music-catalog' | 'contract-witness'

/** The include paths an operation declares, read straight from the document. */
function declared(document: OpenApiDocument, operationId: string): string[] {
  for (const item of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(item) as OperationObject[]) {
      if (operation?.operationId !== operationId) continue
      for (const raw of operation.parameters ?? []) {
        const param = deref<{ name?: string; schema?: JsonSchema }>(document, raw)
        if (param?.name !== 'include') continue
        const items = deref<JsonSchema>(document, param.schema?.['items'] as JsonSchema)
        return (items?.['enum'] as string[] | undefined) ?? []
      }
    }
  }
  return []
}

/** The types a tool's result is made of before anything is included. */
function primaryTypes(descriptor: ApiDescriptor, tool: McpModelTool): string[] {
  const { operation } = tool
  if (operation.kind === 'related') {
    return [...(descriptor[operation.type]?.relations[operation.relation!]?.types ?? [])]
  }
  if (operation.kind === 'action') {
    const action = descriptor[operation.type]?.actions?.[operation.actionKey!]
    return action?.outputType === undefined ? [] : [action.outputType]
  }
  return [operation.type]
}

/** Every type the paths reach from the primary types, walking one relation per segment. */
function reach(descriptor: ApiDescriptor, primary: string[], paths: string[]): Set<string> {
  const out = new Set(primary)
  for (const path of paths) {
    let current = primary
    for (const segment of path.split('.')) {
      current = current.flatMap((type) => [...(descriptor[type]?.relations[segment]?.types ?? [])])
      for (const type of current) out.add(type)
    }
  }
  return out
}

describe.each([1, 2, null])('include depth %s', (depth) => {
  describe.each<Fixture>(['music-catalog', 'contract-witness'])('%s', (name) => {
    const { document } = source(name)
    const { model } = fixture(name, { includeDepth: depth })
    const within = (path: string) => depth === null || path.split('.').length <= depth

    it('records the depth', () => {
      expect(model.includeDepth).toBe(depth)
    })

    it.each(model.tools.map((t) => [t.tool.name, t] as const))(
      '%s has no $defs it cannot reach',
      (_, tool) => {
        const allowed = declared(document, tool.operation.operationId).filter(within)
        const reachable = reach(model.descriptor, primaryTypes(model.descriptor, tool), allowed)
        const defs = Object.keys((tool.tool.outputSchema?.['$defs'] as object | undefined) ?? {})
        expect(defs.filter((type) => !reachable.has(type))).toEqual([])
      },
    )

    it.each(model.tools.map((t) => [t.tool.name, t] as const))(
      '%s lists only the include paths within the depth',
      (_, tool) => {
        const include = (tool.tool.inputSchema['properties'] as Record<string, JsonSchema>)[
          'include'
        ]
        const allowed = ['list', 'get', 'related'].includes(tool.operation.kind)
          ? declared(document, tool.operation.operationId).filter(within)
          : []
        if (allowed.length === 0) {
          expect(include).toBeUndefined()
          expect(tool.plan.query?.include ?? false).toBe(false)
          return
        }
        expect(include).toMatchObject({ type: ['array', 'null'], items: { enum: allowed } })
        expect(tool.plan.query?.includePaths).toEqual(allowed)
      },
    )
  })
})

describe('include depth 1', () => {
  it('keeps a well-connected tool to its direct relations', () => {
    const { model } = fixture('music-catalog')
    const list = model.tools.find((t) => t.tool.name === 'albums_list')!
    expect(new Set(Object.keys(list.tool.outputSchema!['$defs'] as object))).toEqual(
      new Set(['albums', 'artists', 'tracks']),
    )
    const track = (list.tool.outputSchema!['$defs'] as Record<string, JsonSchema>)['tracks']!
    // Playlists are two relations away, so a track's playlists stay ids.
    expect((track['properties'] as Record<string, JsonSchema>)['playlists']).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    })
  })
})

describe('security is stored once', () => {
  for (const name of ['music-catalog', 'contract-witness'] as const) {
    const { document } = source(name)
    const { model } = fixture(name)

    it(`${name}: each tool's security appears once in the serialised model`, () => {
      for (const tool of model.tools) {
        expect(tool.operation.operation['security']).toBeUndefined()
        expect(tool.operation.scopes).toBeUndefined()
        const raw = Object.values(document.paths ?? {})
          .flatMap((item) => Object.values(item) as OperationObject[])
          .find((o) => o?.operationId === tool.operation.operationId)!
        const serialised = JSON.stringify(tool)
        if (raw.security === undefined) {
          expect(serialised).not.toContain('"security"')
        } else {
          expect(tool.operation.security).toEqual(raw.security)
          expect(serialised.split('"security"').length - 1).toBe(1)
        }
      }
      expect(model.security).toEqual(document.security)
    })

    it(`${name}: hooks see the operation's own security and its scopes, as before`, () => {
      const mcp = createJsonApiMcp({ model: JSON.parse(JSON.stringify(model)) })
      for (const op of mcp.operations) {
        const raw = Object.values(document.paths ?? {})
          .flatMap((item) => Object.values(item) as OperationObject[])
          .find((o) => o?.operationId === op.operationId)!
        expect(op.operation['security']).toEqual(raw.security)
        expect(op.security).toEqual(raw.security ?? document.security ?? [])
      }
      const scoped = mcp.operations.filter((op) => op.scopes !== undefined)
      expect(scoped.length).toBeGreaterThan(0)
      for (const op of scoped) {
        const scopes = Object.values(op.security[0] ?? {}).flat()
        expect(op.scopes).toEqual(scopes)
      }
    })
  }
})

/** A format 2 model as the previous generator wrote it, without a depth cap. */
function formatTwo() {
  const { model } = fixture('music-catalog', { includeDepth: null })
  const current = createJsonApiMcp({ model })
  const { includeDepth: _depth, security: _security, ...rest } = model
  return {
    current,
    model: {
      ...rest,
      format: 2,
      tools: model.tools.map((tool, i) => {
        const op = current.operations[i]!
        const { operation: _operation, ...operation } = tool.operation
        const { includePaths: _paths, ...query } = tool.plan.query ?? {}
        return {
          ...tool,
          plan: tool.plan.query === undefined ? tool.plan : { ...tool.plan, query },
          operation: {
            ...operation,
            operation: op.operation,
            security: op.security,
            ...(op.scopes === undefined ? {} : { scopes: op.scopes }),
          },
        }
      }),
    },
  }
}

describe('older formats', () => {
  it('reads a format 2 model and gives hooks the same operations', () => {
    const { current, model } = formatTwo()
    expect(createJsonApiMcp({ model }).operations).toEqual(current.operations)
  })

  it('sets no include cap for a format 2 model', async () => {
    const { model } = formatTwo()
    const requests: string[] = []
    const mcp = createJsonApiMcp({
      model,
      transport: async (req) => {
        requests.push(decodeURIComponent(req.url))
        return { status: 200, headers: {}, body: JSON.stringify({ data: null }) }
      },
    })
    const session = await mcp.forRequest({ context: undefined })
    const result = await session.callTool('albums_get', {
      id: '1',
      include: ['tracks.playlists.anything'],
      fields: null,
    })
    expect(result.isError).toBeUndefined()
    expect(requests[0]).toContain('include=tracks.playlists.anything')
  })
})
