import { buildCatalogue, type CatalogueEntry } from './catalogue'
import { errorResult, runCall, toToolError } from './call'
import { assertContract } from './contract'
import type { SecurityRequirement } from './openapi'
import type {
  JsonApiMcp,
  JsonApiMcpOptions,
  McpCallToolResult,
  McpCapability,
  McpRequest,
  McpTool,
  McpToolSession,
} from './types'

const DEFAULT_PAGE_SIZE = 10

/** Every required scope appears among the granted ones. */
export const exactScopeMatcher = (
  granted: readonly string[],
  required: readonly string[],
): boolean => required.every((scope) => granted.includes(scope))

/**
 * Whether granted scopes satisfy an operation's security: any one requirement whose scopes, across
 * its schemes, all match. No requirement, or one listing no scopes, needs none.
 */
export function satisfiesSecurity(
  security: readonly SecurityRequirement[],
  granted: readonly string[],
  matcher: (granted: readonly string[], required: readonly string[]) => boolean = exactScopeMatcher,
): boolean {
  if (security.length === 0) {
    return true
  }
  return security.some((requirement) => {
    const scopes = Object.values(requirement).flat()
    return scopes.length === 0 || matcher(granted, scopes)
  })
}

/**
 * Build MCP tools from a JSON:API server's OpenAPI document and its json-api-ts descriptor: one
 * tool per collection, resource, related and custom action operation. Throws when the document's
 * generator contract is outside the range this package reads, or when two tools would share a
 * name or a name breaks the model APIs' rules.
 */
export function createJsonApiMcp<Ctx = unknown>(options: JsonApiMcpOptions<Ctx>): JsonApiMcp<Ctx> {
  const { document, descriptor, hooks = {} } = options
  assertContract(document)
  const catalogue = buildCatalogue(
    document,
    descriptor,
    options.defaultPageSize ?? DEFAULT_PAGE_SIZE,
  )
  const defaultBaseUrl = options.baseUrl ?? document.servers?.[0]?.url

  async function forRequest(request: McpRequest<Ctx>): Promise<McpToolSession> {
    const ctx = request.context
    let entries: CatalogueEntry[] = catalogue.entries
    if (request.grantedScopes !== undefined) {
      const granted = request.grantedScopes
      entries = entries.filter((e) => satisfiesSecurity(e.op.security, granted, hooks.scopeMatcher))
    }
    if (hooks.capabilities !== undefined) {
      const capabilities = await hooks.capabilities(ctx)
      const lookup = (id: string): McpCapability | undefined =>
        capabilities instanceof Map
          ? (capabilities as ReadonlyMap<string, McpCapability>).get(id)
          : (capabilities as Readonly<Record<string, McpCapability>>)[id]
      entries = entries.filter((e) => lookup(e.op.operationId) !== 'denied')
    }
    if (hooks.includeOperation !== undefined) {
      const include = hooks.includeOperation
      const keep = await Promise.all(entries.map((e) => include(e.op, ctx)))
      entries = entries.filter((_, index) => keep[index] === true)
    }

    const byName = new Map<string, CatalogueEntry>()
    const tools: McpTool[] = []
    for (const entry of entries) {
      const tool =
        hooks.decorateTool === undefined
          ? entry.tool
          : await hooks.decorateTool(structuredClone(entry.tool), entry.op, ctx)
      tools.push(tool)
      byName.set(tool.name, entry)
    }

    async function callTool(
      name: string,
      args: unknown,
      callOptions: { signal?: AbortSignal } = {},
    ): Promise<McpCallToolResult> {
      const entry = byName.get(name)
      if (entry === undefined) {
        return errorResult({ message: `Unknown tool "${name}"`, errors: [], cause: undefined })
      }
      try {
        const init = hooks.requestInit === undefined ? {} : await hooks.requestInit(entry.op, ctx)
        return await runCall(entry, args, {
          descriptor,
          baseUrl: init.baseUrl ?? defaultBaseUrl,
          transport: options.transport,
          headers: init.headers,
          signal: callOptions.signal,
        })
      } catch (error) {
        const toolError = toToolError(error)
        return errorResult(
          hooks.mapError === undefined ? toolError : await hooks.mapError(toolError, entry.op, ctx),
        )
      }
    }

    return { tools, callTool }
  }

  return {
    operations: catalogue.entries.map((e) => e.op),
    tools: catalogue.entries.map((e) => e.tool),
    skipped: catalogue.skipped,
    forRequest,
  }
}
