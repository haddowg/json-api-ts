/**
 * Each tool's output schema, generated from the descriptor and the document's resource schemas.
 * Output schemas aren't held to the portable subset inputs are: the model only reads them.
 */
import {
  type AcceptedDescriptor,
  type ApiDescriptor,
  isPolymorphic,
} from '@haddowg/json-api-client'
import {
  deref,
  isObject,
  type JsonSchema,
  type OpenApiDocument,
  type OperationObject,
  type ResponseObject,
  resolvePointer,
} from './openapi'

type ObjectSchema = JsonSchema & { type: 'object' }

const DROPPED = new Set(['example', 'examples', 'x-enum-varnames'])

/** A document schema with refs inlined, examples dropped and any cycle cut to `{}`. */
export function outputSchema(
  doc: OpenApiDocument,
  value: unknown,
  stack: readonly string[] = [],
): JsonSchema {
  if (!isObject(value)) {
    return value === false ? { not: {} } : {}
  }
  if (typeof value['$ref'] === 'string') {
    const ref = value['$ref']
    if (stack.includes(ref)) {
      return {}
    }
    const { $ref: _ref, ...siblings } = value
    const target = outputSchema(doc, resolvePointer(doc, ref), [...stack, ref])
    return { ...target, ...outputSchema(doc, siblings, stack) }
  }
  const out: JsonSchema = {}
  for (const [key, member] of Object.entries(value)) {
    if (DROPPED.has(key)) {
      continue
    }
    if (key === 'properties' && isObject(member)) {
      const props: Record<string, JsonSchema> = {}
      for (const [name, prop] of Object.entries(member)) {
        props[name] = outputSchema(doc, prop, stack)
      }
      out[key] = props
    } else if (
      (key === 'items' || key === 'additionalProperties' || key === 'not') &&
      isObject(member)
    ) {
      out[key] = outputSchema(doc, member, stack)
    } else if ((key === 'allOf' || key === 'anyOf' || key === 'oneOf') && Array.isArray(member)) {
      out[key] = member.map((m) => outputSchema(doc, m, stack))
    } else {
      out[key] = member
    }
  }
  return out
}

/** Index the document's resource object schemas by their type, preferring `<Type>Resource`. */
export function resourceSchemas(doc: OpenApiDocument): Map<string, JsonSchema> {
  const out = new Map<string, JsonSchema>()
  const entries = Object.entries(doc.components?.schemas ?? {})
  const ordered = [
    ...entries.filter(([name]) => name.endsWith('Resource')),
    ...entries.filter(([name]) => !name.endsWith('Resource')),
  ]
  for (const [, schema] of ordered) {
    const props = isObject(schema['properties']) ? schema['properties'] : undefined
    const typeConst = isObject(props?.['type']) ? props['type']['const'] : undefined
    const describesFields =
      props?.['attributes'] !== undefined || props?.['relationships'] !== undefined
    if (typeof typeConst === 'string' && describesFields && !out.has(typeConst)) {
      out.set(typeConst, schema)
    }
  }
  return out
}

/** Every type an `include` path can reach from the primary types, the primary types included. */
export function reachableTypes(
  descriptor: ApiDescriptor,
  primary: readonly string[],
  paths: readonly string[],
): Set<string> {
  const out = new Set(primary)
  for (const path of paths) {
    let current = [...primary]
    for (const segment of path.split('.')) {
      const next: string[] = []
      for (const type of current) {
        for (const related of descriptor[type]?.relations[segment]?.types ?? []) {
          out.add(related)
          next.push(related)
        }
      }
      current = next
    }
  }
  return out
}

/** The include paths no more than `depth` relationships deep; all of them when `depth` is null. */
export function capIncludePaths(paths: readonly string[], depth: number | null): string[] {
  return depth === null ? [...paths] : paths.filter((path) => path.split('.').length <= depth)
}

/** The include paths an operation's `include` parameter lists. */
export function includePaths(doc: OpenApiDocument, op: OperationObject): string[] {
  for (const raw of op.parameters ?? []) {
    const param = deref<{ name?: string; schema?: JsonSchema }>(doc, raw)
    if (param?.name === 'include') {
      const items = deref<JsonSchema>(doc, param.schema?.['items'] as JsonSchema | undefined)
      return Array.isArray(items?.['enum']) ? (items['enum'] as string[]) : []
    }
  }
  return []
}

const ref = (type: string): JsonSchema => ({ $ref: `#/$defs/${type}` })

/** Links every resource may carry, which a flattened resource leaves out. */
const GENERIC_LINKS = new Set(['self', 'related', 'describedby'])

/** The members a flattened link keeps. */
const LINK_MEMBERS = ['href', 'type', 'title', 'meta'] as const

/**
 * The links a resource schema names: its declared links and its action links. From generator
 * contract 18 they're the properties of the `<Type>ResourceLinks` component's own `allOf`
 * member; before, they sit beside `self` in its properties.
 */
function namedLinkSchemas(
  doc: OpenApiDocument,
  resource: JsonSchema | undefined,
): [string, JsonSchema][] {
  const props = isObject(resource?.['properties']) ? resource['properties'] : {}
  const component = deref<JsonSchema>(doc, props['links'] as JsonSchema | undefined)
  if (!isObject(component)) {
    return []
  }
  const own = isObject(component['properties']) ? Object.entries(component['properties']) : []
  const extended = (Array.isArray(component['allOf']) ? component['allOf'] : [])
    .filter((member): member is JsonSchema => isObject(member) && member['$ref'] === undefined)
    .flatMap((member) =>
      isObject(member['properties']) ? Object.entries(member['properties']) : [],
    )
  return [...own, ...extended].filter(
    (entry): entry is [string, JsonSchema] => !GENERIC_LINKS.has(entry[0]) && isObject(entry[1]),
  )
}

const hasHref = (s: unknown): s is JsonSchema =>
  isObject(s) && isObject(s['properties']) && s['properties']['href'] !== undefined

/** The link object branch of a link schema: the schema itself, or its `anyOf` branch with `href`. */
function linkObjectSchema(schema: JsonSchema): JsonSchema | undefined {
  if (hasHref(schema)) {
    return schema
  }
  return (Array.isArray(schema['anyOf']) ? schema['anyOf'] : []).find(hasHref)
}

/**
 * One named link as a flattened resource carries it: `{ href, type?, title?, meta? }`, typed from
 * the document's link schema, meta members included. A link the server renders as a bare URL is
 * normalised to `{ href }`.
 */
function linkOutput(doc: OpenApiDocument, schema: JsonSchema): JsonSchema {
  const resolved = outputSchema(doc, schema)
  const object = linkObjectSchema(resolved)
  const source = isObject(object?.['properties']) ? object['properties'] : {}
  const properties: Record<string, JsonSchema> = {
    href: { type: 'string', format: 'uri-reference' },
  }
  for (const member of LINK_MEMBERS) {
    const value = source[member]
    if (isObject(value)) {
      properties[member] = member === 'href' ? { ...properties['href'], ...value } : value
    }
  }
  const declared = Array.isArray(object?.['required']) ? (object['required'] as string[]) : []
  const out: JsonSchema = {
    type: 'object',
    properties,
    required: ['href', ...declared.filter((name) => name !== 'href' && name in properties)],
  }
  if (typeof resolved['description'] === 'string') {
    out['description'] = resolved['description']
  }
  return out
}

/**
 * The names of the links each type names, for the types that name any. Throws when such a type
 * also has an attribute or relationship called `links`, which the flattened resource couldn't
 * hold beside them.
 */
export function resourceLinkNames(
  doc: OpenApiDocument,
  descriptor: ApiDescriptor,
  schemas: Map<string, JsonSchema>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [type, resource] of Object.entries(descriptor)) {
    const names = namedLinkSchemas(doc, schemas.get(type)).map(([name]) => name)
    if (names.length === 0) {
      continue
    }
    if ('links' in resource.attributes || 'links' in resource.relations) {
      throw new Error(
        `The "${type}" type names links (${names.join(', ')}) and also has a field called "links". A flattened resource carries its links under "links", so rename the field.`,
      )
    }
    out[type] = names
  }
  return out
}

/** One type's flattened resource schema: id, type, attributes, relations and named links, all optional but id and type. */
function flatResource(
  doc: OpenApiDocument,
  descriptor: ApiDescriptor,
  schemas: Map<string, JsonSchema>,
  type: string,
  expanded: ReadonlySet<string>,
): JsonSchema {
  const resource = schemas.get(type)
  const resourceProps = isObject(resource?.['properties']) ? resource['properties'] : {}
  const attributes = outputSchema(doc, resourceProps['attributes'])
  const properties: Record<string, JsonSchema> = {
    id: { type: 'string' },
    type: { type: 'string', const: type },
  }
  if (isObject(attributes['properties'])) {
    Object.assign(properties, attributes['properties'])
  }
  // A read selecting single keys of an attribute returns only the keys the resource has.
  for (const name of Object.keys(descriptor[type]?.nestedFieldsets ?? {})) {
    if (properties[name] !== undefined) {
      let narrowed = withoutRequiredKeys(properties[name])
      for (const path of descriptor[type]?.nestedFieldsetPaths?.[name] ?? []) {
        narrowed = withoutRequiredAlong(narrowed, path)
      }
      properties[name] = narrowed
    }
  }
  for (const [name, relation] of Object.entries(descriptor[type]?.relations ?? {})) {
    if (relation.writeOnly === true) {
      continue
    }
    const polymorphic = isPolymorphic(relation)
    const identifier: JsonSchema = polymorphic
      ? {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...relation.types] },
            id: { type: 'string' },
          },
          required: ['type', 'id'],
        }
      : { type: 'string' }
    const full = relation.types.filter((t) => expanded.has(t)).map(ref)
    const member = full.length === 0 ? identifier : { anyOf: [identifier, ...full] }
    const target = relation.types.join(' or ')
    properties[name] =
      relation.cardinality === 'many'
        ? {
            type: 'array',
            items: member,
            description: `The related ${target} resources: ${polymorphic ? 'type and id' : 'ids'}, or the resources themselves when included.`,
          }
        : {
            anyOf: [
              ...(full.length === 0 ? [identifier] : [identifier, ...full]),
              { type: 'null' },
            ],
            description: `The related ${target}: ${polymorphic ? 'its type and id' : 'its id'}, or the resource itself when included.`,
          }
  }
  const links = namedLinkSchemas(doc, resource)
  if (links.length > 0) {
    properties['links'] = {
      type: 'object',
      description:
        'The links the resource names, such as an upload or download URL or a custom action. A link that does not apply to this resource is absent.',
      properties: Object.fromEntries(links.map(([name, link]) => [name, linkOutput(doc, link)])),
    }
  }
  if (descriptor[type]?.resourceMeta?.read !== undefined) {
    if ('meta' in properties) {
      throw new Error(
        `The "${type}" type declares its resource meta and also has a field called "meta". A flattened resource carries its meta under "meta", so rename the field.`,
      )
    }
    const { 'x-resource-meta': _marker, ...meta } = outputSchema(doc, resourceProps['meta'])
    properties['meta'] = {
      ...meta,
      description: "The resource object's own meta, carrying the members its type declares.",
    }
  }
  const schema: JsonSchema = { type: 'object', properties, required: ['id', 'type'] }
  if (typeof resource?.['description'] === 'string') {
    schema['description'] = resource['description']
  }
  return schema
}

/**
 * `schema` free of `required`, and each branch of an `anyOf`, `oneOf` or `allOf` too, so a value a
 * read narrowed may miss any of its keys. A branch keeps the member `discriminator` names required,
 * since every narrowed value still carries it, so its `const` keeps a `oneOf` exclusive. A `oneOf`
 * with no discriminator becomes an `anyOf`, since its branches can no longer be told apart.
 */
function withoutRequiredKeys(schema: JsonSchema, keep?: string): JsonSchema {
  const { required, ...rest } = schema
  if (keep !== undefined && Array.isArray(required) && required.includes(keep)) {
    rest['required'] = [keep]
  }
  const discriminator = discriminatorOf(schema)
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = rest[key]
    if (Array.isArray(branches)) {
      rest[key] = branches.map((branch) =>
        isObject(branch) ? withoutRequiredKeys(branch as JsonSchema, discriminator) : branch,
      )
    }
  }
  return discriminator === undefined ? exclusiveAsAny(rest) : rest
}

/** The member a union schema's `discriminator` names, if it has one. */
function discriminatorOf(schema: JsonSchema): string | undefined {
  const discriminator = schema['discriminator']
  return isObject(discriminator) && typeof discriminator['propertyName'] === 'string'
    ? discriminator['propertyName']
    : undefined
}

/**
 * `schema` with a `oneOf` read as an `anyOf`: variants that may miss their required members can no
 * longer be told apart by them, so a value may match more than one.
 */
function exclusiveAsAny(schema: JsonSchema): JsonSchema {
  if (!Array.isArray(schema['oneOf'])) {
    return schema
  }
  const { oneOf, ...rest } = schema
  return rest['anyOf'] === undefined
    ? { ...rest, anyOf: oneOf }
    : { ...rest, allOf: [...((rest['allOf'] as unknown[] | undefined) ?? []), { anyOf: oneOf }] }
}

/**
 * `schema` with the object a key path leads to free of `required`: each key but the last steps
 * into the declared property it names or, for a key pattern, the schema of undeclared members,
 * and a list's `\*` steps into its `items`.
 */
function withoutRequiredAlong(schema: JsonSchema, path: readonly string[]): JsonSchema {
  if (path.length <= 1) {
    return withoutRequiredKeys(schema)
  }
  const [segment, ...rest] = path as [string, ...string[]]
  const out: JsonSchema = { ...schema }
  if (segment === ITEMS) {
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
      const branches = out[key]
      if (Array.isArray(branches)) {
        out[key] = branches.map((branch) =>
          isObject(branch) ? withoutRequiredAlong(branch as JsonSchema, path) : branch,
        )
      }
    }
    if (isObject(out['items'])) {
      out['items'] = withoutRequiredAlong(out['items'] as JsonSchema, rest)
    }
    return out
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = out[key]
    if (Array.isArray(branches)) {
      out[key] = branches.map((branch) =>
        isObject(branch) ? withoutRequiredAlong(branch as JsonSchema, path) : branch,
      )
    }
  }
  const name = keyName(segment)
  const properties = out['properties']
  if (name !== undefined && isObject(properties) && isObject(properties[name])) {
    out['properties'] = {
      ...properties,
      [name]: withoutRequiredAlong(properties[name] as JsonSchema, rest),
    }
  }
  const additional = out['additionalProperties']
  if (name === undefined && isObject(additional)) {
    out['additionalProperties'] = withoutRequiredAlong(additional as JsonSchema, rest)
  }
  return out
}

/** The key pattern of a list, whose one key `*` stands for every item. */
const ITEMS = '\\*'

/**
 * The key a segment of a key path pattern names when it is a plain name the server escaped, such
 * as `geo`, or `undefined` for a pattern matching many keys.
 */
export function keyName(segment: string): string | undefined {
  return /^(?:\\[\\^$.*+?()[\]{}|/#-]|[^\\^$.*+?()[\]{}|/])+$/.test(segment)
    ? segment.replace(/\\(.)/g, '$1')
    : undefined
}

function defsFor(
  doc: OpenApiDocument,
  descriptor: ApiDescriptor,
  schemas: Map<string, JsonSchema>,
  types: ReadonlySet<string>,
): Record<string, JsonSchema> {
  const defs: Record<string, JsonSchema> = {}
  for (const type of types) {
    defs[type] = flatResource(doc, descriptor, schemas, type, types)
  }
  return defs
}

export interface OutputContext {
  doc: OpenApiDocument
  descriptor: ApiDescriptor
  schemas: Map<string, JsonSchema>
  operation: OperationObject
  /** The include paths the tool may ask for, already capped at the model's include depth. */
  includes: readonly string[]
  /** The success statuses whose document meta the output reads. Absent means every one. */
  statuses?: (status: string) => boolean
}

/** The `meta` a success response's JSON:API document declares. */
interface ResponseMeta {
  schema: JsonSchema
  /** Whether every such document carries `meta`, as a per-operation document says. */
  required: boolean
  /** The members a per-operation document (`x-document-meta`) declares, in order. */
  declared: readonly string[]
}

/**
 * The `meta` a document schema declares: the narrowing of a per-operation document marked
 * `x-document-meta`, else its own `meta` property.
 */
function documentSchemaMeta(doc: OpenApiDocument, schema: JsonSchema): ResponseMeta | undefined {
  if (schema['x-document-meta'] === true && Array.isArray(schema['allOf'])) {
    for (const entry of (schema['allOf'] as unknown[]).slice(1)) {
      const narrowing = deref<JsonSchema>(doc, entry as JsonSchema)
      const meta = isObject(narrowing?.['properties']) ? narrowing['properties']['meta'] : undefined
      if (narrowing === undefined || meta === undefined) {
        continue
      }
      const resolved = outputSchema(doc, meta)
      const members = isObject(resolved['properties']) ? Object.keys(resolved['properties']) : []
      return {
        schema: resolved,
        required: Array.isArray(narrowing['required']) && narrowing['required'].includes('meta'),
        declared: members,
      }
    }
  }
  const meta = isObject(schema['properties']) ? schema['properties']['meta'] : undefined
  return meta === undefined
    ? undefined
    : { schema: outputSchema(doc, meta), required: false, declared: [] }
}

/** The `meta` the first success response the output reads declares. */
function successMeta(ctx: OutputContext): ResponseMeta | undefined {
  for (const [status, raw] of Object.entries(ctx.operation.responses ?? {})) {
    if (!status.startsWith('2') || ctx.statuses?.(status) === false) continue
    const response = deref<ResponseObject>(ctx.doc, raw)
    const schema = deref<JsonSchema>(
      ctx.doc,
      response?.content?.['application/vnd.api+json']?.schema,
    )
    const meta = schema === undefined ? undefined : documentSchemaMeta(ctx.doc, schema)
    if (meta !== undefined) {
      return meta
    }
  }
  return undefined
}

/** `a`, `a and b` or `a, b and c`, each in backticks. */
function memberList(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name}\``)
  return quoted.length < 2
    ? quoted.join('')
    : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
}

/**
 * The members the operation's per-operation documents declare in their top-level `meta`, across
 * its success statuses, without repeats. Empty when it answers with the shared documents.
 */
export function declaredMetaMembers(ctx: OutputContext): string[] {
  const out = new Set<string>()
  for (const [status, raw] of Object.entries(ctx.operation.responses ?? {})) {
    if (!status.startsWith('2')) continue
    const response = deref<ResponseObject>(ctx.doc, raw)
    const schema = deref<JsonSchema>(
      ctx.doc,
      response?.content?.['application/vnd.api+json']?.schema,
    )
    for (const name of schema === undefined
      ? []
      : (documentSchemaMeta(ctx.doc, schema)?.declared ?? [])) {
      out.add(name)
    }
  }
  return [...out]
}

/** The sentence a tool's description adds naming the `meta` members its result carries. */
export function declaredMetaSentence(ctx: OutputContext): string | undefined {
  const members = declaredMetaMembers(ctx)
  return members.length === 0 ? undefined : `The result's \`meta\` carries ${memberList(members)}.`
}

const LINKS: JsonSchema = {
  type: 'object',
  description:
    'Pagination links. Pass one to this tool as `pageLink` to fetch that page; a missing link means there is no such page.',
  properties: {
    first: { type: 'string' },
    prev: { type: 'string' },
    next: { type: 'string' },
    last: { type: 'string' },
  },
}

/**
 * The document `meta` member of an envelope: what the response declares, when it sends any. A
 * per-operation document's description names the members it declares.
 */
function documentMeta(ctx: OutputContext, description: string): JsonSchema {
  const meta = successMeta(ctx)
  if (meta === undefined) {
    return { type: 'object', description }
  }
  const declared =
    meta.declared.length === 0
      ? description
      : `The document meta, carrying ${memberList(meta.declared)}.`
  return { ...meta.schema, description: declared }
}

/** The members an envelope requires, with `meta` when the operation's document always has it. */
function withRequiredMeta(ctx: OutputContext, required: string[]): string[] {
  return successMeta(ctx)?.required === true ? [...required, 'meta'] : required
}

/** A collection: `{ data, links, meta? }`. */
export function collectionOutput(ctx: OutputContext, types: readonly string[]): ObjectSchema {
  const reachable = reachableTypes(ctx.descriptor, types, ctx.includes)
  const items = types.length === 1 ? ref(types[0]!) : { anyOf: types.map(ref) }
  return {
    type: 'object',
    properties: {
      data: { type: 'array', items, description: 'The resources on this page.' },
      links: LINKS,
      meta: documentMeta(ctx, 'The document meta, such as page totals.'),
    },
    required: withRequiredMeta(ctx, ['data', 'links']),
    $defs: defsFor(ctx.doc, ctx.descriptor, ctx.schemas, reachable),
  }
}

/**
 * One resource: `{ data, meta? }`. `data` is null where the operation may find nothing, such as
 * a to-one related read with nothing related.
 */
export function resourceOutput(
  ctx: OutputContext,
  types: readonly string[],
  nullable: string | false = false,
): ObjectSchema {
  const reachable = reachableTypes(ctx.descriptor, types, ctx.includes)
  const data: JsonSchema =
    nullable !== false
      ? { anyOf: [...types.map(ref), { type: 'null' }], description: nullable }
      : types.length === 1
        ? { ...ref(types[0]!), description: 'The resource.' }
        : { anyOf: types.map(ref), description: 'The resource.' }
  return {
    type: 'object',
    properties: {
      data,
      meta: documentMeta(ctx, 'The document meta, when the API sends any.'),
    },
    required: withRequiredMeta(ctx, ['data']),
    $defs: defsFor(ctx.doc, ctx.descriptor, ctx.schemas, reachable),
  }
}

/** A delete: `{ data: null, meta? }`. */
export function deletedOutput(ctx: OutputContext): ObjectSchema {
  return {
    type: 'object',
    properties: {
      data: { type: 'null', description: 'Always null: the resource is gone.' },
      meta: documentMeta(ctx, 'The document meta, when the API sends any.'),
    },
    required: withRequiredMeta(ctx, ['data']),
  }
}

/** A meta-only result: `{ meta }`, the document's own `meta`, with no `data`. */
export function metaOutput(ctx: OutputContext): ObjectSchema {
  return {
    type: 'object',
    properties: {
      meta: { ...documentMeta(ctx, 'The document meta.'), type: 'object' },
    },
    required: ['meta'],
  }
}

/**
 * The output of an action whose `200` is meta-only while another status answers with a resource:
 * either result, each with the meta its own status declares, sharing the root `$defs`.
 */
export function orMetaOutput(ctx: OutputContext, resource: ObjectSchema): ObjectSchema {
  const { $defs, ...rest } = resource
  return {
    type: 'object',
    anyOf: [rest, metaOutput({ ...ctx, statuses: (status) => status === '200' })],
    ...($defs === undefined ? {} : { $defs }),
  }
}

/** The context reading every success status but a `202`, whose job document is its own result. */
export function withoutAccepted(ctx: OutputContext): OutputContext {
  const statuses = ctx.statuses
  return {
    ...ctx,
    statuses: (status) => status !== '202' && (statuses === undefined || statuses(status)),
  }
}

/**
 * The job a write or action the API accepted for later answers with: `{ data?, meta? }`, the job
 * resource and the meta its `202` document declares. `data` may be absent, for a meta-only job.
 */
function acceptedOutput(ctx: OutputContext, accepted: AcceptedDescriptor): ObjectSchema {
  const at202: OutputContext = { ...ctx, includes: [], statuses: (status) => status === '202' }
  const meta = documentMeta(at202, 'The job document meta, when the API sends any.')
  const required = withRequiredMeta(at202, [])
  const description = 'The job the API accepted the request as, to finish later.'
  if (ctx.descriptor[accepted.jobType] === undefined) {
    return {
      type: 'object',
      properties: { data: { description }, meta },
      ...(required.length > 0 ? { required } : {}),
    }
  }
  return {
    type: 'object',
    properties: { data: { ...ref(accepted.jobType), description }, meta },
    ...(required.length > 0 ? { required } : {}),
    $defs: defsFor(ctx.doc, ctx.descriptor, ctx.schemas, new Set([accepted.jobType])),
  }
}

/**
 * The output of a write or action that may answer `202 Accepted`: its usual result or the job,
 * sharing the root `$defs`. `usual` is read without the `202`, see {@link withoutAccepted}. An
 * operation whose only success is the `202` always answers with the job.
 */
export function orAccepted(
  ctx: OutputContext,
  usual: JsonSchema,
  accepted: AcceptedDescriptor,
): ObjectSchema {
  const answersOtherwise = Object.keys(ctx.operation.responses ?? {}).some(
    (status) => status.startsWith('2') && status !== '202',
  )
  if (!answersOtherwise) {
    return acceptedOutput(ctx, accepted)
  }
  const { $defs: usualDefs, ...rest } = usual
  const { $defs: jobDefs, ...job } = acceptedOutput(ctx, accepted)
  const $defs = {
    ...(jobDefs as Record<string, JsonSchema> | undefined),
    ...(usualDefs as Record<string, JsonSchema> | undefined),
  }
  return {
    type: 'object',
    anyOf: [rest, job],
    ...(Object.keys($defs).length === 0 ? {} : { $defs }),
  }
}

/** A JSON:API result whose primary type the descriptor doesn't name. */
export const LOOSE_OUTPUT: ObjectSchema = {
  type: 'object',
  properties: {
    data: { description: 'The flattened resource or resources.' },
    links: LINKS,
    meta: { type: 'object', description: 'The document meta, when the API sends any.' },
  },
}

/** The URL an action answered with (generator contract 17): `{ url, type, expiresAt? }`. */
function locationData(mediaType: string): JsonSchema {
  return {
    type: 'object',
    description:
      'The URL the action produced, such as a short-lived download link. The tool does not fetch it.',
    properties: {
      url: { type: 'string', format: 'uri-reference', description: 'The URL.' },
      type: {
        type: 'string',
        description: `The media type the URL serves. The action declares \`${mediaType}\`.`,
      },
      expiresAt: {
        type: 'string',
        format: 'date-time',
        description: 'When the URL stops working. Absent when it does not expire.',
      },
    },
    required: ['url', 'type'],
    additionalProperties: false,
  }
}

/** An action that answered with a URL: `{ data: { url, type, expiresAt? } }`. */
export function locationOutput(mediaType: string): ObjectSchema {
  return {
    type: 'object',
    properties: { data: locationData(mediaType) },
    required: ['data'],
  }
}

/** An action's usual output or the URL it may answer with instead, sharing the root `$defs`. */
export function orLocation(schema: JsonSchema, mediaType: string): ObjectSchema {
  const { $defs, ...rest } = schema
  return {
    type: 'object',
    anyOf: [rest, locationOutput(mediaType)],
    ...($defs === undefined ? {} : { $defs }),
  }
}
