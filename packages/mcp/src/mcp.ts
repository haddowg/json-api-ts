import { errorResult, runCall, type ToolEntry, toToolError } from './call'
import {
  assertModel,
  inferCredentialSchemes,
  McpModelError,
  type McpModel,
  type McpModelTool,
} from './model'
import type { SecurityRequirement } from './openapi'
import type {
  JsonApiMcp,
  JsonApiMcpOptions,
  McpCallToolResult,
  McpCapability,
  McpOperation,
  McpRequest,
  McpTool,
  McpToolSession,
} from './types'

/** Every required scope appears among the granted ones. */
export const exactScopeMatcher = (
  granted: readonly string[],
  required: readonly string[],
): boolean => required.every((scope) => granted.includes(scope))

/**
 * Whether granted scopes satisfy an operation's security. No requirement, or an empty one, needs
 * nothing. Given `credentialSchemes`, the schemes the caller authenticates with, a requirement
 * counts only when it names nothing else, so an operation whose every requirement needs another
 * credential fails. A counted requirement passes when its scopes, across its schemes, all match,
 * or when it lists none. Without `credentialSchemes` every requirement counts.
 */
export function satisfiesSecurity(
  security: readonly SecurityRequirement[],
  granted: readonly string[],
  matcher: (granted: readonly string[], required: readonly string[]) => boolean = exactScopeMatcher,
  credentialSchemes?: readonly string[],
): boolean {
  if (security.length === 0) {
    return true
  }
  return security.some((requirement) => {
    const schemes = Object.keys(requirement)
    if (schemes.length === 0) {
      return true
    }
    if (
      credentialSchemes !== undefined &&
      !schemes.every((scheme) => credentialSchemes.includes(scheme))
    ) {
      return false
    }
    const scopes = Object.values(requirement).flat()
    return scopes.length === 0 || matcher(granted, scopes)
  })
}

/**
 * The schemes the scope filter counts: the host's, else the model's, else for a format 1 model
 * the schemes it lists scopes under. `undefined`, so every requirement counts, when that's empty.
 */
function resolveCredentialSchemes(
  model: McpModel,
  override: readonly string[] | undefined,
): readonly string[] | undefined {
  if (override !== undefined) {
    return override
  }
  const schemes = model.credentialSchemes ?? inferCredentialSchemes(model)
  return schemes.length > 0 ? schemes : undefined
}

/** Rebuild an operation for the hooks, adding back the descriptor entries it names. */
function hydrate(model: McpModel, tool: McpModelTool): ToolEntry {
  const source = tool.operation
  const resource = model.descriptor[source.type]
  if (resource === undefined) {
    throw new McpModelError(`The model's descriptor has no type "${source.type}"; regenerate it.`)
  }
  const op: McpOperation = {
    operationId: source.operationId,
    toolName: source.toolName,
    kind: source.kind,
    type: source.type,
    method: source.method,
    path: source.path,
    resource,
    operation: source.operation,
    security: source.security,
  }
  if (source.scopes !== undefined) op.scopes = source.scopes
  if (source.relation !== undefined) {
    op.relation = source.relation
    const relation = resource.relations[source.relation]
    if (relation !== undefined) op.relationDescriptor = relation
  }
  if (source.action !== undefined) {
    op.action = source.action
    const action = resource.actions?.[source.actionKey ?? source.action]
    if (action !== undefined) op.actionDescriptor = action
  }
  const entry: ToolEntry = { op, tool: tool.tool, input: tool.plan, result: tool.result }
  if (source.actionKey !== undefined) entry.actionKey = source.actionKey
  return entry
}

/**
 * Serve MCP tools from a model the generator wrote: `createJsonApiMcp({ model })` with the parsed
 * artefact. Throws when the artefact isn't one this runtime can read.
 */
export function createJsonApiMcp<Ctx = unknown>(options: JsonApiMcpOptions<Ctx>): JsonApiMcp<Ctx> {
  const { hooks = {} } = options
  const model = assertModel(options.model)
  const descriptor = model.descriptor
  const catalogue = { entries: model.tools.map((tool) => hydrate(model, tool)) }
  const defaultBaseUrl = options.baseUrl ?? model.baseUrl
  const credentialSchemes = resolveCredentialSchemes(model, options.credentialSchemes)

  async function forRequest(request: McpRequest<Ctx>): Promise<McpToolSession> {
    const ctx = request.context
    let entries: ToolEntry[] = catalogue.entries
    if (request.grantedScopes !== undefined) {
      const granted = request.grantedScopes
      entries = entries.filter((e) =>
        satisfiesSecurity(e.op.security, granted, hooks.scopeMatcher, credentialSchemes),
      )
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

    const byName = new Map<string, ToolEntry>()
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
    skipped: model.skipped,
    contract: model.contract,
    source: model.source,
    credentialSchemes,
    forRequest,
  }
}
