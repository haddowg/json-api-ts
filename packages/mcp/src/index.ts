/**
 * @haddowg/json-api-mcp: MCP tool definitions and a call handler, built at runtime from a
 * haddowg/json-api server's OpenAPI document and its json-api-ts descriptor. The host owns the
 * MCP server; this package hands it the tools to list and a function to run them.
 */
export { MAXIMUM_CONTRACT, MINIMUM_CONTRACT, assertContract } from './contract'
export { createJsonApiMcp, exactScopeMatcher, satisfiesSecurity } from './mcp'
export { parseOperationId, TOOL_NAME_PATTERN, ToolNameError, toolName } from './names'
export type { ParsedOperationId } from './names'
export type { JsonSchema, OpenApiDocument, OperationObject, SecurityRequirement } from './openapi'
export { PORTABLE_FORMATS } from './portable'
export { readActionSafety, SAFETY_EXTENSION } from './safety'
export type { ActionSafety } from './safety'
export type * from './types'
