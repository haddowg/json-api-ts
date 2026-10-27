/**
 * Each tool's input schema, and the plan the call handler follows to turn a model's arguments
 * back into a client call. Every schema is portable (see ./portable.ts): a parameter the API
 * doesn't require is nullable, and `null` at the top level means "not given".
 */
import {
  type ActionDescriptor,
  type ApiDescriptor,
  type CountableDescriptor,
  isPolymorphic,
  type PaginatorDescriptor,
  type RelationDescriptor,
  resolvePaginator,
} from '@haddowg/json-api-client'
import {
  deref,
  isObject,
  type JsonSchema,
  type OpenApiDocument,
  type OperationObject,
  type ParameterObject,
  type RequestBodyObject,
} from './openapi'
import { capIncludePaths, includePaths } from './outputs'
import {
  allowsNull,
  closedObject,
  type Decoder,
  nullable,
  type PropertyDecoder,
  toPortable,
} from './portable'

/** The include description, for a tool capped at `depth` relationships or uncapped. */
export function includeDescription(depth: number | null): string {
  const reach =
    depth === null
      ? ''
      : depth === 1
        ? ' Only direct relationships can be included, so relations of an included resource come back as ids.'
        : ` Paths reach at most ${depth} relationships deep, and relations below that come back as ids.`
  return `Relationship paths to include in the result (JSON:API compound documents). An included relation comes back as the related resource in place of its id.${reach} Leave null to include nothing.`
}

export const FIELDS_DESCRIPTION =
  'Sparse fieldsets (JSON:API): per resource type, the attribute and relationship names to return. A relationship only has a value in the result when it is also included. Leave a type null for its default fields.'

/** The Countable profile's token for counting the collection itself. */
export const SELF_COUNT = '_self_'

export const WITH_COUNT_DESCRIPTION =
  'Set true to have the total number of results counted and returned in meta. Counting can be slow on a large collection, so leave it null unless the total is needed.'

export const PAGE_LINK_DESCRIPTION =
  'A pagination link (first, prev, next or last) copied from the links of an earlier result of this same tool, to fetch that page. When given, every other argument is ignored.'

/** How the handler reads a read tool's query arguments. */
export interface QueryPlan {
  filter?: Decoder
  sort: boolean
  include: boolean
  /**
   * The include paths the tool accepts, the ones its input lists. A model before format 3
   * doesn't carry them and its tools accept any path.
   */
  includePaths?: readonly string[]
  fields: readonly string[]
  /** The wire key `pageSize` maps to, when the endpoint paginates by a size. */
  sizeKey?: string
  maxPageSize?: number
  defaultPageSize?: number
  /** Whether `pageLink` is offered: the endpoint paginates at all. */
  paginated: boolean
  /**
   * Whether `withCount` is offered: the endpoint counts its own collection under the Countable
   * profile, sent as `withCount=_self_` with this profile negotiated.
   */
  countProfile?: string
}

/** One top-level write field: an attribute, or a relation sent as ids. */
export interface WriteField {
  relation?: { cardinality: 'one' | 'many'; types: readonly string[]; polymorphic?: boolean }
  property: PropertyDecoder
}

/** How the handler reads a create, update or flat document action's arguments. */
export interface WritePlan {
  fields: Readonly<Record<string, WriteField>>
  /** The client id argument: whether the body takes one. */
  clientId: 'none' | 'optional' | 'required'
  /** Fields `clear` may name, for an update. */
  clearable: readonly string[]
}

/** How the handler reads a custom action's body. */
export type ActionBodyPlan =
  | { kind: 'none' }
  | { kind: 'flat'; write: WritePlan }
  | {
      kind: 'body'
      decoder: Decoder
      required: boolean
      /** The request media type the body goes out as. */
      mediaType: string
      mediaKind: 'document' | 'json' | 'text' | 'form'
    }

export interface ToolInput {
  schema: JsonSchema & { type: 'object' }
  query?: QueryPlan
  write?: WritePlan
  action?: ActionBodyPlan
}

const nullableString = (description: string): JsonSchema =>
  nullable({ type: 'string', description })

const idSchema = (description: string): JsonSchema => ({ type: 'string', description })

/** The `filter[...]` parameters as one closed object, each member nullable. */
function filterInput(
  doc: OpenApiDocument,
  params: readonly ParameterObject[],
): { schema: JsonSchema; decoder: Decoder } | undefined {
  const properties: Record<string, JsonSchema> = {}
  const props: Record<string, PropertyDecoder> = {}
  for (const param of params) {
    const match = /^filter\[(.+)\]$/.exec(param.name)
    if (param.in !== 'query' || match === null) {
      continue
    }
    const converted = toPortable(doc, param.schema ?? {}, [], 1)
    const schema = { ...converted.schema }
    if (typeof param.description === 'string' && schema['description'] === undefined) {
      schema['description'] = param.description
    } else if (typeof param.description === 'string') {
      schema['description'] = `${param.description} ${String(schema['description'])}`
    }
    const addNull = !allowsNull(schema)
    properties[match[1]!] = addNull ? nullable(schema) : schema
    props[match[1]!] = { decoder: converted.decoder, nullMeansOmit: true }
  }
  if (Object.keys(properties).length === 0) {
    return undefined
  }
  return {
    schema: nullable(
      closedObject(
        properties,
        'Filters to apply. Leave a filter null to not apply it, or the whole object null for none.',
      ),
    ),
    decoder: { kind: 'object', props },
  }
}

/** The page parameter's size bound and default for the strategy that answers by default. */
function pageBounds(
  doc: OpenApiDocument,
  params: readonly ParameterObject[],
  kind: string,
  sizeKey: string,
): { max?: number; default?: number } {
  const param = params.find((p) => p.in === 'query' && p.name === 'page')
  let schema = deref<JsonSchema>(doc, param?.schema)
  const branches = schema?.['oneOf'] ?? schema?.['anyOf']
  if (Array.isArray(branches)) {
    schema = branches
      .map((b) => deref<JsonSchema>(doc, b as JsonSchema))
      .find((b) => isObject(b?.['x-paginator']) && b['x-paginator']['strategy'] === kind)
  }
  const size = isObject(schema?.['properties']) ? schema['properties'][sizeKey] : undefined
  if (!isObject(size)) {
    return {}
  }
  const out: { max?: number; default?: number } = {}
  if (typeof size['maximum'] === 'number') out.max = size['maximum']
  if (typeof size['default'] === 'number') out.default = size['default']
  return out
}

/** A read tool's query arguments, read from the operation's own parameters. */
function queryInput(
  ctx: InputContext,
  paginator: PaginatorDescriptor | undefined,
  collection: boolean,
): { properties: Record<string, JsonSchema>; plan: QueryPlan } {
  const { doc, params, defaultPageSize, includeDepth } = ctx
  const properties: Record<string, JsonSchema> = {}
  const plan: QueryPlan = { sort: false, include: false, fields: [], paginated: false }

  if (collection) {
    const filter = filterInput(doc, params)
    if (filter !== undefined) {
      properties['filter'] = filter.schema
      plan.filter = filter.decoder
    }
    const sort = params.find((p) => p.in === 'query' && p.name === 'sort')
    const sortItems = deref<JsonSchema>(doc, sort?.schema?.['items'] as JsonSchema | undefined)
    const tokens = Array.isArray(sortItems?.['enum']) ? (sortItems['enum'] as string[]) : []
    if (tokens.length > 0) {
      properties['sort'] = nullable({
        type: 'array',
        items: { type: 'string', enum: tokens },
        description:
          'Fields to sort by, in order. A leading `-` sorts that field descending. Leave null for the default order.',
      })
      plan.sort = true
    }
  }

  const includable = params.some((p) => p.in === 'query' && p.name === 'include')
  const paths = includable ? capIncludePaths(includePaths(doc, ctx.operation), includeDepth) : []
  if (paths.length > 0) {
    properties['include'] = nullable({
      type: 'array',
      items: { type: 'string', enum: paths },
      description: includeDescription(includeDepth),
    })
    plan.include = true
    plan.includePaths = paths
  }

  const fieldTypes = params
    .map((p) => (p.in === 'query' ? /^fields\[(.+)\]$/.exec(p.name)?.[1] : undefined))
    .filter((t): t is string => t !== undefined)
  if (fieldTypes.length > 0) {
    const members: Record<string, JsonSchema> = {}
    for (const type of fieldTypes) {
      members[type] = nullable({ type: 'array', items: { type: 'string' } })
    }
    properties['fields'] = nullable(closedObject(members, FIELDS_DESCRIPTION))
    plan.fields = fieldTypes
  }

  if (collection && paginator !== undefined) {
    const resolved = resolvePaginator(paginator)
    if (resolved.kind !== 'none') {
      plan.paginated = true
      const sizeKey = resolved.keys.size ?? resolved.keys.limit
      if (sizeKey !== undefined) {
        const bounds = pageBounds(doc, params, resolved.kind, sizeKey)
        const fallback = Math.min(defaultPageSize, bounds.max ?? defaultPageSize)
        plan.sizeKey = sizeKey
        plan.defaultPageSize = fallback
        if (bounds.max !== undefined) plan.maxPageSize = bounds.max
        const range = bounds.max === undefined ? 'at least 1' : `1 to ${bounds.max}`
        properties['pageSize'] = nullable({
          type: 'integer',
          description: `How many results a page holds, ${range}. Leave null for ${fallback}.`,
        })
      }
      properties['pageLink'] = nullableString(PAGE_LINK_DESCRIPTION)
    }
  }

  return { properties, plan }
}

/** The `data` member's schema of a write request body. */
function requestData(doc: OpenApiDocument, schema: unknown): JsonSchema | undefined {
  const body = deref<JsonSchema>(doc, schema as JsonSchema)
  const data = isObject(body?.['properties']) ? body['properties']['data'] : undefined
  return deref<JsonSchema>(doc, data as JsonSchema)
}

/** A relation's write argument: an id, ids, or `{ type, id }` objects for a polymorphic one. */
function relationArgument(
  name: string,
  relation: RelationDescriptor,
  allowNull: boolean,
): JsonSchema {
  const polymorphic = isPolymorphic(relation)
  const one: JsonSchema = polymorphic
    ? closedObject({
        type: { type: 'string', enum: [...relation.types] },
        id: { type: 'string' },
      })
    : { type: 'string' }
  const target = polymorphic ? relation.types.join(' or ') : relation.types[0]
  if (relation.cardinality === 'many') {
    return {
      type: 'array',
      items: one,
      description: polymorphic
        ? `The ${name} relationship: every related resource, as its type (${target}) and id.`
        : `The ${name} relationship: the ids of the related \`${target}\` resources.`,
    }
  }
  const schema: JsonSchema = {
    ...one,
    description: polymorphic
      ? `The ${name} relationship: the related resource's type (${target}) and id.`
      : `The ${name} relationship: the id of the related \`${target}\` resource.`,
  }
  return allowNull ? nullable(schema) : schema
}

/**
 * A flat write input from a JSON:API write request body: the attributes and relationships as
 * one object, the API's required members required, the rest nullable.
 */
function writeInput(
  doc: OpenApiDocument,
  descriptor: ApiDescriptor,
  type: string,
  bodySchema: unknown,
  mode: 'create' | 'update' | 'action',
): { properties: Record<string, JsonSchema>; required: string[]; plan: WritePlan } {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  const fields: Record<string, WriteField> = {}
  const clearable: string[] = []
  const data = requestData(doc, bodySchema)
  const dataProps = isObject(data?.['properties']) ? data['properties'] : {}

  const attributes = deref<JsonSchema>(doc, dataProps['attributes'] as JsonSchema)
  const converted = attributes === undefined ? undefined : toPortable(doc, attributes, [], 0)
  if (converted !== undefined && converted.decoder.kind === 'object') {
    const attrRequired = new Set(
      Array.isArray(attributes!['required']) ? (attributes!['required'] as string[]) : [],
    )
    const attrProps = converted.schema['properties'] as Record<string, JsonSchema>
    for (const [name, prop] of Object.entries(converted.decoder.props)) {
      const schema = attrProps[name]!
      // The converted object already made every optional member nullable.
      properties[name] = schema
      const isRequired = mode !== 'update' && attrRequired.has(name)
      // At the top level null means "not given", except for a required member the API lets be null.
      fields[name] = { property: { decoder: prop.decoder, nullMeansOmit: !isRequired } }
      if (isRequired) {
        required.push(name)
      }
      if (!prop.nullMeansOmit && allowsNull(schema)) {
        clearable.push(name)
      }
    }
  }

  const relationships = deref<JsonSchema>(doc, dataProps['relationships'] as JsonSchema)
  const relProps = isObject(relationships?.['properties']) ? relationships['properties'] : {}
  const relRequired = new Set(
    Array.isArray(relationships?.['required']) ? (relationships['required'] as string[]) : [],
  )
  for (const [name, raw] of Object.entries(relProps)) {
    const relation = descriptor[type]?.relations[name]
    if (relation === undefined || name in properties) {
      continue
    }
    const relSchema = deref<JsonSchema>(doc, raw as JsonSchema)
    const linkage = isObject(relSchema?.['properties'])
      ? relSchema['properties']['data']
      : undefined
    const linkageAllowsNull =
      relation.cardinality === 'one' && JSON.stringify(deref(doc, linkage) ?? {}).includes('"null"')
    const isRequired = mode !== 'update' && relRequired.has(name)
    const schema = relationArgument(name, relation, linkageAllowsNull)
    properties[name] = isRequired || allowsNull(schema) ? schema : nullable(schema)
    fields[name] = {
      relation: isPolymorphic(relation)
        ? { cardinality: relation.cardinality, types: relation.types, polymorphic: true }
        : { cardinality: relation.cardinality, types: relation.types },
      property: { decoder: { kind: 'value' }, nullMeansOmit: !isRequired },
    }
    if (isRequired) {
      required.push(name)
    }
    if (linkageAllowsNull) {
      clearable.push(name)
    }
  }

  let clientId: WritePlan['clientId'] = 'none'
  if (mode === 'create') {
    const idProp = dataProps['id']
    const dataRequired = Array.isArray(data?.['required']) ? (data['required'] as string[]) : []
    if (idProp !== undefined && idProp !== false) {
      clientId = dataRequired.includes('id') ? 'required' : 'optional'
    }
  }

  return {
    properties,
    required,
    plan: { fields, clientId, clearable: mode === 'update' ? clearable : [] },
  }
}

/** Close a root object: every property required, the optional ones already nullable. */
function root(
  properties: Record<string, JsonSchema>,
  required: readonly string[],
): JsonSchema & { type: 'object' } {
  const out: Record<string, JsonSchema> = {}
  for (const [name, schema] of Object.entries(properties)) {
    out[name] = required.includes(name) || allowsNull(schema) ? schema : nullable(schema)
  }
  return closedObject(out) as JsonSchema & { type: 'object' }
}

export interface InputContext {
  doc: OpenApiDocument
  descriptor: ApiDescriptor
  params: readonly ParameterObject[]
  operation: OperationObject
  defaultPageSize: number
  /** How many relationships deep `include` may reach; null for every declared path. */
  includeDepth: number | null
}

/** A list or to-many related read. */
export function collectionInput(
  ctx: InputContext,
  paginator: PaginatorDescriptor | undefined,
  parent: { type: string; relation: string } | undefined,
  countable: CountableDescriptor | undefined,
): ToolInput {
  const { properties, plan } = queryInput(ctx, paginator, true)
  if (countable !== undefined && countable.tokens.includes(SELF_COUNT)) {
    properties['withCount'] = nullable({ type: 'boolean', description: WITH_COUNT_DESCRIPTION })
    plan.countProfile = countable.profile
  }
  const props: Record<string, JsonSchema> = {}
  const required: string[] = []
  if (parent !== undefined) {
    props['id'] = idSchema(
      `The id of the \`${parent.type}\` resource whose ${parent.relation} to list.`,
    )
    required.push('id')
  }
  return { schema: root({ ...props, ...properties }, required), query: plan }
}

/** A get or to-one related read. */
export function singleInput(ctx: InputContext, description: string): ToolInput {
  const { properties, plan } = queryInput(ctx, undefined, false)
  return { schema: root({ id: idSchema(description), ...properties }, ['id']), query: plan }
}

/** A create, from the type's create request body. */
export function createInput(ctx: InputContext, type: string): ToolInput {
  const body = deref<RequestBodyObject>(ctx.doc, ctx.operation.requestBody)
  const schema = body?.content?.['application/vnd.api+json']?.schema
  const write = writeInput(ctx.doc, ctx.descriptor, type, schema, 'create')
  const properties: Record<string, JsonSchema> = {}
  const required = [...write.required]
  if (write.plan.clientId !== 'none') {
    properties['id'] = idSchema(`The id to give the new \`${type}\` resource.`)
    if (write.plan.clientId === 'required') {
      required.push('id')
    }
  }
  return { schema: root({ ...properties, ...write.properties }, required), write: write.plan }
}

/** An update, from the type's update request body. */
export function updateInput(ctx: InputContext, type: string): ToolInput {
  const body = deref<RequestBodyObject>(ctx.doc, ctx.operation.requestBody)
  const schema = body?.content?.['application/vnd.api+json']?.schema
  const write = writeInput(ctx.doc, ctx.descriptor, type, schema, 'update')
  const properties: Record<string, JsonSchema> = {
    id: idSchema(`The id of the \`${type}\` resource to update.`),
  }
  const clearable = 'clear' in write.properties ? [] : write.plan.clearable
  const extra: Record<string, JsonSchema> = {}
  if (clearable.length > 0) {
    extra['clear'] = nullable({
      type: 'array',
      items: { type: 'string', enum: [...clearable] },
      description: 'Fields to set to null. Every other argument left null keeps its current value.',
    })
  }
  return {
    schema: root({ ...properties, ...write.properties, ...extra }, ['id']),
    write: { ...write.plan, clearable },
  }
}

/** A delete. */
export function deleteInput(type: string): ToolInput {
  return { schema: root({ id: idSchema(`The id of the \`${type}\` resource to delete.`) }, ['id']) }
}

/** The request media type a model can send to an action, in order of preference. */
function pickBody(
  ctx: InputContext,
):
  | { mediaType: string; schema: unknown; kind: 'document' | 'json' | 'text' | 'form' }
  | 'none'
  | undefined {
  const body = deref<RequestBodyObject>(ctx.doc, ctx.operation.requestBody)
  const content = Object.entries(body?.content ?? {})
  if (content.length === 0) {
    return 'none'
  }
  const find = (test: (mediaType: string) => boolean) =>
    content.find(([mediaType]) => test(mediaType.toLowerCase()))
  const document = find((m) => m === 'application/vnd.api+json')
  if (document !== undefined) {
    return { mediaType: document[0], schema: document[1].schema, kind: 'document' }
  }
  const json = find((m) => m === 'application/json' || m.endsWith('+json'))
  if (json !== undefined) {
    return { mediaType: json[0], schema: json[1].schema, kind: 'json' }
  }
  const text = find((m) => m.startsWith('text/'))
  if (text !== undefined) {
    return { mediaType: text[0], schema: { type: 'string' }, kind: 'text' }
  }
  const form = content.find(([mediaType, media]) => {
    const m = mediaType.toLowerCase()
    const schema = deref<JsonSchema>(ctx.doc, media.schema)
    return (
      (m === 'application/x-www-form-urlencoded' || m.startsWith('multipart/')) &&
      isObject(schema?.['properties']) &&
      Object.keys(schema['properties']).length > 0
    )
  })
  if (form !== undefined) {
    return { mediaType: form[0], schema: form[1].schema, kind: 'form' }
  }
  return undefined
}

/**
 * A custom action's input: the resource id at resource scope, then the body. A JSON:API body
 * whose type the descriptor knows is flat, like a create; any other body is one `body` argument.
 * `undefined` when every media type the action takes is one a model can't send, such as binary.
 */
export function actionInput(
  ctx: InputContext,
  type: string,
  name: string,
  action: ActionDescriptor,
): ToolInput | undefined {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  if (action.scope === 'resource') {
    properties['id'] = idSchema(`The id of the \`${type}\` resource to run ${name} on.`)
    required.push('id')
  }
  const picked = pickBody(ctx)
  if (picked === undefined) {
    return undefined
  }
  if (picked === 'none') {
    return { schema: root(properties, required), action: { kind: 'none' } }
  }
  const body = deref<RequestBodyObject>(ctx.doc, ctx.operation.requestBody)
  const bodyRequired = body?.required === true
  if (picked.kind === 'document' && action.inputType !== undefined) {
    const write = writeInput(ctx.doc, ctx.descriptor, action.inputType, picked.schema, 'action')
    for (const [key, schema] of Object.entries(write.properties)) {
      if (!(key in properties)) {
        properties[key] = schema
      }
    }
    return {
      schema: root(properties, [...required, ...write.required.filter((r) => r !== 'id')]),
      action: { kind: 'flat', write: write.plan },
    }
  }

  const converted = toPortable(ctx.doc, picked.schema ?? {}, [], 1)
  const description =
    typeof body?.description === 'string'
      ? body.description
      : `The request body, as ${picked.mediaType}.`
  properties['body'] = {
    ...converted.schema,
    description:
      converted.schema['description'] === undefined
        ? description
        : `${description} ${String(converted.schema['description'])}`,
  }
  if (bodyRequired) {
    required.push('body')
  }
  return {
    schema: root(properties, required),
    action: {
      kind: 'body',
      decoder: converted.decoder,
      required: bodyRequired,
      mediaType: picked.mediaType,
      mediaKind: picked.kind,
    },
  }
}
