import type { ActionDescriptor, ApiDescriptor, PaginatorDescriptor } from '@haddowg/json-api-client'
import {
  actionInput,
  collectionInput,
  createInput,
  deleteInput,
  type InputContext,
  singleInput,
  updateInput,
  type ToolInput,
} from './inputs'
import { checkToolNames, parseOperationId, type ParsedOperationId, toolName } from './names'
import {
  HTTP_METHODS,
  type JsonSchema,
  type OpenApiDocument,
  operationParameters,
  type OperationObject,
} from './openapi'
import {
  collectionOutput,
  deletedOutput,
  LOOSE_OUTPUT,
  locationOutput,
  metaOutput,
  orLocation,
  type OutputContext,
  capIncludePaths,
  includePaths,
  resourceLinkNames,
  resourceOutput,
  resourceSchemas,
} from './outputs'
import { type ActionSafety, readActionSafety } from './safety'
import { descriptorScopes } from './scopes'
import type { McpOperation, McpTool, McpToolAnnotations, SkippedOperation } from './types'

/** How the handler shapes a call's result. */
export type ResultShape =
  | 'collection'
  | 'resource'
  | 'item'
  | 'deleted'
  | 'meta'
  | 'location'
  | 'none'
  | 'raw'
  | 'loose'

/** One tool and everything its handler needs. */
export interface CatalogueEntry {
  op: McpOperation
  tool: McpTool
  input: ToolInput
  result: ResultShape
  /**
   * An action's key in the type's descriptor `actions`: its name for the preferred method, the
   * name plus the method for the others.
   */
  actionKey?: string
}

export interface Catalogue {
  entries: CatalogueEntry[]
  skipped: SkippedOperation[]
  /** The names of the links each type names, for the types that name any. */
  resourceLinks: Record<string, string[]>
}

function annotations(op: McpOperation): McpToolAnnotations | undefined {
  switch (op.kind) {
    case 'list':
    case 'get':
    case 'related':
      return { readOnlyHint: true }
    case 'create':
    case 'update':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    case 'delete':
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    case 'action': {
      const safety = actionSafety(op)
      const out: McpToolAnnotations = {}
      if (safety.readOnly !== undefined) out.readOnlyHint = safety.readOnly
      if (safety.destructive !== undefined) out.destructiveHint = safety.destructive
      if (safety.idempotent !== undefined) out.idempotentHint = safety.idempotent
      return Object.keys(out).length > 0 ? out : undefined
    }
  }
}

/**
 * An action's declared safety: the flags its descriptor entry carries, with the operation's own
 * `x-safety` winning where both say. A codegen descriptor mirrors `x-safety`, so they agree.
 */
function actionSafety(op: McpOperation): ActionSafety {
  const safety: ActionSafety = {}
  const declared = op.actionDescriptor
  for (const key of ['readOnly', 'destructive', 'idempotent'] as const) {
    const value = declared?.[key]
    if (typeof value === 'boolean') {
      safety[key] = value
    }
  }
  return { ...safety, ...readActionSafety(op.operation) }
}

/** The descriptor entry an action operation calls: the one at its path and method. */
function findAction(op: McpOperation): [string, ActionDescriptor] | undefined {
  const entries = Object.entries(op.resource.actions ?? {})
  return entries.find(
    ([, action]) => action.path === op.path && (action.method ?? 'POST') === op.method,
  )
}

function actionResult(action: ActionDescriptor): ResultShape {
  if (action.output === 'location') {
    return 'location'
  }
  if (action.output === 'none') {
    return action.rawOutput !== undefined && action.rawOutput.length > 0 ? 'raw' : 'none'
  }
  if (action.output === 'meta') {
    return 'meta'
  }
  if (action.outputType === undefined) {
    return 'loose'
  }
  return action.outputCardinality === 'many' ? 'collection' : 'resource'
}

/**
 * An action's output schema. One that may answer with a URL instead of its usual result takes
 * either; one that only answers with a URL takes the URL.
 */
function actionOutput(ctx: OutputContext, action: ActionDescriptor): JsonSchema | undefined {
  const usual = documentOutput(ctx, action)
  if (action.location === undefined) {
    return usual
  }
  return usual === undefined
    ? locationOutput(action.location.mediaType)
    : orLocation(usual, action.location.mediaType)
}

function documentOutput(ctx: OutputContext, action: ActionDescriptor): JsonSchema | undefined {
  switch (actionResult(action)) {
    case 'collection':
      return collectionOutput(ctx, [action.outputType!])
    case 'resource':
      return resourceOutput(ctx, [action.outputType!], 'The resource the action returned.')
    case 'meta':
      return metaOutput(ctx)
    case 'loose':
      return LOOSE_OUTPUT
    default:
      return undefined
  }
}

/** Build every tool the document and descriptor describe. Throws on a naming problem. */
export function buildCatalogue(
  doc: OpenApiDocument,
  descriptor: ApiDescriptor,
  defaultPageSize: number,
  includeDepth: number | null = null,
): Catalogue {
  const entries: CatalogueEntry[] = []
  const skipped: SkippedOperation[] = []
  const schemas = resourceSchemas(doc)
  const resourceLinks = resourceLinkNames(doc, descriptor, schemas)

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item[method]
      const operationId = operation?.operationId
      if (operation === undefined || typeof operationId !== 'string') {
        continue
      }
      const parsed = parseOperationId(operationId)
      if (parsed === undefined) {
        continue
      }
      const resource = descriptor[parsed.type]
      if (resource === undefined) {
        skipped.push({ operationId, reason: `the descriptor has no type "${parsed.type}"` })
        continue
      }
      const op: McpOperation = {
        operationId,
        toolName: toolName(parsed, descriptor),
        kind: parsed.kind,
        type: parsed.type,
        method: method.toUpperCase(),
        path,
        resource,
        operation,
        security: operation.security ?? doc.security ?? [],
      }
      const inputCtx: InputContext = {
        doc,
        descriptor,
        params: operationParameters(doc, item, operation),
        operation,
        defaultPageSize,
        includeDepth,
      }
      const outputCtx: OutputContext = {
        doc,
        descriptor,
        schemas,
        operation,
        includes: capIncludePaths(includePaths(doc, operation), includeDepth),
      }
      const built = buildEntry(op, parsed, inputCtx, outputCtx, descriptor)
      if (typeof built === 'string') {
        skipped.push({ operationId, reason: built })
        continue
      }
      entries.push(built)
    }
  }

  checkToolNames(entries.map((e) => ({ name: e.tool.name, operationId: e.op.operationId })))
  // oxlint-disable-next-line no-array-sort -- sorting the freshly built array
  entries.sort((a, b) => a.tool.name.localeCompare(b.tool.name))
  return { entries, skipped, resourceLinks }
}

function buildEntry(
  op: McpOperation,
  parsed: ParsedOperationId,
  inputCtx: InputContext,
  outputCtx: OutputContext,
  descriptor: ApiDescriptor,
): CatalogueEntry | string {
  let input: ToolInput | undefined
  let output: JsonSchema | undefined
  let result: ResultShape
  let key: string | undefined

  switch (parsed.kind) {
    case 'list':
      input = collectionInput(inputCtx, op.resource.paginator, undefined, op.resource.countable)
      output = collectionOutput(outputCtx, [op.type])
      result = 'collection'
      break
    case 'get':
      input = singleInput(inputCtx, `The id of the \`${op.type}\` resource to get.`)
      output = resourceOutput(outputCtx, [op.type])
      result = 'item'
      break
    case 'create':
      input = createInput(inputCtx, op.type)
      output = resourceOutput(outputCtx, [op.type])
      result = 'resource'
      break
    case 'update':
      input = updateInput(inputCtx, op.type)
      output = resourceOutput(outputCtx, [op.type])
      result = 'resource'
      break
    case 'delete':
      input = deleteInput(op.type)
      output = deletedOutput(outputCtx)
      result = 'deleted'
      break
    case 'related': {
      const relation = op.resource.relations[parsed.relation!]
      if (relation === undefined) {
        return `the descriptor has no relation "${parsed.relation}" on "${op.type}"`
      }
      op.relation = parsed.relation!
      op.relationDescriptor = relation
      if (relation.cardinality === 'many') {
        const paginator: PaginatorDescriptor | undefined =
          relation.paginator ?? descriptor[relation.types[0] ?? '']?.paginator
        input = collectionInput(
          inputCtx,
          paginator,
          { type: op.type, relation: parsed.relation! },
          relation.countable,
        )
        output = collectionOutput(outputCtx, relation.types)
        result = 'collection'
      } else {
        input = singleInput(
          inputCtx,
          `The id of the \`${op.type}\` resource whose ${parsed.relation} to get.`,
        )
        output = resourceOutput(
          outputCtx,
          relation.types,
          'The related resource, or null when there is none.',
        )
        result = 'item'
      }
      break
    }
    case 'action': {
      const found = findAction(op)
      if (found === undefined) {
        return `the descriptor has no ${op.method} action at "${op.path}" on "${op.type}"`
      }
      const [actionKey, action] = found
      op.action = parsed.action!
      op.actionDescriptor = action
      key = actionKey
      input = actionInput(inputCtx, op.type, parsed.action!, action)
      if (input === undefined) {
        return 'every request media type it accepts is one a model cannot send, such as a binary upload'
      }
      output = actionOutput(outputCtx, action)
      result = actionResult(action)
      break
    }
  }

  const scopes = descriptorScopes(op)
  if (scopes !== undefined) {
    op.scopes = scopes
  }

  const tool: McpTool = { name: op.toolName, inputSchema: input.schema }
  const operation: OperationObject = op.operation
  if (typeof operation.summary === 'string') {
    tool.title = operation.summary
  }
  const description = operation.description ?? operation.summary
  if (typeof description === 'string') {
    tool.description = description
  }
  if (output !== undefined) {
    tool.outputSchema = output as McpTool['outputSchema'] & object
  }
  const hints = annotations(op)
  if (hints !== undefined) {
    tool.annotations = hints
  }
  // oxlint-disable-next-line no-underscore-dangle -- MCP names the field `_meta`
  tool._meta = { operationId: op.operationId }
  return key === undefined
    ? { op, tool, input, result }
    : { op, tool, input, result, actionKey: key }
}
