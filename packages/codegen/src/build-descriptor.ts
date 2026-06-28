import type {
  ActionDescriptor,
  ApiDescriptor,
  AtomicDescriptor,
  ClientIdPolicy,
  PaginatorKind,
  RelationDescriptor,
  RelationMutations,
  ResourceDescriptor,
} from '@haddowg/json-api-client'
import { ATOMIC_EXT } from '@haddowg/json-api-client'
import type {
  HttpMethod,
  OpenApiDocument,
  OperationObject,
  PathItemObject,
  SchemaObject,
  SchemaOrBool,
} from './openapi'

const REF_PREFIX = '#/components/schemas/'
const JSON_API_MEDIA_TYPE = 'application/vnd.api+json'

/** Sort a record's keys for deterministic, snapshot-stable output. */
function sortRecord<V>(record: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {}
  // oxlint-disable-next-line no-array-sort -- sorting a freshly-created key array
  for (const key of Object.keys(record).sort()) {
    out[key] = record[key]!
  }
  return out
}

/** Resolve a local schema name from a `#/components/schemas/X` ref. */
function refName(ref: string): string | undefined {
  return ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : undefined
}

function isSchema(value: SchemaOrBool | undefined): value is SchemaObject {
  return typeof value === 'object' && value !== null
}

/** The set of `type` keys a JSON type node declares, with `"null"` removed. */
function typeKeys(type: string | readonly string[] | undefined): string[] {
  if (type === undefined) {
    return []
  }
  return (Array.isArray(type) ? type : [type]).filter((t) => t !== 'null')
}

export class DescriptorBuilder {
  private readonly schemas: Record<string, SchemaObject>
  private readonly paths: Record<string, PathItemObject>

  constructor(private readonly doc: OpenApiDocument) {
    this.schemas = doc.components?.schemas ?? {}
    this.paths = doc.paths ?? {}
  }

  build(): ApiDescriptor {
    const out: Record<string, ResourceDescriptor> = {}
    for (const [name, schema] of Object.entries(this.schemas)) {
      const wireType = this.resourceType(name, schema)
      if (wireType === undefined) {
        continue
      }
      const base = name.slice(0, -'Resource'.length)
      const collection = this.collectionPath(base)
      const actions = collection ? this.actions(collection) : {}
      const descriptor: ResourceDescriptor = {
        attributes: this.attributes(base),
        relations: this.relations(schema, collection),
        paths: this.operationPaths(base),
        paginator: this.paginator(base),
        clientId: this.clientId(base),
      }
      if (Object.keys(actions).length > 0) {
        descriptor.actions = actions
      }
      out[wireType] = descriptor
    }
    return sortRecord(out)
  }

  /**
   * The server-level Atomic Operations capability: the path whose `POST` requestBody
   * declares the atomic ext media type ({@link ATOMIC_EXT}). `null` when no such endpoint
   * exists. Server-level, so it rides {@link buildAtomic}, not the per-type descriptor.
   */
  buildAtomic(): AtomicDescriptor | null {
    for (const [path, item] of Object.entries(this.paths)) {
      const content = item.post?.requestBody?.content ?? {}
      if (Object.keys(content).some(isAtomicMediaType)) {
        return { path }
      }
    }
    return null
  }

  /**
   * A resource schema is one whose name ends in `Resource` (but not
   * `ResourceIdentifier`) and carries `properties.type.const` (a string) — that const
   * is the descriptor key (the wire type). Never inferred from the schema name.
   */
  private resourceType(name: string, schema: SchemaObject): string | undefined {
    if (!name.endsWith('Resource') || name.endsWith('ResourceIdentifier')) {
      return undefined
    }
    const constValue = schema.properties?.['type']
    if (isSchema(constValue) && typeof constValue.const === 'string') {
      return constValue.const
    }
    return undefined
  }

  /** Follow a `$ref` to its identifier/resource schema and read `properties.type.const`. */
  private resolveConst(ref: string): string | undefined {
    const target = refName(ref)
    if (target === undefined) {
      return undefined
    }
    const typeProp = this.schemas[target]?.properties?.['type']
    return isSchema(typeProp) && typeof typeProp.const === 'string' ? typeProp.const : undefined
  }

  private attributes(base: string): Record<string, string> {
    const attrs = this.schemas[`${base}Attributes`]
    const props = attrs?.properties
    if (props === undefined) {
      return {}
    }
    const out: Record<string, string> = {}
    for (const [name, prop] of Object.entries(props)) {
      if (isSchema(prop)) {
        out[name] = formatHint(prop)
      }
    }
    return sortRecord(out)
  }

  private relations(
    resource: SchemaObject,
    collection: string | undefined,
  ): Record<string, RelationDescriptor> {
    const relProps = isSchema(resource.properties?.['relationships'])
      ? resource.properties['relationships'].properties
      : undefined
    if (relProps === undefined) {
      return {}
    }
    const out: Record<string, RelationDescriptor> = {}
    for (const [name, prop] of Object.entries(relProps)) {
      if (!isSchema(prop) || typeof prop.$ref !== 'string') {
        continue
      }
      const component = this.schemas[refName(prop.$ref) ?? '']
      const descriptor = component ? this.relationFromComponent(component) : undefined
      if (descriptor !== undefined) {
        const mutations = collection
          ? this.relationMutations(collection, name, descriptor.cardinality)
          : undefined
        out[name] = mutations === undefined ? descriptor : { ...descriptor, mutations }
      }
    }
    return sortRecord(out)
  }

  /**
   * The per-relation mutation capability, derived from the HTTP methods the relationship
   * endpoint (`{collection}/{id}/relationships/{rel}`) advertises. For a to-many:
   * `add` <- POST, `remove` <- DELETE, `replace` <- PATCH. For a to-one: `set` <- PATCH.
   * Only `true` verbs are emitted (a missing verb is simply absent). Returns `undefined`
   * when the relation exposes no relationship endpoint at all.
   */
  private relationMutations(
    collection: string,
    rel: string,
    cardinality: RelationDescriptor['cardinality'],
  ): RelationMutations | undefined {
    const item = this.paths[`${collection}/{id}/relationships/${rel}`]
    if (item === undefined) {
      return undefined
    }
    const mutations: RelationMutations = {}
    if (cardinality === 'many') {
      if (item.post) {
        mutations.add = true
      }
      if (item.delete) {
        mutations.remove = true
      }
      if (item.patch) {
        mutations.replace = true
      }
    } else if (item.patch) {
      mutations.set = true
    }
    return mutations
  }

  /**
   * Collect the custom actions for a type from its `{collection}/-actions/{name}` and
   * `{collection}/{id}/-actions/{name}` paths. The action name is the last segment; scope
   * is `resource` when the path carries `/{id}/`, else `collection`. `input` is `document`
   * (a JSON:API requestBody), `none` (no requestBody) or `raw` (a non-JSON:API body);
   * `output` is `document` (a 2xx returns a JSON:API document) or `none` (only `204`).
   */
  private actions(collection: string): Record<string, ActionDescriptor> {
    const out: Record<string, ActionDescriptor> = {}
    const collectionPrefix = `${collection}/-actions/`
    const resourcePrefix = `${collection}/{id}/-actions/`
    for (const [path, item] of Object.entries(this.paths)) {
      let scope: ActionDescriptor['scope']
      let name: string
      if (path.startsWith(resourcePrefix)) {
        scope = 'resource'
        name = path.slice(resourcePrefix.length)
      } else if (path.startsWith(collectionPrefix)) {
        scope = 'collection'
        name = path.slice(collectionPrefix.length)
      } else {
        continue
      }
      // The action name is a single trailing segment.
      if (name.length === 0 || name.includes('/')) {
        continue
      }
      const post = item.post
      if (post === undefined) {
        continue
      }
      const input = actionInput(post)
      const action: ActionDescriptor = { scope, path, input, output: actionOutput(post) }
      // A raw-input action carries its declared (non-JSON:API) media type so the client sends
      // the right `Content-Type` rather than a wildcard the server may reject.
      if (input === 'raw') {
        const contentType = rawContentType(post)
        if (contentType !== undefined) {
          action.contentType = contentType
        }
      }
      out[name] = action
    }
    return sortRecord(out)
  }

  /** Resolve a relationship component's `data` into a {@link RelationDescriptor}. */
  private relationFromComponent(component: SchemaObject): RelationDescriptor | undefined {
    const data = component.properties?.['data']
    if (!isSchema(data)) {
      return undefined
    }

    // to-many: data.type === 'array'
    if (data.type === 'array') {
      const items = data.items
      if (items === undefined) {
        return undefined
      }
      if (typeof items.$ref === 'string') {
        // monomorphic to-many
        const type = this.resolveConst(items.$ref)
        return type === undefined ? undefined : { cardinality: 'many', types: [type], pivot: false }
      }
      if (Array.isArray(items.allOf)) {
        // pivot to-many: the $ref is the allOf entry that carries it
        const type = this.constFromAllOf(items.allOf)
        return type === undefined ? undefined : { cardinality: 'many', types: [type], pivot: true }
      }
      if (Array.isArray(items.anyOf)) {
        // polymorphic to-many
        return { cardinality: 'many', types: this.constsFromRefs(items.anyOf), pivot: false }
      }
      return undefined
    }

    // to-one: data.anyOf with the non-null entries being $refs (or pivot allOfs);
    // a polymorphic to-one nests its $refs one level deeper in another anyOf.
    if (Array.isArray(data.anyOf)) {
      const types: string[] = []
      let pivot = false
      for (const entry of data.anyOf) {
        if (typeof entry.$ref === 'string') {
          const type = this.resolveConst(entry.$ref)
          if (type !== undefined) {
            types.push(type)
          }
        } else if (Array.isArray(entry.allOf)) {
          const type = this.constFromAllOf(entry.allOf)
          if (type !== undefined) {
            types.push(type)
            pivot = true
          }
        } else if (Array.isArray(entry.anyOf)) {
          // polymorphic to-one: the non-null entry is itself an anyOf of $refs
          types.push(...this.constsFromRefs(entry.anyOf))
        }
      }
      return types.length === 0 ? undefined : { cardinality: 'one', types, pivot }
    }

    return undefined
  }

  /** Pull the related type from the `$ref` entry of an `allOf` (the pivot shape). */
  private constFromAllOf(allOf: readonly SchemaObject[]): string | undefined {
    for (const entry of allOf) {
      if (typeof entry.$ref === 'string') {
        const type = this.resolveConst(entry.$ref)
        if (type !== undefined) {
          return type
        }
      }
    }
    return undefined
  }

  /** Resolve every `$ref` entry in a list to its wire type. */
  private constsFromRefs(entries: readonly SchemaObject[]): string[] {
    const types: string[] = []
    for (const entry of entries) {
      if (typeof entry.$ref === 'string') {
        const type = this.resolveConst(entry.$ref)
        if (type !== undefined) {
          types.push(type)
        }
      }
    }
    return types
  }

  private clientId(base: string): ClientIdPolicy {
    const create = this.schemas[`${base}CreateRequest`]
    const data = isSchema(create?.properties?.['data']) ? create.properties['data'] : undefined
    if (data === undefined) {
      return 'forbidden'
    }
    if (data.properties?.['id'] === false) {
      return 'forbidden'
    }
    return data.required?.includes('id') ? 'required' : 'optional'
  }

  /**
   * Find the collection path for a type, then derive each per-operation path that
   * actually exists. The collection path P is the one whose POST requestBody refs
   * `<Base>CreateRequest`, else the GET whose 200 response refs `<Base>Collection`.
   */
  private operationPaths(base: string): Record<string, string> {
    const collection = this.collectionPath(base)
    const out: Record<string, string> = {}
    if (collection === undefined) {
      return out
    }

    if (this.operation(collection, 'get')) {
      out['fetchMany'] = collection
    }
    if (this.operation(collection, 'post')) {
      out['create'] = collection
    }

    const item = `${collection}/{id}`
    if (this.operation(item, 'get')) {
      out['fetchOne'] = item
    }
    if (this.operation(item, 'patch')) {
      out['update'] = item
    }
    if (this.operation(item, 'delete')) {
      out['delete'] = item
    }

    if (this.hasRelatedPath(collection)) {
      out['fetchRelated'] = `${collection}/{id}/{rel}`
    }
    if (this.hasRelationshipPath(collection)) {
      out['fetchRelationship'] = `${collection}/{id}/relationships/{rel}`
    }

    return sortRecord(out)
  }

  private collectionPath(base: string): string | undefined {
    let byCollection: string | undefined
    for (const [path, item] of Object.entries(this.paths)) {
      const post = item.post
      if (post && refEndsWith(this.requestBodyRef(post), `${base}CreateRequest`)) {
        return path
      }
      // Only a genuine top-level collection qualifies for the response-ref fallback —
      // a parent-scoped *related* collection (e.g. `/users/{id}/playlists`) also refs
      // `<Base>Collection` but is not a fetchMany endpoint for that type.
      if (
        byCollection === undefined &&
        !path.includes('/{id}/') &&
        refEndsWith(this.okResponseRef(item.get), `${base}Collection`)
      ) {
        byCollection = path
      }
    }
    return byCollection
  }

  /** Any `P/{id}/<rel>` related path (excludes relationships/ and custom `-actions`). */
  private hasRelatedPath(collection: string): boolean {
    const prefix = `${collection}/{id}/`
    return Object.keys(this.paths).some((path) => {
      if (!path.startsWith(prefix)) {
        return false
      }
      const rest = path.slice(prefix.length)
      return rest.length > 0 && !rest.includes('/') && !rest.startsWith('-')
    })
  }

  private hasRelationshipPath(collection: string): boolean {
    const prefix = `${collection}/{id}/relationships/`
    return Object.keys(this.paths).some(
      (path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
    )
  }

  /** Detect the paginator kind from the fetchMany operation's query parameter names. */
  private paginator(base: string): PaginatorKind {
    const collection = this.collectionPath(base)
    const names = collection
      ? this.queryParamNames(this.operation(collection, 'get'))
      : new Set<string>()
    if (names.has('page[number]') && names.has('page[size]')) {
      return 'page'
    }
    if (names.has('page[offset]') && names.has('page[limit]')) {
      return 'offset'
    }
    if (names.has('page[cursor]')) {
      return 'cursor'
    }
    return 'none'
  }

  private queryParamNames(op: OperationObject | undefined): Set<string> {
    const names = new Set<string>()
    for (const param of op?.parameters ?? []) {
      if (typeof param.name === 'string') {
        names.add(param.name)
      }
    }
    return names
  }

  private operation(path: string, method: HttpMethod): OperationObject | undefined {
    return this.paths[path]?.[method]
  }

  private requestBodyRef(op: OperationObject | undefined): string | undefined {
    return op?.requestBody?.content?.['application/vnd.api+json']?.schema?.$ref
  }

  private okResponseRef(op: OperationObject | undefined): string | undefined {
    return op?.responses?.['200']?.content?.['application/vnd.api+json']?.schema?.$ref
  }
}

/** A schema's wire format hint: explicit `format`, else the JSON type, else a ref-enum is `string`. */
function formatHint(schema: SchemaObject): string {
  if (typeof schema.format === 'string') {
    return schema.format
  }
  const types = typeKeys(schema.type)
  if (types.length > 0) {
    return types[0]!
  }
  // A $ref (typically an enum component) renders as a string union.
  if (typeof schema.$ref === 'string') {
    return 'string'
  }
  return 'unknown'
}

function refEndsWith(ref: string | undefined, suffix: string): boolean {
  return ref !== undefined && refName(ref) === suffix
}

/**
 * True for the Atomic Operations ext media type — `application/vnd.api+json` carrying the
 * atomic `ext` parameter ({@link ATOMIC_EXT}). Tolerant of quoting/whitespace so any of
 * `ext="…"` / `ext=…` matches.
 */
function isAtomicMediaType(mediaType: string): boolean {
  return mediaType.startsWith(JSON_API_MEDIA_TYPE) && mediaType.includes(ATOMIC_EXT)
}

/** The body shape a custom action's `POST` accepts: a JSON:API document, none, or a raw payload. */
function actionInput(op: OperationObject): ActionDescriptor['input'] {
  const content = op.requestBody?.content
  if (content === undefined || Object.keys(content).length === 0) {
    return 'none'
  }
  return JSON_API_MEDIA_TYPE in content ? 'document' : 'raw'
}

/** The declared media type of a `raw`-input action — the first non-JSON:API content type. */
function rawContentType(op: OperationObject): string | undefined {
  const content = op.requestBody?.content
  if (content === undefined) {
    return undefined
  }
  return Object.keys(content).find((mediaType) => mediaType !== JSON_API_MEDIA_TYPE)
}

/** What a custom action returns: a JSON:API `document` (a 2xx carries one) or `none` (only `204`). */
function actionOutput(op: OperationObject): ActionDescriptor['output'] {
  for (const [code, response] of Object.entries(op.responses ?? {})) {
    if (!code.startsWith('2')) {
      continue
    }
    const schema = response.content?.[JSON_API_MEDIA_TYPE]?.schema
    if (schema !== undefined) {
      return 'document'
    }
  }
  return 'none'
}

/** Build the {@link ApiDescriptor} from a parsed OpenAPI document. */
export function buildDescriptor(doc: OpenApiDocument): ApiDescriptor {
  return new DescriptorBuilder(doc).build()
}

/** Detect the server-level Atomic Operations capability (`null` when none). */
export function buildAtomic(doc: OpenApiDocument): AtomicDescriptor | null {
  return new DescriptorBuilder(doc).buildAtomic()
}
