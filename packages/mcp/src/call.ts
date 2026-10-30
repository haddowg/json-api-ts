import {
  type ActionDescriptor,
  type ApiDescriptor,
  createClient,
  execute,
  fetchTransport,
  type HeadersInit,
  isActionLocation,
  isPolymorphic,
  JsonApiError,
  type JsonApiTransport,
  materialise,
  type ReadQuery,
  type TransportResponse,
} from '@haddowg/json-api-client'
import type { ResultShape } from './catalogue'
import type { McpModelPlan } from './model'
import { type QueryPlan, SELF_COUNT, type WritePlan } from './inputs'
import { isObject } from './openapi'
import { ArgumentError, decode } from './portable'
import { collectionEnvelope, type FlattenContext, resourceEnvelope } from './flatten'
import type { McpCallToolResult, McpContent, McpOperation, McpTool, McpToolError } from './types'

/** One tool the runtime serves: its operation, definition, call plan and result shape. */
export interface ToolEntry {
  op: McpOperation
  tool: McpTool
  input: McpModelPlan
  result: ResultShape
  actionKey?: string
}

/** Thrown when a `pageLink` isn't a link this tool may follow. */
export class PageLinkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PageLinkError'
  }
}

type Call = (...args: unknown[]) => Promise<unknown>

interface LooseRelation {
  related(query?: ReadQuery): Promise<unknown>
}

interface LooseHandle {
  update(patch: Record<string, unknown>): Promise<unknown>
  delete(): Promise<unknown>
  rel(name: string): LooseRelation
  actions: Record<string, Call | undefined>
}

interface LooseAccessor {
  list(query?: ReadQuery): Promise<unknown>
  get(id: string, query?: ReadQuery): Promise<unknown>
  create(input: Record<string, unknown>): Promise<unknown>
  id(id: string): LooseHandle
  actions: Record<string, Call | undefined>
}

export interface CallEnvironment {
  descriptor: ApiDescriptor
  baseUrl: string | undefined
  transport: JsonApiTransport | undefined
  headers: HeadersInit | undefined
  signal: AbortSignal | undefined
  /** How many relationships deep a result nests included resources; null for no cap. */
  includeDepth: number | null
  /** The links each type names, which a flattened resource keeps. */
  resourceLinks: Readonly<Record<string, readonly string[]>>
  /**
   * Shape results as models before format 4 describe them: `{ item }`, `{ items, links, meta }`,
   * a bare resource or meta object, and a delete as text.
   */
  legacyResults: boolean
}

const text = (value: string): McpContent => ({ type: 'text', text: value })

function structured(value: Record<string, unknown>): McpCallToolResult {
  return { content: [text(JSON.stringify(value))], structuredContent: value }
}

/** The `meta` of a JSON:API response body, when it has one. */
function responseMeta(
  response: TransportResponse | undefined,
): Record<string, unknown> | undefined {
  if (response === undefined || response.body === '') {
    return undefined
  }
  try {
    const body: unknown = JSON.parse(response.body)
    return isObject(body) && isObject(body['meta']) ? body['meta'] : undefined
  } catch {
    return undefined
  }
}

/**
 * A result in the shape a model before format 4 describes: `{ item }` for a single read,
 * `{ items, links, meta }` for a collection, the bare resource, meta object or URL otherwise,
 * and a delete as text.
 */
function legacyResult(
  entry: ToolEntry,
  envelope: Record<string, unknown>,
  location: boolean,
  id: string | undefined,
): McpCallToolResult {
  const data = envelope['data']
  if (location || entry.result === 'resource' || entry.result === 'loose') {
    if (Array.isArray(data)) {
      const { data: items, ...rest } = envelope
      return structured({ items, ...rest })
    }
    return isObject(data)
      ? structured(data)
      : { content: [text('The action returned no resource.')] }
  }
  switch (entry.result) {
    case 'item':
      return structured({ item: data ?? null })
    case 'collection': {
      const { data: items, ...rest } = envelope
      return structured({ items, ...rest })
    }
    case 'deleted':
      return { content: [text(`Deleted ${entry.op.type} ${String(id)}.`)] }
    case 'meta':
      return structured(isObject(envelope['meta']) ? envelope['meta'] : {})
    default:
      return structured(envelope)
  }
}

function requireId(args: Record<string, unknown>): string {
  const id = args['id']
  if (typeof id === 'string' && id !== '') {
    return id
  }
  if (typeof id === 'number') {
    return String(id)
  }
  throw new ArgumentError('id is required')
}

function stringList(value: unknown, name: string): string[] | undefined {
  if (value === null || value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ArgumentError(`${name} must be a list of strings`)
  }
  return value as string[]
}

/** The read query a model's arguments describe. */
export function readQuery(args: Record<string, unknown>, plan: QueryPlan): ReadQuery {
  const query: ReadQuery = {}
  if (plan.filter !== undefined && isObject(args['filter'])) {
    const filter = decode(args['filter'], plan.filter, 'filter') as Record<string, unknown>
    for (const [key, value] of Object.entries(filter)) {
      if (isObject(value)) {
        // A range filter with every bound null applies nothing.
        const bounds = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null))
        if (Object.keys(bounds).length === 0) {
          delete filter[key]
        } else {
          filter[key] = bounds
        }
      }
    }
    if (Object.keys(filter).length > 0) {
      query.filter = filter
    }
  }
  const sort = plan.sort ? stringList(args['sort'], 'sort') : undefined
  if (sort !== undefined && sort.length > 0) {
    query.sort = sort
  }
  const include = plan.include ? stringList(args['include'], 'include') : undefined
  if (plan.includePaths !== undefined) {
    const allowed = plan.includePaths
    const refused = (include ?? []).filter((path) => !allowed.includes(path))
    if (refused.length > 0) {
      throw new ArgumentError(
        `include can't name ${refused.map((p) => `"${p}"`).join(', ')}; this tool includes only ${allowed.join(', ')}`,
      )
    }
  }
  if (include !== undefined && include.length > 0) {
    query.include = include
  }
  if (plan.fields.length > 0 && isObject(args['fields'])) {
    const fields: Record<string, string[]> = {}
    for (const [type, names] of Object.entries(args['fields'])) {
      const list = stringList(names, `fields.${type}`)
      if (list !== undefined) {
        fields[type] = list
      }
    }
    if (Object.keys(fields).length > 0) {
      query.fields = fields
    }
  }
  if (plan.countProfile !== undefined && args['withCount'] === true) {
    query.withCount = [SELF_COUNT]
  }
  if (plan.sizeKey !== undefined) {
    const asked = args['pageSize']
    let size =
      typeof asked === 'number' && Number.isFinite(asked)
        ? Math.trunc(asked)
        : plan.defaultPageSize!
    size = Math.max(1, plan.maxPageSize === undefined ? size : Math.min(size, plan.maxPageSize))
    query.page = { [plan.sizeKey]: size }
  }
  return query
}

/** The flat write input a model's arguments describe: relations as identifiers, nulls resolved. */
export function writeInput(
  args: Record<string, unknown>,
  plan: WritePlan,
): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  for (const [name, field] of Object.entries(plan.fields)) {
    const value = args[name]
    if (value === undefined || (value === null && field.property.nullMeansOmit)) {
      continue
    }
    if (value === null) {
      input[name] = null
      continue
    }
    const relation = field.relation
    if (relation === undefined) {
      input[name] = decode(value, field.property.decoder, name)
      continue
    }
    const identify = (item: unknown): unknown => {
      if (isPolymorphic(relation)) {
        if (!isObject(item) || typeof item['type'] !== 'string' || typeof item['id'] !== 'string') {
          throw new ArgumentError(`${name} takes the related resource's type and id`)
        }
        return { type: item['type'], id: item['id'] }
      }
      if (typeof item !== 'string' && typeof item !== 'number') {
        throw new ArgumentError(`${name} takes the related resource's id`)
      }
      return { type: relation.types[0], id: String(item) }
    }
    if (relation.cardinality === 'many') {
      if (!Array.isArray(value)) {
        throw new ArgumentError(`${name} takes a list`)
      }
      input[name] = value.map(identify)
    } else {
      input[name] = identify(value)
    }
  }
  for (const name of stringList(args['clear'], 'clear') ?? []) {
    if (!plan.clearable.includes(name)) {
      throw new ArgumentError(`clear can't name "${name}"`)
    }
    input[name] = null
  }
  if (plan.clientId !== 'none' && args['id'] !== null && args['id'] !== undefined) {
    input['id'] = String(args['id'])
  }
  return input
}

/** Escape a string for a regular expression. */
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Check a `pageLink` against the tool's own endpoint: the base URL's origin and the endpoint's
 * path, with any id in it. Returns the absolute URL to fetch.
 */
export function checkPageLink(link: unknown, baseUrl: string, template: string): string {
  if (typeof link !== 'string' || link === '') {
    throw new PageLinkError('pageLink must be a link string')
  }
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    throw new PageLinkError('pageLink needs an absolute base URL to be checked against')
  }
  let url: URL
  try {
    url = new URL(link, base)
  } catch {
    throw new PageLinkError('pageLink is not a valid URL')
  }
  const prefix = base.pathname.replace(/\/$/, '')
  const pattern = template
    .split(/(\{[^}]+\})/)
    .map((part) => (/^\{[^}]+\}$/.test(part) ? '[^/]+' : escape(part)))
    .join('')
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.origin !== base.origin ||
    !new RegExp(`^${escape(prefix)}${pattern}$`).test(url.pathname)
  ) {
    throw new PageLinkError(
      'pageLink must be one of the links this tool returned; it points somewhere else',
    )
  }
  return url.href
}

/** The descriptor entry a call sends this action with: the operation's method and the body plan picked. */
function effectiveAction(entry: ToolEntry): ActionDescriptor {
  const {
    inputMedia: _inputMedia,
    inputType,
    contentType: _contentType,
    ...action
  } = entry.op.actionDescriptor!
  const plan = entry.input.action!
  const base = { ...action, method: entry.op.method }
  switch (plan.kind) {
    case 'none':
      return { ...base, input: 'none' }
    case 'flat':
      return inputType === undefined
        ? { ...base, input: 'document' }
        : { ...base, input: 'document', inputType }
    case 'body':
      return plan.mediaKind === 'document'
        ? { ...base, input: 'document' }
        : { ...base, input: 'raw', contentType: plan.mediaType }
  }
}

function withAction(descriptor: ApiDescriptor, entry: ToolEntry): ApiDescriptor {
  const resource = descriptor[entry.op.type]!
  return {
    ...descriptor,
    [entry.op.type]: {
      ...resource,
      actions: { ...resource.actions, [entry.actionKey!]: effectiveAction(entry) },
    },
  }
}

async function binaryContent(
  value: Blob | ArrayBuffer,
  uri: string,
  mimeType: string,
): Promise<McpContent> {
  const bytes = value instanceof ArrayBuffer ? value : await value.arrayBuffer()
  const data = Buffer.from(bytes).toString('base64')
  return mimeType.startsWith('image/')
    ? { type: 'image', data, mimeType }
    : { type: 'resource', resource: { uri, mimeType, blob: data } }
}

/** Run one tool call against the API. Throws what the call failed with. */
export async function runCall(
  entry: ToolEntry,
  rawArgs: unknown,
  env: CallEnvironment,
): Promise<McpCallToolResult> {
  if (rawArgs !== undefined && rawArgs !== null && !isObject(rawArgs)) {
    throw new ArgumentError('the arguments must be an object')
  }
  const args = (rawArgs ?? {}) as Record<string, unknown>
  if (env.baseUrl === undefined) {
    throw new Error(
      'No base URL: pass baseUrl, return one from requestInit, or give the document a server',
    )
  }
  // The last response, for a document's meta when the client returns no resource to carry it.
  let last: TransportResponse | undefined
  const inner = env.transport ?? fetchTransport
  const transport: JsonApiTransport = async (request) => {
    last = await inner(request)
    return last
  }
  const outcome = await callApi(entry, args, { ...env, baseUrl: env.baseUrl, transport })
  const id = entry.op.kind === 'delete' ? requireId(args) : undefined
  if (outcome.kind === 'content') {
    return outcome.result
  }
  const location = outcome.kind === 'envelope' && outcome.location === true
  const envelope =
    outcome.kind === 'envelope'
      ? outcome.envelope
      : withFallbackMeta(outcome.envelope, responseMeta(last))
  return env.legacyResults ? legacyResult(entry, envelope, location, id) : structured(envelope)
}

type Outcome =
  | { kind: 'content'; result: McpCallToolResult }
  | { kind: 'envelope'; envelope: Record<string, unknown>; location?: boolean }
  /** An envelope that takes the response's meta when it has none of its own. */
  | { kind: 'bare'; envelope: Record<string, unknown> }

function withFallbackMeta(
  envelope: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return meta === undefined || envelope['meta'] !== undefined ? envelope : { ...envelope, meta }
}

const envelope = (value: Record<string, unknown>): Outcome => ({
  kind: 'envelope',
  envelope: value,
})

async function callApi(
  entry: ToolEntry,
  args: Record<string, unknown>,
  env: CallEnvironment & { transport: JsonApiTransport; baseUrl: string },
): Promise<Outcome> {
  const { op } = entry
  const descriptor = op.kind === 'action' ? withAction(env.descriptor, entry) : env.descriptor
  const headers = env.headers
  const client = createClient(descriptor, {
    baseUrl: env.baseUrl,
    transport: env.transport,
    ...(headers !== undefined ? { headers: () => headers } : {}),
  })
  const accessor = (client as unknown as Record<string, LooseAccessor>)[op.type]!
  const query = entry.input.query === undefined ? undefined : readQuery(args, entry.input.query)
  if (query !== undefined && env.signal !== undefined) {
    query.signal = env.signal
  }
  const flat: FlattenContext = {
    descriptor: env.descriptor,
    includeDepth: env.includeDepth,
    resourceLinks: env.resourceLinks,
  }

  switch (op.kind) {
    case 'list':
    case 'related': {
      if (entry.result === 'item') {
        const related = await accessor.id(requireId(args)).rel(op.relation!).related(query)
        return { kind: 'bare', envelope: resourceEnvelope(related, flat) }
      }
      let collection: unknown
      if (
        args['pageLink'] !== undefined &&
        args['pageLink'] !== null &&
        entry.input.query?.paginated
      ) {
        const url = checkPageLink(args['pageLink'], env.baseUrl, op.path)
        const doc = await execute(
          {
            baseUrl: env.baseUrl,
            transport: env.transport,
            ...(headers !== undefined ? { headers: () => headers } : {}),
          },
          {
            method: 'GET',
            path: url,
            link: true,
            ...(entry.input.query?.countProfile !== undefined &&
            new URL(url).searchParams.has('withCount')
              ? { profiles: [entry.input.query.countProfile] }
              : {}),
            ...(env.signal !== undefined ? { signal: env.signal } : {}),
          },
        )
        collection =
          doc === undefined
            ? []
            : materialise(doc, {
                descriptor: env.descriptor,
                navigate: () => Promise.reject(new Error('not navigable')),
              })
      } else if (op.kind === 'list') {
        collection = await accessor.list(query)
      } else {
        collection = await accessor.id(requireId(args)).rel(op.relation!).related(query)
      }
      return envelope(collectionEnvelope(Array.isArray(collection) ? collection : [], flat))
    }
    case 'get':
      return {
        kind: 'bare',
        envelope: resourceEnvelope(await accessor.get(requireId(args), query), flat),
      }
    case 'create': {
      const input = writeInput(args, entry.input.write!)
      const created = await accessor.create(input)
      // A 204 to a client-generated id sends nothing back but the id the caller chose.
      return {
        kind: 'bare',
        envelope: resourceEnvelope(
          isObject(created) ? created : { id: String(input['id'] ?? ''), type: op.type },
          flat,
        ),
      }
    }
    case 'update': {
      const id = requireId(args)
      const updated = await accessor.id(id).update(writeInput(args, entry.input.write!))
      return {
        kind: 'bare',
        envelope: resourceEnvelope(isObject(updated) ? updated : { id, type: op.type }, flat),
      }
    }
    case 'delete':
      await accessor.id(requireId(args)).delete()
      return { kind: 'bare', envelope: { data: null } }
    case 'action':
      return runAction(entry, args, accessor, env, flat)
  }
}

async function runAction(
  entry: ToolEntry,
  args: Record<string, unknown>,
  accessor: LooseAccessor,
  env: CallEnvironment & { baseUrl: string },
  flat: FlattenContext,
): Promise<Outcome> {
  const { op } = entry
  const action = op.actionDescriptor!
  const actions =
    action.scope === 'resource' ? accessor.id(requireId(args)).actions : accessor.actions
  const call = actions[entry.actionKey!]!
  const options = env.signal === undefined ? {} : { signal: env.signal }
  const plan = entry.input.action!
  let result: unknown
  if (plan.kind === 'none') {
    result = await call(options)
  } else {
    const body =
      plan.kind === 'flat'
        ? writeInput(args, plan.write)
        : args['body'] === null
          ? undefined
          : decode(args['body'], plan.decoder, 'body')
    if (plan.kind === 'body' && plan.required && body === undefined) {
      throw new ArgumentError('body is required')
    }
    result = await call(body, options)
  }

  // A URL the action produced goes back as data; the tool never fetches it.
  if (action.location !== undefined && isActionLocation(result)) {
    return { kind: 'envelope', envelope: { data: { ...result } }, location: true }
  }

  const content = (value: string): Outcome => ({
    kind: 'content',
    result: { content: [text(value)] },
  })
  switch (entry.result) {
    case 'collection':
      return envelope(collectionEnvelope(Array.isArray(result) ? result : [], flat))
    case 'resource':
    case 'loose':
      if (Array.isArray(result)) {
        return envelope(collectionEnvelope(result, flat))
      }
      return { kind: 'bare', envelope: resourceEnvelope(isObject(result) ? result : null, flat) }
    case 'meta':
      return envelope({ meta: isObject(result) ? result : {} })
    case 'raw': {
      const mimeType = action.rawOutput?.[0]?.mediaType ?? 'application/octet-stream'
      if (result === undefined) {
        return content('Done.')
      }
      if (typeof result === 'string') {
        return content(result)
      }
      if (
        result instanceof ArrayBuffer ||
        (typeof Blob !== 'undefined' && result instanceof Blob)
      ) {
        return {
          kind: 'content',
          result: {
            content: [await binaryContent(result, `${env.baseUrl}${action.path}`, mimeType)],
          },
        }
      }
      return content(JSON.stringify(result))
    }
    default:
      return content('Done.')
  }
}

/** The error a failed call carries, before the host's `mapError`. */
export function toToolError(error: unknown): McpToolError {
  if (error instanceof JsonApiError) {
    return {
      status: error.status,
      message: error.message,
      errors: error.errors.map((e) => {
        const out: McpToolError['errors'][number] = {}
        if (e.status !== undefined) out.status = e.status
        if (e.code !== undefined) out.code = e.code
        if (e.title !== undefined) out.title = e.title
        if (e.detail !== undefined) out.detail = e.detail
        if (e.source !== undefined) out.source = e.source
        if (e.path !== undefined) out.path = e.path
        return out
      }),
      cause: error,
    }
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    errors: [],
    cause: error,
  }
}

/** A tool error result: the message, the status and each error object, as JSON text. */
export function errorResult(error: McpToolError): McpCallToolResult {
  const body: Record<string, unknown> = { error: error.message }
  if (error.status !== undefined) body['status'] = error.status
  if (error.errors.length > 0) body['errors'] = error.errors
  return { content: [text(JSON.stringify(body))], isError: true }
}
