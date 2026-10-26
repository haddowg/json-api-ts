import type {
  ActionDescriptor,
  ApiDescriptor,
  HeadersInit,
  JsonApiTransport,
  RelationDescriptor,
  ResourceDescriptor,
} from '@haddowg/json-api-client'
import type { JsonSchema, OpenApiDocument, OperationObject, SecurityRequirement } from './openapi'

// The MCP shapes below are written structurally, as type aliases rather than interfaces, so they
// assign to @modelcontextprotocol/sdk's own `Tool` and `CallToolResult` types without this
// package depending on the SDK.

/** MCP tool annotations: hints a client may show or act on. */
export type McpToolAnnotations = {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/** An MCP tool definition, as a `tools/list` response carries it. */
export type McpTool = {
  name: string
  title?: string
  description?: string
  inputSchema: { type: 'object'; [key: string]: unknown }
  outputSchema?: { type: 'object'; [key: string]: unknown }
  annotations?: McpToolAnnotations
  _meta?: { [key: string]: unknown }
}

/** A content block in a tool result. */
export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; blob: string } }

/** The result of an MCP `tools/call`. */
export type McpCallToolResult = {
  content: McpContent[]
  structuredContent?: { [key: string]: unknown }
  isError?: boolean
}

/** What a tool does, from its operation's kind. */
export type McpOperationKind =
  | 'list'
  | 'get'
  | 'create'
  | 'update'
  | 'delete'
  | 'related'
  | 'action'

/**
 * One operation the package turned into a tool. Every hook receives it: the descriptor entries,
 * the raw OpenAPI operation with its vendor extensions, and the security it carries.
 */
export interface McpOperation {
  operationId: string
  toolName: string
  kind: McpOperationKind
  /** The JSON:API type, exactly as in the document. */
  type: string
  /** The relation, for a related read. */
  relation?: string
  /** The action's path segment, for a custom action. */
  action?: string
  /** The HTTP method, upper-case. */
  method: string
  /** The path template, such as `/albums/{id}`. */
  path: string
  /** The type's descriptor entry. */
  resource: ResourceDescriptor
  /** The relation's descriptor entry, for a related read. */
  relationDescriptor?: RelationDescriptor
  /** The action's descriptor entry, for a custom action. */
  actionDescriptor?: ActionDescriptor
  /** The operation object as the document writes it, extensions included. */
  operation: OperationObject
  /** The operation's own `security`, else the document's. Empty means none is required. */
  security: readonly SecurityRequirement[]
}

/** What the host's capabilities resource says about one operation for this caller. */
export type McpCapability = 'allowed' | 'denied' | 'depends'

/** Request settings a host supplies per call. */
export interface McpRequestInit {
  /** The API's base URL for this call, overriding {@link JsonApiMcpOptions.baseUrl}. */
  baseUrl?: string
  /** Headers for this call, such as `Authorization`. */
  headers?: HeadersInit
}

/** One error object of a failed call, in the shape the tool result carries. */
export interface McpToolErrorObject {
  status?: string
  code?: string
  title?: string
  detail?: string
  source?: { pointer?: string; parameter?: string; header?: string }
  /** The tool argument the error is about, such as `title` or `releaseInfo.label`. */
  path?: string
}

/** A failed call, before it becomes an `isError` tool result. */
export interface McpToolError {
  /** The HTTP status of an error response; absent when no response came back. */
  status?: number
  message: string
  errors: McpToolErrorObject[]
  /** What was thrown: a `JsonApiError`, a transport failure, or the package's own refusal. */
  cause: unknown
}

/** The optional hooks a host plugs into. Each gets the per-request context it supplied. */
export interface JsonApiMcpHooks<Ctx> {
  /** Called per operation when the tool list is built, after scopes and capabilities. */
  includeOperation?: (op: McpOperation, ctx: Ctx) => boolean | Promise<boolean>
  /** Called per tool after the package built it. Return the tool to list. */
  decorateTool?: (tool: McpTool, op: McpOperation, ctx: Ctx) => McpTool | Promise<McpTool>
  /** Called per call before the request: headers and the base URL. */
  requestInit?: (op: McpOperation, ctx: Ctx) => McpRequestInit | Promise<McpRequestInit>
  /** Called per failed call. Return the error the tool result carries. */
  mapError?: (
    error: McpToolError,
    op: McpOperation,
    ctx: Ctx,
  ) => McpToolError | Promise<McpToolError>
  /**
   * Whether the caller's granted scopes satisfy the scopes one security requirement lists.
   * Defaults to every required scope appearing in `granted`.
   */
  scopeMatcher?: (granted: readonly string[], required: readonly string[]) => boolean
  /**
   * The caller's capabilities, keyed by `operationId`, called once per tool list. A `denied`
   * operation is left out; `depends` and an operation the result doesn't name stay in.
   */
  capabilities?: (
    ctx: Ctx,
  ) =>
    | Readonly<Record<string, McpCapability>>
    | ReadonlyMap<string, McpCapability>
    | Promise<Readonly<Record<string, McpCapability>> | ReadonlyMap<string, McpCapability>>
}

/** Options for {@link createJsonApiMcp}. */
export interface JsonApiMcpOptions<Ctx> {
  /** The server's OpenAPI document, already parsed. */
  document: OpenApiDocument
  /**
   * The json-api-ts descriptor for the same document: a generated client's `resourceMap`, or
   * `buildDescriptor(document)` from `@haddowg/json-api-codegen` at runtime.
   */
  descriptor: ApiDescriptor
  /** The API's base URL. Defaults to the document's first server. */
  baseUrl?: string
  /** The transport the client sends through. Defaults to `fetch`. */
  transport?: JsonApiTransport
  /** The page size a list tool asks for when the model gives none. Defaults to 10. */
  defaultPageSize?: number
  hooks?: JsonApiMcpHooks<Ctx>
}

/** Per-request input to {@link JsonApiMcp.forRequest}. */
export interface McpRequest<Ctx> {
  /** The caller's granted scopes. Omit to skip scope filtering. */
  grantedScopes?: readonly string[]
  /** The host's own per-request context, handed to every hook. */
  context: Ctx
}

/** Options for one call. */
export interface McpCallOptions {
  signal?: AbortSignal
}

/** The tools one caller may use, and the handler for their calls. */
export interface McpToolSession {
  readonly tools: readonly McpTool[]
  /** Run a tool from {@link tools}. Any other name is a tool error. */
  callTool(name: string, args: unknown, options?: McpCallOptions): Promise<McpCallToolResult>
}

/** An operation the package left out of the catalogue, and why. */
export interface SkippedOperation {
  operationId: string
  reason: string
}

/** The tool catalogue built from one document and descriptor. */
export interface JsonApiMcp<Ctx> {
  /** Every operation that became a tool, before any per-caller filtering. */
  readonly operations: readonly McpOperation[]
  /** Every tool, before any per-caller filtering or decoration. */
  readonly tools: readonly McpTool[]
  /** Operations that couldn't become a tool, such as an action whose body only takes binary. */
  readonly skipped: readonly SkippedOperation[]
  /** Filter and decorate the tools for one caller. */
  forRequest(request: McpRequest<Ctx>): Promise<McpToolSession>
}

export type { JsonSchema }
