/**
 * A minimal structural model of the slice of OpenAPI 3.1 the codegen consumes
 * (`components.schemas` + `paths`). Deliberately not a full OpenAPI type — we only
 * model what the descriptor builder reads, and treat schemas as a loose recursive
 * shape since JSON Schema is open-ended.
 */

/** A JSON Schema node (or a `$ref` to one), loosely typed for the bits we walk. */
export interface SchemaObject {
  $ref?: string
  type?: string | readonly string[]
  const?: unknown
  format?: string
  description?: string
  enum?: readonly unknown[]
  properties?: Record<string, SchemaOrBool>
  items?: SchemaObject
  required?: readonly string[]
  allOf?: readonly SchemaObject[]
  anyOf?: readonly SchemaObject[]
  oneOf?: readonly SchemaObject[]
  'x-enum-varnames'?: readonly string[]
  'x-enum-descriptions'?: readonly string[]
  [key: string]: unknown
}

/** A property entry: either a schema, or the literal `false` (a forbidden member). */
export type SchemaOrBool = SchemaObject | boolean

export interface MediaTypeObject {
  schema?: SchemaObject
}

export interface RequestBodyObject {
  content?: Record<string, MediaTypeObject>
  required?: boolean
}

export interface ResponseObject {
  content?: Record<string, MediaTypeObject>
}

export interface ParameterObject {
  name?: string
  in?: string
  $ref?: string
}

export interface OperationObject {
  parameters?: readonly ParameterObject[]
  requestBody?: RequestBodyObject
  responses?: Record<string, ResponseObject>
}

export type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete'

export type PathItemObject = Partial<Record<HttpMethod, OperationObject>>

export interface OpenApiDocument {
  openapi?: string
  servers?: readonly { url?: string }[]
  paths?: Record<string, PathItemObject>
  components?: {
    schemas?: Record<string, SchemaObject>
  }
}
