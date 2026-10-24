import type {
  ActionDescriptor,
  ApiDescriptor,
  AtomicDescriptor,
  Cardinality,
  ClientIdPolicy,
  CountableDescriptor,
  MenuDescriptor,
  PaginatorDescriptor,
  PaginatorKind,
  PaginatorRole,
  PaginatorStrategy,
  PivotDescriptor,
  RelationDescriptor,
  RelationMutations,
  ResourceDescriptor,
} from '@haddowg/json-api-client'
import { ATOMIC_EXT, CANONICAL_PAGE_KEYS } from '@haddowg/json-api-client'
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

/** The operationId prefixes of a relation's related read and its relationship endpoint. */
const RELATED_OPERATION = 'fetchRelated'
const RELATIONSHIP_OPERATIONS = [
  'fetchRelationship',
  'updateRelationship',
  'addRelationship',
  'removeRelationship',
] as const

/** Where a relation's endpoints live, read from their operationIds. */
interface RelationEndpoints {
  related?: string
  relationship?: string
  /** The `$ref` of a relationship mutation's request body (its request pivot shape). */
  requestRef?: string
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
  /** Lazily-built wire-type -> collection-level paginator kind (for per-relation divergence, D6a). */
  private typePaginators?: Map<string, PaginatorDescriptor>

  constructor(private readonly doc: OpenApiDocument) {
    this.schemas = doc.components?.schemas ?? {}
    this.paths = doc.paths ?? {}
  }

  /**
   * The collection-level paginator kind for a WIRE type (`tracks`), memoised. Resolves each
   * resource schema's wire type (its `type.const`) to the paginator of its collection GET — the
   * baseline a per-relation related-endpoint paginator is compared against (D6a).
   */
  private typePaginator(wireType: string): PaginatorDescriptor {
    if (this.typePaginators === undefined) {
      this.typePaginators = new Map()
      for (const [name, schema] of Object.entries(this.schemas)) {
        const type = this.resourceType(name, schema)
        if (type !== undefined) {
          this.typePaginators.set(type, this.paginator(name.slice(0, -'Resource'.length)))
        }
      }
    }
    return this.typePaginators.get(wireType) ?? 'none'
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
        relations: this.relations(wireType, base, schema, collection),
        paths: this.operationPaths(base),
        paginator: this.paginator(base),
        clientId: this.clientId(base),
      }
      const countable = this.countable(collection)
      if (countable !== undefined) {
        descriptor.countable = countable
      }
      const includable = this.includable(collection)
      if (includable !== undefined) {
        descriptor.includable = includable
      }
      const sortable = this.sortable(collection)
      if (sortable !== undefined) {
        descriptor.sortable = sortable
      }
      const filterable = this.filterable(collection)
      if (filterable !== undefined) {
        descriptor.filterable = filterable
      }
      if (Object.keys(actions).length > 0) {
        descriptor.actions = actions
      }
      // A synthetic stub for an unregistered related type — core's `permissiveResourceObject`
      // emits a `<Rel>Resource` carrying ONLY a `type` const (no `id`/`attributes`) so linkage
      // refs resolve — is reachable only through a parent's `.related()` (which works via the
      // parent's own paths). Admitting it would surface a fully-typed top-level `client.<stub>`
      // whose every method throws, so drop it (D27). A REAL registered resource carries the full
      // `type/id/attributes/…` object shape and stays, even with no attributes/collection of its
      // own; only the type-const-only stub (with no operation paths) is dropped.
      const isTypeOnlyStub = Object.keys(schema.properties ?? {}).every((prop) => prop === 'type')
      if (isTypeOnlyStub && Object.keys(descriptor.paths).length === 0) {
        continue
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

  /**
   * The relations of a type: every relation its resource renders, plus each write-only relation
   * the create and update bodies accept. A write-only relation is one whose body property carries
   * `writeOnly: true` (generator contract 8) or, in an older document, one the resource doesn't
   * render. A pivot relation reads its response pivot off the rendered relationship and its
   * request pivot off the write bodies.
   */
  private relations(
    wireType: string,
    base: string,
    resource: SchemaObject,
    collection: string | undefined,
  ): Record<string, RelationDescriptor> {
    const relProps = isSchema(resource.properties?.['relationships'])
      ? (resource.properties['relationships'].properties ?? {})
      : {}
    const writes = this.writeRelationships(base)
    const endpoints = this.relationEndpoints(wireType)
    const out: Record<string, RelationDescriptor> = {}
    const add = (name: string, component: SchemaObject | undefined, writeOnly: boolean): void => {
      const parsed = component ? this.relationFromComponent(component) : undefined
      if (parsed === undefined) {
        // A relationship component the codegen can't parse (an unknown linkage shape) is
        // dropped silently otherwise — a drift class (the grammar has grown pivot/polymorphic/
        // nested forms), so warn rather than emit a client missing the relation (D28).
        // eslint-disable-next-line no-console
        console.warn(
          `json-api codegen: relationship "${name}" has an unrecognized linkage shape; dropping it from the descriptor.`,
        )
        return
      }
      const descriptor: RelationDescriptor = { ...parsed }
      if (writeOnly) {
        delete descriptor.readPivot
        descriptor.writeOnly = true
      }
      if (descriptor.pivot === true) {
        const writePivot = this.writePivot(
          writes.get(name)?.ref ?? endpoints.get(name)?.requestRef,
          component!,
        )
        if (writePivot !== undefined) {
          descriptor.writePivot = writePivot
        }
      }
      out[name] =
        collection === undefined
          ? descriptor
          : this.withRelationExposure(descriptor, collection, name, endpoints.get(name))
    }

    for (const [name, prop] of Object.entries(relProps)) {
      if (!isSchema(prop) || typeof prop.$ref !== 'string' || writes.get(name)?.writeOnly) {
        continue
      }
      add(name, this.schemas[refName(prop.$ref) ?? ''], false)
    }
    for (const [name, write] of writes) {
      if (write.writeOnly || !(name in relProps)) {
        add(name, this.schemas[refName(write.ref) ?? ''], true)
      }
    }
    return sortRecord(out)
  }

  /**
   * The relationships the create and update bodies accept: each one's component `$ref` and
   * whether the body marks it `writeOnly`.
   */
  private writeRelationships(base: string): Map<string, { ref: string; writeOnly: boolean }> {
    const out = new Map<string, { ref: string; writeOnly: boolean }>()
    for (const request of [`${base}CreateRequest`, `${base}UpdateRequest`]) {
      const data = this.schemas[request]?.properties?.['data']
      const relationships = isSchema(data) ? data.properties?.['relationships'] : undefined
      const props = isSchema(relationships) ? (relationships.properties ?? {}) : {}
      for (const [name, prop] of Object.entries(props)) {
        if (!isSchema(prop) || typeof prop.$ref !== 'string') {
          continue
        }
        const writeOnly = prop['writeOnly'] === true || out.get(name)?.writeOnly === true
        out.set(name, { ref: out.get(name)?.ref ?? prop.$ref, writeOnly })
      }
    }
    return out
  }

  /**
   * Each relation's related and relationship paths, keyed by relation name, from the
   * operationIds the projector stamps (`fetchRelated.<type>.<relation>`, …). A relation's path
   * segment is its URI field name, which may differ from its name, so the paths are never
   * derived from the name when an operationId names them.
   */
  private relationEndpoints(wireType: string): Map<string, RelationEndpoints> {
    const out = new Map<string, RelationEndpoints>()
    const entry = (rel: string): RelationEndpoints => {
      let found = out.get(rel)
      if (found === undefined) {
        found = {}
        out.set(rel, found)
      }
      return found
    }
    for (const [path, item] of Object.entries(this.paths)) {
      for (const [method, op] of Object.entries(item) as [HttpMethod, OperationObject][]) {
        const id = op?.operationId
        if (typeof id !== 'string') {
          continue
        }
        const dot = id.indexOf('.')
        const prefix = id.slice(0, dot)
        const rest = id.slice(dot + 1)
        if (dot < 0 || !rest.startsWith(`${wireType}.`)) {
          continue
        }
        const rel = rest.slice(wireType.length + 1)
        if (prefix === RELATED_OPERATION) {
          entry(rel).related = path
        } else if ((RELATIONSHIP_OPERATIONS as readonly string[]).includes(prefix)) {
          const found = entry(rel)
          found.relationship = path
          const ref = method === 'get' ? undefined : this.requestBodyRef(op)
          if (ref !== undefined) {
            found.requestRef = ref
          }
        }
      }
    }
    return out
  }

  /**
   * The per-relation mutation capability, derived from the HTTP methods the relationship
   * endpoint (`{collection}/{id}/relationships/{rel}`) advertises. For a to-many:
   * `add` <- POST, `remove` <- DELETE, `replace` <- PATCH. For a to-one: `set` <- PATCH.
   * Only `true` verbs are emitted (a missing verb is simply absent). Returns `undefined`
   * when the relation exposes no relationship endpoint at all.
   */
  private relationMutations(
    path: string,
    cardinality: RelationDescriptor['cardinality'],
  ): RelationMutations | undefined {
    const item = this.paths[path]
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
   * Attach the per-relation endpoint-exposure signal to a relation descriptor (D24). The bundle
   * can suppress a relation's related or relationship endpoint (`withoutRelatedEndpoint()` /
   * `withoutRelationshipEndpoint()`, ADR 0027), which the OpenAPI reflects by simply omitting that
   * relation's path — but codegen synthesizes generic `{rel}` templates, erasing the per-relation
   * distinction. So mark `related: false` / `relationship: false` when this relation's specific
   * path is absent, and ALWAYS emit an explicit `mutations` object (the verb flags when the
   * relationship endpoint exists, else `{}`) so the client gates a suppressed relation OFF rather
   * than failing open (offering `.get()`/`.related()`/mutations that 404).
   */
  private withRelationExposure(
    descriptor: RelationDescriptor,
    collection: string,
    name: string,
    endpoints: RelationEndpoints | undefined,
  ): RelationDescriptor {
    const out: RelationDescriptor = { ...descriptor }
    const relatedPath = endpoints?.related ?? `${collection}/{id}/${name}`
    const relationshipPath = endpoints?.relationship ?? `${collection}/{id}/relationships/${name}`
    // The client fills `{rel}` with this segment, so a relation served under its URI field name
    // (`/articles/{id}/published-by` for `publisher`) is reached at its real path.
    const segment = (endpoints?.related ?? endpoints?.relationship)?.split('/').pop()
    if (segment !== undefined && segment !== name) {
      out.uriField = segment
    }
    const relatedGet = this.operation(relatedPath, 'get')
    if (relatedGet === undefined) {
      out.related = false
    }
    const mutations = this.relationMutations(relationshipPath, descriptor.cardinality)
    if (mutations === undefined) {
      out.relationship = false
      out.mutations = {}
    } else {
      out.mutations = mutations
    }
    // The related/relationship reads may advertise their own `withCount` (`_self_` + the relation's
    // countable relations) with a negotiation profile — capture it so a typed `.related()`/`.get()`
    // can send `withCount` and negotiate the profile the endpoint requires (D3).
    const countable =
      withCountParam(relatedGet) ?? withCountParam(this.operation(relationshipPath, 'get'))
    if (countable !== undefined) {
      out.countable = countable
    }
    // A to-many related endpoint can advertise a DIFFERENT paginator than the related type's
    // top-level collection (D6a). Read the related-endpoint kind (preferring the related over the
    // relationship endpoint) and carry it ONLY when it diverges from the related type's collection
    // paginator — the client falls back to that type's paginator otherwise, so parity stays silent.
    if (descriptor.cardinality === 'many') {
      const relatedPaginator =
        this.paginatorOf(relatedGet) === 'none'
          ? this.paginatorOf(this.operation(relationshipPath, 'get'))
          : this.paginatorOf(relatedGet)
      const relatedType = descriptor.types[0]
      const typePaginator = relatedType !== undefined ? this.typePaginator(relatedType) : 'none'
      if (
        relatedPaginator !== 'none' &&
        JSON.stringify(relatedPaginator) !== JSON.stringify(typePaginator)
      ) {
        out.paginator = relatedPaginator
      }
    }
    return out
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
      // An action is invoked over one HTTP method; the bundle lets an author declare a
      // non-POST method, so read the advertised operation (POST-preferred) rather than only
      // `post` — else a GET/PATCH/DELETE-only action would silently vanish from the client.
      const picked = pickOperation(item)
      if (picked === undefined) {
        // eslint-disable-next-line no-console
        console.warn(
          `json-api codegen: custom action path "${path}" advertises no usable operation; skipping.`,
        )
        continue
      }
      const { method, op } = picked
      const input = actionInput(op)
      const output = actionOutput(op)
      const action: ActionDescriptor = { scope, path, input, output }
      // Only carried when non-POST (POST is the runtime default), keeping the common descriptor tiny.
      if (method !== 'post') {
        action.method = method.toUpperCase()
      }
      // A document input names its resource type so the client can accept FLAT input and build the
      // envelope (+ remap 422 pointers), matching `create`/`update` ergonomics.
      if (input === 'document') {
        const inputType = this.documentPrimary(actionRequestRef(op))?.type
        if (inputType !== undefined) {
          action.inputType = inputType
        }
      }
      // A document output names its primary resource type + cardinality so the client materialises
      // the response into that resource view (matching reads), not the raw wire envelope.
      if (output === 'document') {
        const primary = this.documentPrimary(this.firstOkJsonApiRef(op))
        if (primary !== undefined) {
          action.outputType = primary.type
          action.outputCardinality = primary.cardinality
        }
      }
      // A raw-input action carries its declared (non-JSON:API) media type so the client sends
      // the right `Content-Type` rather than a wildcard the server may reject.
      if (input === 'raw') {
        const contentType = rawContentType(op)
        if (contentType !== undefined) {
          action.contentType = contentType
        }
      }
      out[name] = action
    }
    return sortRecord(out)
  }

  /**
   * The wire type (and cardinality) of a document component's primary `data` — a `$ref` to a
   * resource, an inline object carrying `properties.type.const` (a create-request body), or an
   * array of resource/identifier refs (a collection). `undefined` when the type can't be resolved.
   */
  private documentPrimary(
    ref: string | undefined,
  ): { type: string; cardinality: Cardinality } | undefined {
    if (typeof ref !== 'string') {
      return undefined
    }
    const component = refName(ref)
    const data = component === undefined ? undefined : this.schemas[component]?.properties?.['data']
    if (!isSchema(data)) {
      return undefined
    }
    if (isSchema(data.items)) {
      const itemRef = data.items.$ref
      const many = typeof itemRef === 'string' ? this.resolveConst(itemRef) : undefined
      return many === undefined ? undefined : { type: many, cardinality: 'many' }
    }
    const one = this.dataConst(data)
    return one === undefined ? undefined : { type: one, cardinality: 'one' }
  }

  /** The wire type of a single `data` schema — a `$ref` to a resource, or an inline `type.const`. */
  private dataConst(data: SchemaObject): string | undefined {
    if (typeof data.$ref === 'string') {
      return this.resolveConst(data.$ref)
    }
    const typeProp = data.properties?.['type']
    return isSchema(typeProp) && typeof typeProp.const === 'string' ? typeProp.const : undefined
  }

  /** The `$ref` of the first 2xx JSON:API response body on an operation (the output document). */
  private firstOkJsonApiRef(op: OperationObject): string | undefined {
    for (const [code, response] of Object.entries(op.responses ?? {})) {
      if (!code.startsWith('2')) {
        continue
      }
      const ref = response.content?.[JSON_API_MEDIA_TYPE]?.schema?.$ref
      if (typeof ref === 'string') {
        return ref
      }
    }
    return undefined
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
        if (type === undefined) {
          return undefined
        }
        const relation: RelationDescriptor = { cardinality: 'many', types: [type], pivot: true }
        const readPivot = this.pivotDescriptor(pivotNodeFromAllOf(items.allOf), 'read')
        if (readPivot !== undefined) {
          relation.readPivot = readPivot
        }
        return relation
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
      let readPivot: PivotDescriptor | undefined
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
            readPivot = this.pivotDescriptor(pivotNodeFromAllOf(entry.allOf), 'read')
          }
        } else if (Array.isArray(entry.anyOf)) {
          // polymorphic to-one: the non-null entry is itself an anyOf of $refs
          types.push(...this.constsFromRefs(entry.anyOf))
        }
      }
      if (types.length === 0) {
        return undefined
      }
      const relation: RelationDescriptor = { cardinality: 'one', types, pivot }
      if (readPivot !== undefined) {
        relation.readPivot = readPivot
      }
      return relation
    }

    return undefined
  }

  /**
   * The request pivot of a pivot relation: read off the component a write body (or a
   * relationship mutation) refs, falling back to the rendered relationship's pivot minus its
   * `readOnly` fields when no request shape is published (before generator contract 8).
   */
  private writePivot(ref: string | undefined, fallback: SchemaObject): PivotDescriptor | undefined {
    const component = ref === undefined ? undefined : this.schemas[refName(ref) ?? '']
    return this.pivotDescriptor(
      pivotNodeOf(component ?? fallback) ?? pivotNodeOf(fallback),
      'write',
    )
  }

  /**
   * A {@link PivotDescriptor} from a member's `meta.pivot` schema: field hints, the required
   * fields and the nullable ones. Generator contract 8 refs a `<Type><Rel>Pivot` (response) or
   * `<Type><Rel>WritePivot` (request) component, each with its own `required`. An older document
   * inlines one shared schema in the write context, so a read takes every field as rendered and a
   * write drops the `readOnly` ones. `undefined` when the schema has no fields.
   */
  private pivotDescriptor(
    node: SchemaObject | undefined,
    side: 'read' | 'write',
  ): PivotDescriptor | undefined {
    if (node === undefined) {
      return undefined
    }
    const shared = typeof node.$ref !== 'string'
    const schema = shared ? node : this.schemas[refName(node.$ref as string) ?? '']
    const fields: Record<string, string> = {}
    const nullable: string[] = []
    for (const [name, prop] of Object.entries(schema?.properties ?? {})) {
      if (!isSchema(prop) || prop[side === 'read' ? 'writeOnly' : 'readOnly'] === true) {
        continue
      }
      fields[name] = formatHint(prop)
      if (isNullable(prop)) {
        nullable.push(name)
      }
    }
    const names = Object.keys(fields)
    if (names.length === 0) {
      return undefined
    }
    const required =
      shared && side === 'read' ? names : names.filter((name) => schema?.required?.includes(name))
    const out: PivotDescriptor = { fields: sortRecord(fields) }
    if (required.length < names.length) {
      // oxlint-disable-next-line no-array-sort -- sorting a freshly-created array
      out.required = required.sort()
    }
    if (nullable.length > 0) {
      // oxlint-disable-next-line no-array-sort -- sorting a freshly-created array
      out.nullable = nullable.sort()
    }
    return out
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

  /** Detect the paginator from the fetchMany operation's page parameters. */
  private paginator(base: string): PaginatorDescriptor {
    const collection = this.collectionPath(base)
    return this.paginatorOf(this.operation(collection ?? '', 'get'), collection)
  }

  /**
   * Detect the paginator an operation advertises. A page schema stamped with `x-paginator`
   * (contract 3) names its strategy and the wire key for each role, so it decides both. Without
   * the stamp, the strategy is inferred from canonical member names (see {@link kindOfMembers}).
   * Anything unrecognised warns and generates as unpaginated. `label` (a path) names the endpoint
   * in the warning; without it nothing is logged.
   */
  private paginatorOf(op: OperationObject | undefined, label?: string): PaginatorDescriptor {
    const warn = (problem: string): 'none' => {
      if (label !== undefined) {
        // eslint-disable-next-line no-console
        console.warn(
          `json-api codegen: endpoint "${label}" ${problem}; treating it as unpaginated.`,
        )
      }
      return 'none'
    }

    const schema = op?.parameters?.find((param) => param.name === 'page')?.schema
    if (schema?.['x-paginator'] !== undefined) {
      return stampedPaginator(schema, warn)
    }

    const { members, menu } = this.pageMembers(op)
    if (menu === undefined) {
      const kind = kindOfMembers(members)
      if (kind !== undefined) {
        return kind
      }
    }
    // A page parameter matching no single known kind is a drift the client would silently treat
    // as unpaginated; warn rather than swallow it (D28).
    if (menu !== undefined) {
      return warn(
        `advertises a selectable page strategy menu (${menu
          .map((arm) => kindOfMembers(arm) ?? sortedList(arm))
          .join(' | ')}) without an x-paginator stamp naming its default`,
      )
    }
    return members.size > 0
      ? warn(
          `advertises page parameters matching no known paginator kind (members ${sortedList(members)})`,
        )
      : 'none'
  }

  /**
   * The `page` members an operation accepts, from either wire form: one `page` parameter
   * (`style: deepObject`) whose schema `properties` name the members, as `haddowg/json-api` v1
   * projects it, or the older flattened `page[number]`/`page[size]` parameters. A `oneOf` page
   * schema (a MultiPaginator menu) yields each arm's members in `menu` instead, minus the
   * `kind` discriminator.
   */
  private pageMembers(op: OperationObject | undefined): {
    members: Set<string>
    menu?: Set<string>[]
  } {
    const members = new Set<string>()
    let menu: Set<string>[] | undefined
    for (const param of op?.parameters ?? []) {
      const name = param.name
      if (name === 'page') {
        const arms = param.schema?.oneOf
        if (arms !== undefined) {
          menu = arms.map(
            (arm) => new Set(Object.keys(arm.properties ?? {}).filter((m) => m !== 'kind')),
          )
        }
        for (const member of Object.keys(param.schema?.properties ?? {})) {
          members.add(member)
        }
      } else if (name?.startsWith('page[') === true && name.endsWith(']')) {
        members.add(name.slice('page['.length, -1))
      }
    }
    return menu === undefined ? { members } : { members, menu }
  }

  /**
   * The `withCount` capability (Countable profile) for a type's COLLECTION read (`list`): the
   * count tokens (`schema.items.enum`) + the negotiation profile (`x-profile`) carried by the
   * collection GET's `withCount` query parameter. Returns `undefined` when the collection
   * doesn't exist or advertises no `withCount`. The profile URI is never hardcoded — it is read
   * from the parameter's `x-profile`.
   *
   * Deliberately scoped to the collection GET only. The per-endpoint token sets differ
   * (a collection counts e.g. `tracks`; a related/relationship endpoint counts `_self_` and its
   * own relations), so a single per-type `countable` can only honestly describe one endpoint.
   * The fluent surface exposes `withCount` on `list` (the collection), so `countable` mirrors
   * that endpoint — a related-GET fallback would advertise tokens `list` cannot legally send.
   */
  private countable(collection: string | undefined): CountableDescriptor | undefined {
    if (collection === undefined) {
      return undefined
    }
    return withCountParam(this.operation(collection, 'get'))
  }

  /**
   * The relation paths the read endpoints accept in `include` — the `include` query
   * parameter's `schema.items.enum` (already including nested dotted paths) on the collection
   * GET. Returns `undefined` when the collection advertises no `include` (nothing includable).
   *
   * Read from the collection GET to mirror {@see sortable}/{@see filterable}: the whole builder
   * is collection-centric (a type with no collection path gets no `paths` at all), and the bundle
   * advertises the same `include` enum on the collection and single-resource GETs.
   */
  private includable(collection: string | undefined): readonly string[] | undefined {
    if (collection === undefined) {
      return undefined
    }
    const tokens = paramItemsEnum(this.operation(collection, 'get'), 'include')
    return tokens !== undefined && tokens.length > 0 ? tokens : undefined
  }

  /**
   * The sort tokens the COLLECTION read accepts — the `sort` query parameter's
   * `schema.items.enum` (signed field names) on the collection GET. Returns `undefined` when
   * the collection advertises no `sort` parameter (sorting unsupported).
   */
  private sortable(collection: string | undefined): readonly string[] | undefined {
    if (collection === undefined) {
      return undefined
    }
    const tokens = paramItemsEnum(this.operation(collection, 'get'), 'sort')
    return tokens !== undefined && tokens.length > 0 ? tokens : undefined
  }

  /**
   * The filter keys the COLLECTION read accepts in `filter[...]` (the `filter[<key>]` parameter
   * names, `<key>` extracted), sorted for deterministic output. Returns `undefined` when the
   * collection advertises no `filter[...]` parameters (filtering unsupported). Value shapes are
   * deliberately not captured — `filter` values stay `unknown` (out of scope for v0.1).
   */
  private filterable(collection: string | undefined): readonly string[] | undefined {
    if (collection === undefined) {
      return undefined
    }
    const keys: string[] = []
    for (const param of this.operation(collection, 'get')?.parameters ?? []) {
      const name = param.name
      if (typeof name === 'string' && name.startsWith('filter[') && name.endsWith(']')) {
        keys.push(name.slice('filter['.length, -1))
      }
    }
    // oxlint-disable-next-line no-array-sort -- sorting a freshly-created key array
    return keys.length > 0 ? keys.sort() : undefined
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

/** The `meta.pivot` schema node of a pivot `allOf` entry list, if any. */
function pivotNodeFromAllOf(allOf: readonly SchemaObject[]): SchemaObject | undefined {
  for (const entry of allOf) {
    const meta = entry.properties?.['meta']
    const pivot = isSchema(meta) ? meta.properties?.['pivot'] : undefined
    if (isSchema(pivot)) {
      return pivot
    }
  }
  return undefined
}

/**
 * The `meta.pivot` schema node of a relationship component or document: its to-many `items`
 * `allOf`, or a to-one `anyOf` entry's `allOf`.
 */
function pivotNodeOf(component: SchemaObject): SchemaObject | undefined {
  const data = component.properties?.['data']
  if (!isSchema(data)) {
    return undefined
  }
  if (Array.isArray(data.items?.allOf)) {
    return pivotNodeFromAllOf(data.items.allOf)
  }
  for (const entry of data.anyOf ?? []) {
    if (Array.isArray(entry.allOf)) {
      return pivotNodeFromAllOf(entry.allOf)
    }
  }
  return undefined
}

/** Whether a schema admits `null`: a `null` type, or a `null` branch in `anyOf`/`oneOf`. */
function isNullable(schema: SchemaObject): boolean {
  const type = schema.type
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) {
    return true
  }
  return [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].some((branch) => branch.type === 'null')
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
  // A nullable `$ref` is `anyOf: [{ $ref }, { type: 'null' }]`: hint the value branch.
  const isNullOnly = (branch: SchemaObject): boolean =>
    branch.type !== undefined && typeKeys(branch.type).length === 0
  const branches = (schema.anyOf ?? schema.oneOf ?? []).filter((branch) => !isNullOnly(branch))
  if (branches.length === 1) {
    return formatHint(branches[0]!)
  }
  return 'unknown'
}

function refEndsWith(ref: string | undefined, suffix: string): boolean {
  return ref !== undefined && refName(ref) === suffix
}

/**
 * Read the {@link CountableDescriptor} off an operation's `withCount` query parameter: the
 * count tokens from its `schema.items.enum` and the negotiation profile from `x-profile`.
 * Returns `undefined` when the operation has no `withCount` parameter, or when one is present
 * but carries no `x-profile` (a `withCount` we can't tell a client how to negotiate). An empty
 * or absent token enum yields `[]` tokens (the profile alone is still actionable).
 */
function withCountParam(op: OperationObject | undefined): CountableDescriptor | undefined {
  for (const param of op?.parameters ?? []) {
    if (param.name !== 'withCount') {
      continue
    }
    const profile = param['x-profile']
    if (typeof profile !== 'string') {
      return undefined
    }
    const enumValues = param.schema?.items?.enum
    const tokens = Array.isArray(enumValues)
      ? enumValues.filter((v): v is string => typeof v === 'string')
      : []
    return { tokens, profile }
  }
  return undefined
}

/**
 * The string members of an array-valued query parameter's `schema.items.enum` (the shape the
 * `include` and `sort` parameters use). Returns `undefined` when the operation carries no
 * parameter of that name, or one whose schema declares no enum.
 */
function paramItemsEnum(
  op: OperationObject | undefined,
  paramName: string,
): readonly string[] | undefined {
  for (const param of op?.parameters ?? []) {
    if (param.name !== paramName) {
      continue
    }
    const enumValues = param.schema?.items?.enum
    return Array.isArray(enumValues)
      ? enumValues.filter((v): v is string => typeof v === 'string')
      : undefined
  }
  return undefined
}

/**
 * True for the Atomic Operations ext media type — `application/vnd.api+json` carrying the
 * atomic `ext` parameter ({@link ATOMIC_EXT}). Tolerant of quoting/whitespace so any of
 * `ext="…"` / `ext=…` matches.
 */
function isAtomicMediaType(mediaType: string): boolean {
  return mediaType.startsWith(JSON_API_MEDIA_TYPE) && mediaType.includes(ATOMIC_EXT)
}

/** The HTTP methods an action operation may be advertised under, in resolution preference order. */
const ACTION_METHODS: readonly HttpMethod[] = ['post', 'get', 'put', 'patch', 'delete']

/**
 * The single operation an action is invoked over: POST when advertised (the common default), else
 * the first advertised method. `undefined` when the path item carries no operation at all.
 */
function pickOperation(
  item: PathItemObject,
): { method: HttpMethod; op: OperationObject } | undefined {
  const available = ACTION_METHODS.filter((method) => item[method] !== undefined)
  const method = available.includes('post') ? 'post' : available[0]
  if (method === undefined) {
    return undefined
  }
  const op = item[method]
  return op === undefined ? undefined : { method, op }
}

/** The body shape a custom action accepts: a JSON:API document, none, or a raw payload. */
function actionInput(op: OperationObject): ActionDescriptor['input'] {
  const content = op.requestBody?.content
  if (content === undefined || Object.keys(content).length === 0) {
    return 'none'
  }
  return JSON_API_MEDIA_TYPE in content ? 'document' : 'raw'
}

/** The `$ref` of an action's JSON:API request body (a `document` input), or `undefined`. */
function actionRequestRef(op: OperationObject): string | undefined {
  const ref = op.requestBody?.content?.[JSON_API_MEDIA_TYPE]?.schema?.$ref
  return typeof ref === 'string' ? ref : undefined
}

/** The declared media type of a `raw`-input action — the first non-JSON:API content type. */
function rawContentType(op: OperationObject): string | undefined {
  const content = op.requestBody?.content
  if (content === undefined) {
    return undefined
  }
  return Object.keys(content).find((mediaType) => mediaType !== JSON_API_MEDIA_TYPE)
}

/**
 * What a custom action returns from its first 2xx response: a `meta`-only document (a `$ref` to the
 * shared `MetaDocument` — no `data`), a resource `document` (any other JSON:API body), or `none`
 * (only a `204`).
 */
function actionOutput(op: OperationObject): ActionDescriptor['output'] {
  for (const [code, response] of Object.entries(op.responses ?? {})) {
    if (!code.startsWith('2')) {
      continue
    }
    const schema = response.content?.[JSON_API_MEDIA_TYPE]?.schema
    if (schema === undefined) {
      continue
    }
    return typeof schema.$ref === 'string' && refName(schema.$ref) === 'MetaDocument'
      ? 'meta'
      : 'document'
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

/**
 * Classify a page member set: `number`+`size` = `page`; `offset`+`limit` = `offset`; either
 * cursor bound (`after`/`before`) = `cursor` (link-driven, D44); `number` alone = `fixed` (the
 * server fixes the size); no members = `none`; anything else = `undefined` (unrecognised).
 */
function kindOfMembers(members: ReadonlySet<string>): PaginatorKind | undefined {
  if (members.has('number') && members.has('size')) {
    return 'page'
  }
  if (members.has('offset') && members.has('limit')) {
    return 'offset'
  }
  if (members.has('after') || members.has('before')) {
    return 'cursor'
  }
  if (members.size === 1 && members.has('number')) {
    return 'fixed'
  }
  return members.size === 0 ? 'none' : undefined
}

// oxlint-disable-next-line no-array-sort -- sorting a freshly-created array
const sortedList = (members: ReadonlySet<string>): string => [...members].sort().join(', ')

const STRATEGIES: readonly PaginatorStrategy[] = ['page', 'offset', 'cursor', 'fixed']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Read a page schema's `x-paginator` stamp. A strategy keeps the wire key the stamp names for
 * each of its roles (a missing role keeps its canonical name) and collapses to the bare kind when
 * every key is canonical. A `multi` stamp reads each `oneOf` arm by its `kind` const: an arm's own
 * stamp decides it, an unstamped arm falls back to name inference, and an arm neither recognises
 * is left out of the menu.
 */
function stampedPaginator(
  schema: SchemaObject,
  warn: (problem: string) => 'none',
): PaginatorDescriptor {
  const stamp = schema['x-paginator']
  const strategy = isRecord(stamp) ? stamp['strategy'] : undefined
  if (!isRecord(stamp) || typeof strategy !== 'string') {
    return warn('stamps a malformed x-paginator')
  }
  if (strategy === 'multi') {
    return stampedMenu(schema, stamp, warn)
  }
  if (!(STRATEGIES as readonly string[]).includes(strategy)) {
    return warn(`stamps an x-paginator strategy "${strategy}" this codegen does not know`)
  }
  const kind = strategy as PaginatorStrategy
  const canonical: Partial<Record<PaginatorRole, string>> = CANONICAL_PAGE_KEYS[kind]
  const stamped = isRecord(stamp['keys']) ? stamp['keys'] : {}
  const keys: Partial<Record<PaginatorRole, string>> = {}
  let renamed = false
  for (const [role, fallback] of Object.entries(canonical) as [PaginatorRole, string][]) {
    const key = typeof stamped[role] === 'string' ? stamped[role] : fallback
    keys[role] = key
    renamed ||= key !== fallback
  }
  return renamed ? { strategy: kind, keys } : kind
}

function stampedMenu(
  schema: SchemaObject,
  stamp: Record<string, unknown>,
  warn: (problem: string) => 'none',
): PaginatorDescriptor {
  const arms: Record<string, MenuDescriptor['arms'][string]> = {}
  for (const arm of schema.oneOf ?? []) {
    const discriminator = arm.properties?.['kind']
    const kind = isRecord(discriminator) ? discriminator['const'] : undefined
    if (typeof kind !== 'string') {
      warn('offers a page strategy menu arm without a kind const, which is left out')
      continue
    }
    const paginator =
      arm['x-paginator'] !== undefined
        ? stampedPaginator(arm, (problem) =>
            warn(`offers a menu arm "${kind}" that ${problem}, which is left out`),
          )
        : (kindOfMembers(new Set(Object.keys(arm.properties ?? {}).filter((m) => m !== 'kind'))) ??
          warn(`offers a menu arm "${kind}" matching no known paginator kind, which is left out`))
    if (typeof paginator === 'object' && paginator.strategy === 'multi') {
      warn(`nests a page strategy menu in arm "${kind}", which is left out`)
      continue
    }
    if (paginator !== 'none') {
      arms[kind] = paginator
    }
  }
  const fallback = stamp['default']
  if (typeof fallback !== 'string' || arms[fallback] === undefined) {
    return warn(
      `stamps a page strategy menu whose default ${typeof fallback === 'string' ? `"${fallback}"` : '(missing)'} is not one of its generated arms`,
    )
  }
  return { strategy: 'multi', default: fallback, arms }
}
