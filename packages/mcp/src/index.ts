/**
 * @haddowg/json-api-mcp: MCP tool definitions and a call handler for a haddowg/json-api server,
 * served from a model generated at build time (see `@haddowg/json-api-mcp/generate`). The host
 * owns the MCP server; this package hands it the tools to list and a function to run them. This
 * entry point loads only the client, from ESM or CommonJS.
 */
export { MAXIMUM_CONTRACT, MINIMUM_CONTRACT, assertContract } from './contract'
export { createJsonApiMcp, exactScopeMatcher, satisfiesSecurity } from './mcp'
export { assertModel, McpModelError, MODEL_FORMAT, MODEL_GENERATOR } from './model'
export type { McpModel, McpModelOperation, McpModelPlan, McpModelTool } from './model'
export { parseOperationId, TOOL_NAME_PATTERN, ToolNameError, toolName } from './names'
export type { ParsedOperationId } from './names'
export type { JsonSchema, OpenApiDocument, OperationObject, SecurityRequirement } from './openapi'
export { PORTABLE_FORMATS } from './portable'
export { readActionSafety, SAFETY_EXTENSION } from './safety'
export type { ActionSafety } from './safety'
export type * from './types'
