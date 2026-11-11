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
  /** On a `sort` array: the families of keys it accepts by prefix beside its fixed enum. */
  'x-sort-families'?: readonly { prefix?: unknown; suffixPattern?: unknown; deprecated?: unknown }[]
  /** On a `sort` array: the fixed keys the server marks deprecated, without the `-`. */
  'x-deprecated-sorts'?: readonly unknown[]
  /** On the `filter` object: the families of filter keys it accepts by prefix. */
  'x-filter-families'?: readonly {
    prefix?: unknown
    suffixPattern?: unknown
    list?: unknown
    delimited?: unknown
    deprecated?: unknown
  }[]
  [key: string]: unknown
}

/** A property entry: either a schema, or the literal `false` (a forbidden member). */
export type SchemaOrBool = SchemaObject | boolean

export interface MediaTypeObject {
  schema?: SchemaObject
  /** A whole worked body for this media type (generator contract 12 on an operation). */
  example?: unknown
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
  schema?: SchemaObject
  style?: string
  explode?: boolean
  deprecated?: boolean
  /**
   * The negotiation profile a client must opt into to use this parameter (e.g. `withCount` or
   * `relatedQuery`).
   */
  'x-profile'?: string
  /** On a `filter[<key>][]` parameter: the list filter it carries the array form of. */
  'x-filter-list'?: { key?: unknown; delimited?: unknown }
}

export interface OperationObject {
  operationId?: string
  summary?: string
  description?: string
  parameters?: readonly ParameterObject[]
  requestBody?: RequestBodyObject
  responses?: Record<string, ResponseObject>
  deprecated?: boolean
  /** What a custom action declares about its effects (generator contract 15). */
  'x-safety'?: { readOnly?: unknown; destructive?: unknown; idempotent?: unknown }
  /** The credentials the operation takes: scheme name to the scopes it needs, per alternative. */
  security?: readonly SecurityRequirement[]
}

/** One security alternative: each scheme it names, with the scopes it needs under that scheme. */
export type SecurityRequirement = Readonly<Record<string, readonly string[]>>

/** A security scheme; the codegen reads only its `type`, to find the `oauth2` ones. */
export interface SecuritySchemeObject {
  type?: string
}

export type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete'

export type PathItemObject = Partial<Record<HttpMethod, OperationObject>>

export interface InfoObject {
  title?: string
  version?: string
  /** The projector's generator contract, bumped whenever the emitted structure changes. */
  'x-generator'?: { contract?: number }
}

export interface OpenApiDocument {
  openapi?: string
  info?: InfoObject
  servers?: readonly { url?: string }[]
  paths?: Record<string, PathItemObject>
  /** The default security of every operation that declares none of its own. */
  security?: readonly SecurityRequirement[]
  components?: {
    schemas?: Record<string, SchemaObject>
    securitySchemes?: Record<string, SecuritySchemeObject>
    /** Shared response components; an error response is read inline or through one. */
    responses?: Record<string, unknown>
    /** Named Example Objects, such as each error code's example document. */
    examples?: Record<string, unknown>
    /** Shared parameters, such as `relatedQuery`, which operations reach through a `$ref`. */
    parameters?: Record<string, ParameterObject>
  }
}
