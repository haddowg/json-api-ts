import type { ApiDescriptor } from '@haddowg/json-api-client'
import { HTTP_METHODS, type HttpMethod } from './openapi'
import type { McpOperationKind } from './types'

/** The name pattern OpenAI's and Anthropic's tool names share. */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

/** What an `operationId` names, for an operation that becomes a tool. */
export interface ParsedOperationId {
  kind: McpOperationKind
  type: string
  relation?: string
  action?: string
  /** The method suffix of a multi-method action's id. */
  method?: HttpMethod
}

const CRUD: Readonly<Record<string, McpOperationKind>> = {
  fetchCollection: 'list',
  fetchOne: 'get',
  create: 'create',
  update: 'update',
  delete: 'delete',
}

/**
 * Parse an `operationId` into what a tool needs. `undefined` for an operation that isn't a tool:
 * relationship endpoints, Atomic Operations, or an id this package doesn't recognise.
 */
export function parseOperationId(operationId: string): ParsedOperationId | undefined {
  const parts = operationId.split('.')
  const [verb, type] = parts
  if (verb === undefined || type === undefined || type === '') {
    return undefined
  }
  const crud = CRUD[verb]
  if (crud !== undefined) {
    return parts.length === 2 ? { kind: crud, type } : undefined
  }
  if (verb === 'fetchRelated' && parts.length === 3 && parts[2] !== '') {
    return { kind: 'related', type, relation: parts[2]! }
  }
  if (verb === 'action' && parts[2] !== undefined && parts[2] !== '') {
    if (parts.length === 3) {
      return { kind: 'action', type, action: parts[2] }
    }
    const method = parts[3] as HttpMethod
    if (parts.length === 4 && HTTP_METHODS.includes(method)) {
      return { kind: 'action', type, action: parts[2], method }
    }
  }
  return undefined
}

const snake = (value: string): string => value.replace(/-/g, '_')

/**
 * The tool name for a parsed `operationId`: noun first, the type as the document spells it with
 * kebab-case turned into snake_case. A related read ends in `list` or `get` by the relation's
 * cardinality; an action is named after its path, plus the method for a multi-method action.
 */
export function toolName(parsed: ParsedOperationId, descriptor: ApiDescriptor): string {
  const type = snake(parsed.type)
  switch (parsed.kind) {
    case 'related': {
      const relation = descriptor[parsed.type]?.relations[parsed.relation!]
      const verb = relation?.cardinality === 'one' ? 'get' : 'list'
      return `${type}_${snake(parsed.relation!)}_${verb}`
    }
    case 'action':
      return parsed.method === undefined
        ? `${type}_${snake(parsed.action!)}`
        : `${type}_${snake(parsed.action!)}_${parsed.method}`
    default:
      return `${type}_${parsed.kind}`
  }
}

/** Thrown when the tools can't be named: a name too long, with a stray character, or a clash. */
export class ToolNameError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`Cannot build MCP tools from this document:\n- ${problems.join('\n- ')}`)
    this.name = 'ToolNameError'
    this.problems = problems
  }
}

/** Collect every naming problem across the tools, so one build reports them all. */
export function checkToolNames(tools: readonly { name: string; operationId: string }[]): void {
  const problems: string[] = []
  const byName = new Map<string, string[]>()
  for (const { name, operationId } of tools) {
    if (name.length > 64) {
      problems.push(`"${name}" (${operationId}) is ${name.length} characters; tool names allow 64`)
    } else if (!TOOL_NAME_PATTERN.test(name)) {
      problems.push(`"${name}" (${operationId}) has characters outside [a-zA-Z0-9_-]`)
    }
    byName.set(name, [...(byName.get(name) ?? []), operationId])
  }
  for (const [name, ids] of byName) {
    if (ids.length > 1) {
      problems.push(`"${name}" is the tool name of ${ids.join(' and ')}`)
    }
  }
  if (problems.length > 0) {
    throw new ToolNameError(problems)
  }
}
