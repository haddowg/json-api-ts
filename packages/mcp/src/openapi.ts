/**
 * The parts of an OpenAPI 3.1 document this package reads, typed loosely: every object keeps its
 * other members, vendor extensions included, so hooks see the operation as the server wrote it.
 */

/** A JSON Schema node as the document writes it. */
export type JsonSchema = { [key: string]: unknown }

/** One security requirement: scheme name to the scopes it needs. */
export type SecurityRequirement = Readonly<Record<string, readonly string[]>>

export interface ParameterObject {
  name: string
  in: string
  description?: string
  required?: boolean
  schema?: JsonSchema
  [key: string]: unknown
}

export interface MediaTypeObject {
  schema?: JsonSchema
  [key: string]: unknown
}

export interface RequestBodyObject {
  description?: string
  required?: boolean
  content?: Record<string, MediaTypeObject>
  [key: string]: unknown
}

export interface ResponseObject {
  description?: string
  content?: Record<string, MediaTypeObject>
  [key: string]: unknown
}

export interface OperationObject {
  operationId?: string
  summary?: string
  description?: string
  parameters?: (ParameterObject | { $ref: string })[]
  requestBody?: RequestBodyObject | { $ref: string }
  responses?: Record<string, ResponseObject | { $ref: string }>
  security?: SecurityRequirement[]
  [key: string]: unknown
}

export type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete'

export const HTTP_METHODS: readonly HttpMethod[] = ['get', 'post', 'patch', 'put', 'delete']

export type PathItemObject = Partial<Record<HttpMethod, OperationObject>> & {
  parameters?: (ParameterObject | { $ref: string })[]
  [key: string]: unknown
}

export interface OpenApiDocument {
  openapi?: string
  info?: { 'x-generator'?: { contract?: unknown; [key: string]: unknown }; [key: string]: unknown }
  servers?: { url: string; [key: string]: unknown }[]
  paths?: Record<string, PathItemObject>
  components?: {
    schemas?: Record<string, JsonSchema>
    parameters?: Record<string, ParameterObject>
    requestBodies?: Record<string, RequestBodyObject>
    responses?: Record<string, ResponseObject>
    [key: string]: unknown
  }
  security?: SecurityRequirement[]
  [key: string]: unknown
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Follow a local `#/...` reference. `undefined` for anything else or a dangling one. */
export function resolvePointer(doc: OpenApiDocument, ref: string): unknown {
  if (!ref.startsWith('#/')) {
    return undefined
  }
  let node: unknown = doc
  for (const raw of ref.slice(2).split('/')) {
    const segment = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isObject(node) || !Object.hasOwn(node, segment)) {
      return undefined
    }
    node = node[segment]
  }
  return node
}

/** Follow `$ref`s until a node that isn't one. A cycle or dangling ref gives `undefined`. */
export function deref<T>(
  doc: OpenApiDocument,
  value: T | { $ref: string } | undefined,
): T | undefined {
  let node: unknown = value
  const seen = new Set<string>()
  while (isObject(node) && typeof node['$ref'] === 'string') {
    const ref = node['$ref']
    if (seen.has(ref)) {
      return undefined
    }
    seen.add(ref)
    node = resolvePointer(doc, ref)
  }
  return node as T | undefined
}

/** An operation's parameters, path-level ones included, with refs followed. */
export function operationParameters(
  doc: OpenApiDocument,
  item: PathItemObject,
  op: OperationObject,
): ParameterObject[] {
  const out = new Map<string, ParameterObject>()
  for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
    const param = deref<ParameterObject>(doc, raw)
    if (param !== undefined && typeof param.name === 'string') {
      out.set(`${param.in}:${param.name}`, param)
    }
  }
  return [...out.values()]
}
