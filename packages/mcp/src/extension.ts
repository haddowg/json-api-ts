import { isObject, type OperationObject } from './openapi'

/** The vendor extension an operation uses to leave out or reshape its tool. */
export const MCP_EXTENSION = 'x-mcp'

/** The parts of a tool an operation's `x-mcp` object replaces. */
export interface McpToolOverrides {
  name?: string
  title?: string
  description?: string
}

const OVERRIDES = ['name', 'title', 'description'] as const

/**
 * Read an operation's `x-mcp`: `false` leaves the tool out, `true` or no extension keeps it as
 * built, and an object keeps it with the members it sets. Throws on anything else, so a typo
 * fails the build rather than publishing a tool the author meant to hide or rename.
 */
export function readMcpExtension(
  operation: OperationObject,
  operationId: string,
): false | McpToolOverrides {
  const raw = operation[MCP_EXTENSION]
  if (raw === undefined || raw === true) {
    return {}
  }
  if (raw === false) {
    return false
  }
  if (!isObject(raw)) {
    throw new Error(
      `${operationId} declares ${MCP_EXTENSION} as ${JSON.stringify(raw)}; it takes true, false or an object of name, title and description strings.`,
    )
  }
  const overrides: McpToolOverrides = {}
  for (const key of OVERRIDES) {
    const value = raw[key]
    if (value === undefined) {
      continue
    }
    if (typeof value !== 'string') {
      throw new Error(
        `${operationId} declares ${MCP_EXTENSION}.${key} as ${JSON.stringify(value)}; it takes a string.`,
      )
    }
    overrides[key] = value
  }
  return overrides
}
