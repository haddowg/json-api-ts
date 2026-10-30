import type { ApiDescriptor } from '@haddowg/json-api-client'
import { buildCatalogue } from './catalogue'
import { assertContract } from './contract'
import { MODEL_FORMAT, MODEL_GENERATOR, type McpModel, type McpModelOperation } from './model'
import { deref, isObject, type OpenApiDocument, type OperationObject } from './openapi'

/** Options for {@link buildMcpModel}. */
export interface BuildModelOptions {
  /** The page size a list tool asks for when the model gives none. Defaults to 10. */
  defaultPageSize?: number
  /**
   * How many relationships deep a tool's `include` may reach, 1 by default. Each tool lists and
   * accepts only the declared paths within it, and its output schema covers only the types those
   * reach. `null` keeps every path the document declares.
   */
  includeDepth?: number | null
  /** The source document's content hash, recorded in the model. */
  hash: string
}

// `security` is stored once, on the model operation, and put back by the runtime.
const OMITTED = new Set(['parameters', 'requestBody', 'responses', 'callbacks', 'security'])

function lightOperation(operation: OperationObject): OperationObject {
  const out: OperationObject = {}
  for (const [key, value] of Object.entries(operation)) {
    if (!OMITTED.has(key)) {
      out[key] = value
    }
  }
  return out
}

/** The names of the document's `oauth2` security schemes, the ones an MCP caller presents. */
function oauthSchemes(document: OpenApiDocument): string[] {
  const schemes = document.components?.['securitySchemes']
  if (!isObject(schemes)) {
    return []
  }
  return Object.keys(schemes).filter((name) => {
    const scheme = deref<unknown>(document, schemes[name])
    return isObject(scheme) && scheme['type'] === 'oauth2'
  })
}

/**
 * Build the model from a document and its descriptor. Throws when the document's generator
 * contract is out of range or a tool name breaks the rules. Needs no codegen: pass the
 * descriptor a generated client exports, or use `generateMcpModel` to build it too.
 */
export function buildMcpModel(
  document: OpenApiDocument,
  descriptor: ApiDescriptor,
  options: BuildModelOptions,
): McpModel {
  const contract = assertContract(document)
  const includeDepth = options.includeDepth === undefined ? 1 : options.includeDepth
  if (includeDepth !== null && !(Number.isInteger(includeDepth) && includeDepth >= 0)) {
    throw new Error(
      `includeDepth must be a whole number of 0 or more, or null; got ${includeDepth}`,
    )
  }
  const catalogue = buildCatalogue(
    document,
    descriptor,
    options.defaultPageSize ?? 10,
    includeDepth,
  )
  const info = document.info as { title?: unknown; version?: unknown } | undefined
  const model: McpModel = {
    format: MODEL_FORMAT,
    generator: MODEL_GENERATOR,
    contract,
    source: {
      title: `${String(info?.title ?? 'unknown')} ${String(info?.version ?? 'unknown')}`,
      hash: options.hash,
    },
    credentialSchemes: oauthSchemes(document),
    includeDepth,
    resourceLinks: catalogue.resourceLinks,
    descriptor,
    tools: catalogue.entries.map((entry) => {
      const { op } = entry
      const operation: McpModelOperation = {
        operationId: op.operationId,
        toolName: op.toolName,
        kind: op.kind,
        type: op.type,
        method: op.method,
        path: op.path,
        operation: lightOperation(op.operation),
      }
      if (op.operation.security !== undefined) operation.security = op.operation.security
      if (op.relation !== undefined) operation.relation = op.relation
      if (op.action !== undefined) operation.action = op.action
      if (entry.actionKey !== undefined) operation.actionKey = entry.actionKey
      const { schema: _schema, ...plan } = entry.input
      return { operation, tool: entry.tool, plan, result: entry.result }
    }),
    skipped: catalogue.skipped,
  }
  if (document.security !== undefined) {
    model.security = document.security
  }
  const server = document.servers?.[0]?.url
  if (server !== undefined) {
    model.baseUrl = server
  }
  return model
}
