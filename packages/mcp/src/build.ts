import type { ApiDescriptor } from '@haddowg/json-api-client'
import { buildCatalogue } from './catalogue'
import { assertContract } from './contract'
import { MODEL_FORMAT, MODEL_GENERATOR, type McpModel, type McpModelOperation } from './model'
import type { OpenApiDocument, OperationObject } from './openapi'

/** Options for {@link buildMcpModel}. */
export interface BuildModelOptions {
  /** The page size a list tool asks for when the model gives none. Defaults to 10. */
  defaultPageSize?: number
  /** The source document's content hash, recorded in the model. */
  hash: string
}

const OMITTED = new Set(['parameters', 'requestBody', 'responses', 'callbacks'])

function lightOperation(operation: OperationObject): OperationObject {
  const out: OperationObject = {}
  for (const [key, value] of Object.entries(operation)) {
    if (!OMITTED.has(key)) {
      out[key] = value
    }
  }
  return out
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
  const catalogue = buildCatalogue(document, descriptor, options.defaultPageSize ?? 10)
  const info = document.info as { title?: unknown; version?: unknown } | undefined
  const model: McpModel = {
    format: MODEL_FORMAT,
    generator: MODEL_GENERATOR,
    contract,
    source: {
      title: `${String(info?.title ?? 'unknown')} ${String(info?.version ?? 'unknown')}`,
      hash: options.hash,
    },
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
        security: op.security,
      }
      if (op.relation !== undefined) operation.relation = op.relation
      if (op.action !== undefined) operation.action = op.action
      if (entry.actionKey !== undefined) operation.actionKey = entry.actionKey
      const { schema: _schema, ...plan } = entry.input
      return { operation, tool: entry.tool, plan, result: entry.result }
    }),
    skipped: catalogue.skipped,
  }
  const server = document.servers?.[0]?.url
  if (server !== undefined) {
    model.baseUrl = server
  }
  return model
}
