import type {
  AcceptedDescriptor,
  AcceptedOperation,
  AdditionalMembersDescriptor,
  ActionDescriptor,
  ApiDescriptor,
  AtomicDescriptor,
  Cardinality,
  ClientIdPolicy,
  CountableDescriptor,
  DocumentMetaDescriptor,
  DocumentMetaOperation,
  FilterFamilyDescriptor,
  InputMediaKind,
  MenuDescriptor,
  MetaLiteral,
  PaginatorDescriptor,
  PaginatorKind,
  PaginatorRole,
  PaginatorStrategy,
  PivotDescriptor,
  RawMediaKind,
  RequestMetaOperation,
  ResourceMetaDescriptor,
  RelatedQueryOperation,
  RawOutputMedia,
  RelationDescriptor,
  RelationMutations,
  ResourceCountOperation,
  ResourceDescriptor,
  SortFamilyDescriptor,
} from '@haddowg/json-api-client'
import { ATOMIC_EXT, CANONICAL_PAGE_KEYS, isPolymorphic } from '@haddowg/json-api-client'
import type {
  HttpMethod,
  OpenApiDocument,
  OperationObject,
  ParameterObject,
  PathItemObject,
  SchemaObject,
  SchemaOrBool,
  SecurityRequirement,
} from './openapi'
import { unwrapRefs } from './unwrap-refs'

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
  /** Lazily-built wire-type -> its resource schema's base name. */
  private typeBases?: Map<string, string>
  /** The names of the document's `oauth2` security schemes, under which operations list scopes. */
  private readonly scopeSchemes: ReadonlySet<string>
  /** The document's default security, which an operation without its own inherits. */
  private readonly defaultSecurity: readonly SecurityRequirement[]
  /** The shared parameters an operation's parameter `$ref` points at. */
  private readonly sharedParameters: Record<string, ParameterObject>
  /**
   * The `relatedQuery` each rendered type takes, collected from every operation that documents it
   * while {@link build} runs: the type's addressable relations and the profile to negotiate.
   */
  private readonly relatedQueries = new Map<string, { relations: string[]; profile: string }>()

  constructor(source: OpenApiDocument) {
    const doc = unwrapRefs(source)
    this.schemas = doc.components?.schemas ?? {}
    this.paths = doc.paths ?? {}
    this.scopeSchemes = new Set(
      Object.entries(doc.components?.securitySchemes ?? {})
        .filter(([, scheme]) => scheme?.type === 'oauth2')
        .map(([name]) => name),
    )
    this.defaultSecurity = doc.security ?? []
    this.sharedParameters = doc.components?.parameters ?? {}
  }

  /**
   * The OAuth scopes an operation needs (generator contract 16): those its `security` lists under
   * an `oauth2` scheme, in order and without repeats. `undefined` when it lists none.
   */
  private scopes(op: OperationObject | undefined): string[] | undefined {
    if (op === undefined || this.scopeSchemes.size === 0) {
      return undefined
    }
    const out = new Set<string>()
    for (const requirement of op.security ?? this.defaultSecurity) {
      for (const [scheme, scopes] of Object.entries(requirement)) {
        if (this.scopeSchemes.has(scheme) && Array.isArray(scopes)) {
          for (const scope of scopes) {
            out.add(scope)
          }
        }
      }
    }
    return out.size === 0 ? undefined : [...out]
  }

  /**
   * The scopes each of a type's CRUD, related and relationship operations needs, keyed by the
   * operationId without the type (`fetchOne`, `fetchRelated.author`). Operations needing none are
   * left out; actions carry their own.
   */
  private operationScopes(wireType: string): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const item of Object.values(this.paths)) {
      for (const op of Object.values(item) as (OperationObject | undefined)[]) {
        const id = op?.operationId
        if (typeof id !== 'string') {
          continue
        }
        const dot = id.indexOf('.')
        const prefix = id.slice(0, dot)
        const rest = id.slice(dot + 1)
        if (dot < 0 || prefix === 'action' || prefix === 'atomic') {
          continue
        }
        let key: string
        if (rest === wireType) {
          key = prefix
        } else if (rest.startsWith(`${wireType}.`)) {
          key = `${prefix}.${rest.slice(wireType.length + 1)}`
        } else {
          continue
        }
        const scopes = this.scopes(op)
        if (scopes !== undefined) {
          out[key] = scopes
        }
      }
    }
    return sortRecord(out)
  }

  /**
   * The collection-level paginator kind for a WIRE type (`tracks`), memoised. Resolves each
   * resource schema's wire type (its `type.const`) to the paginator of its collection GET — the
   * baseline a per-relation related-endpoint paginator is compared against (D6a).
   */
  private typePaginator(wireType: string): PaginatorDescriptor {
    if (this.typePaginators === undefined) {
      this.typePaginators = new Map()
      for (const [type, base] of this.bases()) {
        this.typePaginators.set(type, this.paginator(base))
      }
    }
    return this.typePaginators.get(wireType) ?? 'none'
  }

  /** Each wire type's resource schema base name (`Track` for `tracks`), memoised. */
  private bases(): Map<string, string> {
    if (this.typeBases === undefined) {
      this.typeBases = new Map()
      for (const [name, schema] of Object.entries(this.schemas)) {
        const type = this.resourceType(name, schema)
        if (type !== undefined) {
          this.typeBases.set(type, name.slice(0, -'Resource'.length))
        }
      }
    }
    return this.typeBases
  }

  /** The collection read of a wire type, or `undefined` when it has no collection endpoint. */
  private collectionRead(wireType: string): OperationObject | undefined {
    const base = this.bases().get(wireType)
    const collection = base === undefined ? undefined : this.collectionPath(base)
    return collection === undefined ? undefined : this.operation(collection, 'get')
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
      const item = this.itemPath(base)
      const actions = this.actions(collection, item)
      const descriptor: ResourceDescriptor = {
        attributes: this.attributes(base),
        relations: this.relations(wireType, base, schema, item),
        paths: this.operationPaths(base),
        paginator: this.paginator(base),
        clientId: this.clientId(base),
      }
      if (this.singletonPath(base) !== undefined) {
        descriptor.singleton = true
      }
      const countable = this.countable(collection)
      if (countable !== undefined) {
        descriptor.countable = countable
      }
      const resourceCountable = this.resourceCountable(collection, item)
      if (resourceCountable !== undefined) {
        descriptor.resourceCountable = resourceCountable
      }
      // Filled in once every operation has been read, since a type's related reads and actions
      // render other types. The key is set now to keep its place in the output.
      descriptor.relatedQuery = {
        operations: this.relatedQueryOperations(wireType, collection, item),
        profile: '',
      }
      // A singleton has no collection read, so its single read says what it includes.
      const includeRead =
        collection !== undefined
          ? this.operation(collection, 'get')
          : item !== undefined
            ? this.operation(item, 'get')
            : undefined
      const includable = this.includable(includeRead)
      if (includable !== undefined) {
        descriptor.includable = includable
      }
      const included = this.includedTypes(includeRead)
      if (included !== undefined) {
        descriptor.included = included
      }
      const fieldsets = this.nestedFieldsets(wireType)
      if (fieldsets !== undefined) {
        descriptor.nestedFieldsets = fieldsets.keys
        if (fieldsets.paths !== undefined) {
          descriptor.nestedFieldsetPaths = fieldsets.paths
        }
      }
      const sortable = this.sortable(collection)
      if (sortable !== undefined) {
        descriptor.sortable = sortable
      }
      const sortFamilies = this.sortFamilies(collection)
      if (sortFamilies !== undefined) {
        descriptor.sortFamilies = sortFamilies
      }
      const filterable = this.filterable(collection)
      if (filterable !== undefined) {
        descriptor.filterable = filterable
      }
      const collectionRead =
        collection === undefined ? undefined : this.operation(collection, 'get')
      const listFilters = listFilterKeys(collectionRead)
      if (listFilters !== undefined) {
        descriptor.listFilters = listFilters
      }
      const filterFamilies = filterFamiliesOf(collectionRead)
      if (filterFamilies !== undefined) {
        descriptor.filterFamilies = filterFamilies
      }
      if (Object.keys(actions).length > 0) {
        descriptor.actions = actions
      }
      const scopes = this.operationScopes(wireType)
      if (Object.keys(scopes).length > 0) {
        descriptor.scopes = scopes
      }
      const accepted = this.acceptedWrites(collection, item)
      if (accepted !== undefined) {
        descriptor.accepted = accepted
      }
      const documentMeta = this.operationsDocumentMeta(collection, item)
      if (documentMeta !== undefined) {
        descriptor.documentMeta = documentMeta
      }
      const requestMeta = this.operationsRequestMeta(collection, item)
      if (requestMeta !== undefined) {
        descriptor.requestMeta = requestMeta
      }
      const atomicRequestMeta = this.atomicRequestMeta(base)
      if (atomicRequestMeta !== undefined) {
        descriptor.atomicRequestMeta = atomicRequestMeta
      }
      this.withAtomicRelationshipMeta(descriptor.relations, base, wireType)
      const resourceMeta = this.resourceMeta(base, schema)
      if (resourceMeta !== undefined) {
        descriptor.resourceMeta = resourceMeta
      }
      // A synthetic stub for an unregistered related type — core's `permissiveResourceObject`
      // emits a `<Rel>Resource` carrying ONLY a `type` const (no `id`/`attributes`) so linkage
      // refs resolve — is reachable only through a parent's `.related()` (which works via the
      // parent's own paths). Admitting it would surface a fully-typed top-level `client.<stub>`
      // whose every method throws, so drop it. A REAL registered resource carries the full
      // `type/id/attributes/…` object shape and stays, even with no attributes/collection of its
      // own; only the type-const-only stub (with no operation paths) is dropped.
      const isTypeOnlyStub = Object.keys(schema.properties ?? {}).every((prop) => prop === 'type')
      if (isTypeOnlyStub && Object.keys(descriptor.paths).length === 0) {
        continue
      }
      out[wireType] = descriptor
    }
    for (const [wireType, descriptor] of Object.entries(out)) {
      const shape = this.relatedQueries.get(wireType)
      if (shape === undefined) {
        delete descriptor.relatedQuery
      } else {
        descriptor.relatedQuery = { ...descriptor.relatedQuery!, ...shape }
      }
    }
    return sortRecord(out)
  }

  /**
   * The top-level `meta` each of a type's operations declares, keyed `fetchMany`, `create`,
   * `fetchOne`, `update` or `delete`. `undefined` when none declares any.
   */
  private operationsDocumentMeta(
    collection: string | undefined,
    item: string | undefined,
  ): Partial<Record<DocumentMetaOperation, DocumentMetaDescriptor>> | undefined {
    const operations: [DocumentMetaOperation, string | undefined, HttpMethod][] = [
      ['fetchMany', collection, 'get'],
      ['create', collection, 'post'],
      ['fetchOne', item, 'get'],
      ['update', item, 'patch'],
      ['delete', item, 'delete'],
    ]
    const out: Partial<Record<DocumentMetaOperation, DocumentMetaDescriptor>> = {}
    for (const [operation, path, method] of operations) {
      const op = path === undefined ? undefined : this.operation(path, method)
      const meta = op === undefined ? undefined : this.declaredMeta(this.firstOkJsonApiRef(op))
      if (meta !== undefined) {
        out[operation] = meta
      }
    }
    return Object.keys(out).length === 0 ? undefined : out
  }

  /**
   * The shared document a per-operation document component narrows: the first `allOf` entry's
   * `$ref` of a component marked `x-document-meta` or `x-request-meta`, else `ref` as it is.
   */
  private sharedDocumentRef(ref: string | undefined): string | undefined {
    const component = ref === undefined ? undefined : this.schemas[refName(ref) ?? '']
    if (component?.['x-document-meta'] !== true && component?.['x-request-meta'] !== true) {
      return ref
    }
    const shared = component.allOf?.[0]?.$ref
    return typeof shared === 'string' ? shared : ref
  }

  /**
   * The members a document component marked `x-document-meta` declares in its top-level `meta`:
   * each one's hint, the required ones and the nullable ones. `undefined` for a shared document.
   */
  private declaredMeta(ref: string | undefined): DocumentMetaDescriptor | undefined {
    return this.markedMeta(ref, 'x-document-meta')
  }

  /**
   * The `meta` node of a document component carrying `marker`: its narrowing's in an `allOf`, else
   * its own, as a meta-only request document carries it. Read as a {@link metaDescriptor}.
   */
  private markedMeta(
    ref: string | undefined,
    marker: 'x-document-meta' | 'x-request-meta',
  ): DocumentMetaDescriptor | undefined {
    const component = ref === undefined ? undefined : this.schemas[refName(ref) ?? '']
    if (component?.[marker] !== true) {
      return undefined
    }
    const entries = component.allOf === undefined ? [component] : component.allOf.slice(1)
    for (const entry of entries) {
      const meta = entry.properties?.['meta']
      if (isSchema(meta)) {
        return this.metaDescriptor(meta)
      }
    }
    return undefined
  }

  /**
   * A declared `meta` object's {@link PivotDescriptor}: each member's hint, the required ones (all
   * of them when `required` is absent), the nullable ones, and what its `additionalProperties`
   * opens it to. `undefined` when it declares no member and is closed, unless `keepEmpty`.
   */
  private metaDescriptor(
    meta: SchemaObject,
    skip: readonly string[] = [],
    keepEmpty = false,
  ): PivotDescriptor | undefined {
    const fields: Record<string, string> = {}
    const values: Record<string, MetaLiteral[]> = {}
    const nullable: string[] = []
    for (const [name, prop] of Object.entries(meta.properties ?? {})) {
      if (!isSchema(prop) || skip.includes(name)) {
        continue
      }
      fields[name] = formatHint(prop, this.schemas)
      const listed = memberValues(prop, fields[name], this.schemas)
      if (listed !== undefined) {
        values[name] = listed
      }
      if (isNullable(prop)) {
        nullable.push(name)
      }
    }
    const names = Object.keys(fields)
    const additional = this.additionalMembers(meta)
    if (names.length === 0 && additional === undefined && !keepEmpty) {
      return undefined
    }
    const out: PivotDescriptor = { fields: sortRecord(fields) }
    const required = names.filter((name) => meta.required?.includes(name))
    if (required.length < names.length) {
      // oxlint-disable-next-line no-array-sort -- sorting a freshly-created array
      out.required = required.sort()
    }
    if (nullable.length > 0) {
      // oxlint-disable-next-line no-array-sort -- sorting a freshly-created array
      out.nullable = nullable.sort()
    }
    if (additional !== undefined) {
      out.additional = additional
    }
    if (Object.keys(values).length > 0) {
      out.values = sortRecord(values)
    }
    return out
  }

  /**
   * What an object's `additionalProperties` opens it to: any value for `true`, else the hint of the
   * schema each undeclared member matches. `undefined` for a closed object or one that doesn't say.
   */
  private additionalMembers(schema: SchemaObject): PivotDescriptor['additional'] {
    const additional = schema['additionalProperties'] as SchemaOrBool | undefined
    if (additional === true) {
      return { format: 'unknown' }
    }
    if (!isSchema(additional)) {
      return undefined
    }
    const out: AdditionalMembersDescriptor = { format: formatHint(additional, this.schemas) }
    if (isNullable(additional)) {
      out.nullable = true
    }
    const values = memberValues(additional, out.format, this.schemas)
    if (values !== undefined) {
      out.values = values
    }
    return out
  }

  /**
   * The top-level `meta` each of a type's writes takes, keyed `create`, `update` or `delete`, from
   * its request document marked `x-request-meta`. `undefined` when none declares any.
   */
  private operationsRequestMeta(
    collection: string | undefined,
    item: string | undefined,
  ): Partial<Record<RequestMetaOperation, DocumentMetaDescriptor>> | undefined {
    const operations: [RequestMetaOperation, string | undefined, HttpMethod][] = [
      ['create', collection, 'post'],
      ['update', item, 'patch'],
      ['delete', item, 'delete'],
    ]
    const out: Partial<Record<RequestMetaOperation, DocumentMetaDescriptor>> = {}
    for (const [operation, path, method] of operations) {
      const op = path === undefined ? undefined : this.operation(path, method)
      const meta = this.requestMeta(op)
      if (meta !== undefined) {
        out[operation] = meta
      }
    }
    return Object.keys(out).length === 0 ? undefined : out
  }

  /** The top-level `meta` an operation's JSON:API request document declares, if it declares any. */
  private requestMeta(op: OperationObject | undefined): DocumentMetaDescriptor | undefined {
    const ref = op?.requestBody?.content?.[JSON_API_MEDIA_TYPE]?.schema?.$ref
    return this.markedMeta(typeof ref === 'string' ? ref : undefined, 'x-request-meta')
  }

  /**
   * The top-level `meta` each of a type's atomic operation kinds of its own declares, keyed
   * `create` (its `add`), `update` or `delete` (its `remove`). `undefined` when it has none.
   */
  private atomicRequestMeta(
    base: string,
  ): Partial<Record<RequestMetaOperation, DocumentMetaDescriptor>> | undefined {
    const kinds: [RequestMetaOperation, string][] = [
      ['create', 'Add'],
      ['update', 'Update'],
      ['delete', 'Remove'],
    ]
    const out: Partial<Record<RequestMetaOperation, DocumentMetaDescriptor>> = {}
    for (const [operation, kind] of kinds) {
      const component = this.schemas[`${base}Atomic${kind}Operation`]
      const meta = component?.properties?.['meta']
      if (component?.['x-request-meta'] === true && isSchema(meta)) {
        const descriptor = this.metaDescriptor(meta)
        if (descriptor !== undefined) {
          out[operation] = descriptor
        }
      }
    }
    return Object.keys(out).length === 0 ? undefined : out
  }

  /**
   * Record on each relation the top-level `meta` its atomic relationship operation kinds of its own
   * declare, keyed by verb: `add`, `remove` and `replace` on a to-many, `set` on a to-one.
   */
  private withAtomicRelationshipMeta(
    relations: Record<string, RelationDescriptor>,
    base: string,
    wireType: string,
  ): void {
    for (const [name, kinds] of atomicRelationshipOperations(this.schemas, base, wireType)) {
      const relation = relations[name]
      if (relation === undefined) {
        continue
      }
      const verbs: (keyof RelationMutations)[] =
        relation.cardinality === 'many' ? ['add', 'remove', 'replace'] : ['set']
      const out: Partial<Record<keyof RelationMutations, DocumentMetaDescriptor>> = {}
      for (const verb of verbs) {
        const meta = kinds[ATOMIC_RELATIONSHIP_KINDS[verb]]?.properties?.['meta']
        const descriptor = isSchema(meta) ? this.metaDescriptor(meta) : undefined
        if (descriptor !== undefined) {
          out[verb] = descriptor
        }
      }
      if (Object.keys(out).length > 0) {
        relations[name] = { ...relation, atomicRequestMeta: out }
      }
    }
  }

  /**
   * The `meta` of a type's resource objects, from the components marked `x-resource-meta`: the one
   * its resource object renders, and the `data.meta` its create, update and atomic bodies take.
   * The atomic ones are kept only where they differ. `undefined` when the type declares none.
   */
  private resourceMeta(base: string, resource: SchemaObject): ResourceMetaDescriptor | undefined {
    const read = (node: SchemaOrBool | undefined): PivotDescriptor | undefined => {
      const schema = isSchema(node) ? this.resolveSchema(node) : undefined
      return schema?.['x-resource-meta'] === true
        ? this.metaDescriptor(schema, [], true)
        : undefined
    }
    const dataMeta = (component: string): PivotDescriptor | undefined => {
      const data = this.schemas[component]?.properties?.['data']
      return read(isSchema(data) ? data.properties?.['meta'] : undefined)
    }
    const out: ResourceMetaDescriptor = {}
    const entries: [keyof ResourceMetaDescriptor, PivotDescriptor | undefined][] = [
      ['read', read(resource.properties?.['meta'])],
      ['create', dataMeta(`${base}CreateRequest`)],
      ['update', dataMeta(`${base}UpdateRequest`)],
      ['atomicCreate', read(this.schemas[`${base}AtomicAdd`]?.properties?.['meta'])],
      ['atomicUpdate', read(this.schemas[`${base}AtomicUpdate`]?.properties?.['meta'])],
    ]
    for (const [key, descriptor] of entries) {
      if (descriptor !== undefined) {
        out[key] = descriptor
      }
    }
    for (const [atomic, write] of [
      ['atomicCreate', 'create'],
      ['atomicUpdate', 'update'],
    ] as const) {
      if (JSON.stringify(out[atomic]) === JSON.stringify(out[write])) {
        delete out[atomic]
      }
    }
    return Object.keys(out).length === 0 ? undefined : out
  }

  /** Whether a document `$ref` names a meta-only document, through any per-operation narrowing. */
  private isMetaDocument(ref: string | undefined): boolean {
    const shared = this.sharedDocumentRef(ref)
    return shared !== undefined && refName(shared) === 'MetaDocument'
  }

  /**
   * The writes of a type that declare a `202 Accepted`, keyed `create` (the collection's `POST`)
   * or `update` (the resource's `PATCH`). `undefined` when neither does.
   */
  private acceptedWrites(
    collection: string | undefined,
    item: string | undefined,
  ): Partial<Record<AcceptedOperation, AcceptedDescriptor>> | undefined {
    const out: Partial<Record<AcceptedOperation, AcceptedDescriptor>> = {}
    if (collection !== undefined) {
      const create = this.accepted(this.operation(collection, 'post'), `POST ${collection}`)
      if (create !== undefined) {
        out.create = create
      }
    }
    if (item !== undefined) {
      const update = this.accepted(this.operation(item, 'patch'), `PATCH ${item}`)
      if (update !== undefined) {
        out.update = update
      }
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  /**
   * The `202 Accepted` an operation declares: the job type its body's primary `data` names, a
   * `$ref` to the job type's document or the inline document of a type the server doesn't
   * register. `undefined` when the operation declares no `202`; a `202` whose job type can't be
   * read warns and is left out.
   */
  private accepted(op: OperationObject | undefined, label: string): AcceptedDescriptor | undefined {
    const response = op?.responses?.['202']
    if (response === undefined) {
      return undefined
    }
    const body = response.content?.[JSON_API_MEDIA_TYPE]?.schema
    const ref = typeof body?.$ref === 'string' ? body.$ref : undefined
    const shared = this.sharedDocumentRef(ref)
    const schema = this.resolveSchema(shared === undefined ? body : { $ref: shared })
    const data = schema?.properties?.['data']
    const jobType = isSchema(data) ? this.dataConst(data) : undefined
    if (jobType === undefined) {
      // eslint-disable-next-line no-console
      console.warn(
        `json-api codegen: ${label} declares a 202 Accepted whose job type can't be read; it is typed as answering synchronously.`,
      )
      return undefined
    }
    const meta = this.declaredMeta(ref)
    return meta === undefined ? { jobType } : { jobType, meta }
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
        const scopes = this.scopes(item.post)
        return scopes === undefined ? { path } : { path, scopes }
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
        out[name] = formatHint(prop, this.schemas)
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
    item: string | undefined,
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
        // nested forms), so warn rather than emit a client missing the relation.
        // eslint-disable-next-line no-console
        console.warn(
          `json-api codegen: relationship "${name}" has an unrecognized linkage shape; dropping it from the descriptor.`,
        )
        return
      }
      const descriptor: RelationDescriptor = { ...parsed }
      if (writeOnly) {
        delete descriptor.readPivot
        delete descriptor.identifierMeta
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
        item === undefined
          ? this.withoutCollection(descriptor, endpoints.get(name))
          : this.withRelationExposure(descriptor, item, name, endpoints.get(name))
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
   * endpoint (`{item}/relationships/{rel}`) advertises. For a to-many:
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
   * The top-level `meta` each relationship write takes and the meta-only `200` it answers with,
   * keyed by verb: `add` (POST), `remove` (DELETE) and `replace` (PATCH) on a to-many, `set`
   * (PATCH) on a to-one. Each map is left out when no verb declares any.
   */
  private relationshipWriteMeta(
    path: string,
    cardinality: Cardinality,
  ): Pick<RelationDescriptor, 'requestMeta' | 'mutationMeta'> {
    const verbs: [keyof RelationMutations, HttpMethod][] =
      cardinality === 'many'
        ? [
            ['add', 'post'],
            ['remove', 'delete'],
            ['replace', 'patch'],
          ]
        : [['set', 'patch']]
    const requestMeta: Partial<Record<keyof RelationMutations, DocumentMetaDescriptor>> = {}
    const mutationMeta: Partial<Record<keyof RelationMutations, DocumentMetaDescriptor>> = {}
    for (const [verb, method] of verbs) {
      const op = this.operation(path, method)
      const request = this.requestMeta(op)
      if (request !== undefined) {
        requestMeta[verb] = request
      }
      const ref = op === undefined ? undefined : this.firstOkJsonApiRef(op)
      const response = this.isMetaDocument(ref) ? this.declaredMeta(ref) : undefined
      if (response !== undefined) {
        mutationMeta[verb] = response
      }
    }
    return {
      ...(Object.keys(requestMeta).length > 0 ? { requestMeta } : {}),
      ...(Object.keys(mutationMeta).length > 0 ? { mutationMeta } : {}),
    }
  }

  /**
   * A relation of a type with no resource endpoint, such as one only an action returns. When no
   * related or relationship read reaches it, it takes neither sort nor filter.
   */
  private withoutCollection(
    descriptor: RelationDescriptor,
    endpoints: RelationEndpoints | undefined,
  ): RelationDescriptor {
    const read = (path: string | undefined): OperationObject | undefined =>
      path === undefined ? undefined : this.operation(path, 'get')
    return read(endpoints?.related) === undefined && read(endpoints?.relationship) === undefined
      ? { ...descriptor, sortable: [], filterable: [] }
      : descriptor
  }

  /**
   * Attach the per-relation endpoint-exposure signal to a relation descriptor. The bundle
   * can suppress a relation's related or relationship endpoint (`withoutRelatedEndpoint()` /
   * `withoutRelationshipEndpoint()`), which the OpenAPI reflects by simply omitting that
   * relation's path — but codegen synthesizes generic `{rel}` templates, erasing the per-relation
   * distinction. So mark `related: false` / `relationship: false` when this relation's specific
   * path is absent, and ALWAYS emit an explicit `mutations` object (the verb flags when the
   * relationship endpoint exists, else `{}`) so the client gates a suppressed relation OFF rather
   * than failing open (offering `.get()`/`.related()`/mutations that 404).
   */
  private withRelationExposure(
    descriptor: RelationDescriptor,
    item: string,
    name: string,
    endpoints: RelationEndpoints | undefined,
  ): RelationDescriptor {
    const out: RelationDescriptor = { ...descriptor }
    const relatedPath = endpoints?.related ?? `${item}/${name}`
    const relationshipPath = endpoints?.relationship ?? `${item}/relationships/${name}`
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
    const target = isPolymorphic(descriptor) ? undefined : descriptor.types[0]
    if (target !== undefined && this.takesRelatedQuery(relatedGet, target)) {
      out.relatedQuery = true
    }
    const mutations = this.relationMutations(relationshipPath, descriptor.cardinality)
    if (mutations === undefined) {
      out.relationship = false
      out.mutations = {}
    } else {
      out.mutations = mutations
      Object.assign(out, this.relationshipWriteMeta(relationshipPath, descriptor.cardinality))
    }
    // The related/relationship reads may advertise their own `withCount` (`_self_` + the relation's
    // countable relations) with a negotiation profile — capture it so a typed `.related()`/`.get()`
    // can send `withCount` and negotiate the profile the endpoint requires.
    const included = this.includedTypes(relatedGet)
    if (included !== undefined) {
      out.included = included
    }
    const documentMeta =
      relatedGet === undefined ? undefined : this.declaredMeta(this.firstOkJsonApiRef(relatedGet))
    if (documentMeta !== undefined) {
      out.documentMeta = documentMeta
    }
    const countable =
      withCountParam(relatedGet) ?? withCountParam(this.operation(relationshipPath, 'get'))
    if (countable !== undefined) {
      out.countable = countable
    }
    const reads = relatedGet ?? this.operation(relationshipPath, 'get')
    // An empty `sortable` or `filterable` tells the client the reads take no sort or no filter, so
    // it types `sort` or `filter` as `never`. A relation with no read takes neither.
    if (reads === undefined || paramSchema(reads, 'sort') === undefined) {
      out.sortable = []
    }
    if (
      reads === undefined ||
      (filterKeys(reads) === undefined && filterFamiliesOf(reads) === undefined)
    ) {
      out.filterable = []
    }
    if (isPolymorphic(descriptor)) {
      Object.assign(out, sortQueries(reads), filterQueries(reads))
    } else {
      // The client reads a monomorphic relation with its related type's collection sorts and
      // filters, so the relation records its own only where its reads take different ones.
      const collectionRead =
        descriptor.types[0] === undefined ? undefined : this.collectionRead(descriptor.types[0])
      if (sortVocabulary(reads) !== sortVocabulary(collectionRead)) {
        Object.assign(out, sortQueries(reads))
      }
      if (filterVocabulary(reads) !== filterVocabulary(collectionRead)) {
        Object.assign(out, filterQueries(reads))
      }
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
   * `{item}/-actions/{name}` paths, where the item path is `{collection}/{id}` or a singleton's
   * own path. The action name is the last segment; scope is `resource` for an item path, else
   * `collection`. `input` is `document`
   * (a JSON:API requestBody), `none` (no requestBody) or `raw` (a non-JSON:API body);
   * `output` is `document` (a 2xx returns a JSON:API document) or `none` (only `204`). An action
   * answering to several methods gives one entry per method (see {@link pickOperations}).
   */
  private actions(
    collection: string | undefined,
    itemPath: string | undefined,
  ): Record<string, ActionDescriptor> {
    const out: Record<string, ActionDescriptor> = {}
    const collectionPrefix = collection === undefined ? undefined : `${collection}/-actions/`
    const resourcePrefix = itemPath === undefined ? undefined : `${itemPath}/-actions/`
    for (const [path, item] of Object.entries(this.paths)) {
      let scope: ActionDescriptor['scope']
      let name: string
      if (resourcePrefix !== undefined && path.startsWith(resourcePrefix)) {
        scope = 'resource'
        name = path.slice(resourcePrefix.length)
      } else if (collectionPrefix !== undefined && path.startsWith(collectionPrefix)) {
        scope = 'collection'
        name = path.slice(collectionPrefix.length)
      } else {
        continue
      }
      // The action name is a single trailing segment.
      if (name.length === 0 || name.includes('/')) {
        continue
      }
      // A path item may advertise several methods. The preferred one (POST, else the first) keeps
      // the bare name, so a client generated before contract 15 keeps compiling.
      const picked = pickOperations(item)
      if (picked.length === 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `json-api codegen: custom action path "${path}" advertises no usable operation; skipping.`,
        )
        continue
      }
      for (const [index, { method, op }] of picked.entries()) {
        const key = index === 0 ? name : methodActionName(name, method)
        if (key in out) {
          // eslint-disable-next-line no-console
          console.warn(
            `json-api codegen: the ${method.toUpperCase()} operation of custom action path "${path}" would be named "${key}", which another action already uses; skipping.`,
          )
          continue
        }
        out[key] = this.action(scope, path, method, op)
      }
    }
    return sortRecord(out)
  }

  /** The descriptor for one operation of a custom action. */
  private action(
    scope: ActionDescriptor['scope'],
    path: string,
    method: HttpMethod,
    op: OperationObject,
  ): ActionDescriptor {
    const requestMeta = this.requestMeta(op)
    // A meta-only request document carries no input, only the meta the action declares.
    const input = requestMeta !== undefined && this.isMetaOnlyRequest(op) ? 'none' : actionInput(op)
    const output = actionOutput(op, (ref) => this.isMetaDocument(ref))
    const action: ActionDescriptor = { scope, path, input, output }
    const filterable = filterKeys(op)
    if (filterable !== undefined) {
      action.filterable = filterable
    }
    const listFilters = listFilterKeys(op)
    if (listFilters !== undefined) {
      action.listFilters = listFilters
    }
    const filterFamilies = filterFamiliesOf(op)
    if (filterFamilies !== undefined) {
      action.filterFamilies = filterFamilies
    }
    // Only carried when non-POST (POST is the runtime default), keeping the common descriptor tiny.
    if (method !== 'post') {
      action.method = method.toUpperCase()
    }
    // A document input names its resource type so the client can accept FLAT input and build the
    // envelope (+ remap 422 pointers), matching `create`/`update` ergonomics.
    if (input === 'document') {
      const inputType = this.documentPrimary(this.requestBodyRef(op))?.type
      if (inputType !== undefined) {
        action.inputType = inputType
      }
    }
    // A document output names its primary resource type + cardinality so the client materialises
    // the response into that resource view (matching reads), not the raw wire envelope.
    if (output === 'document') {
      const refs = this.okJsonApiRefs(op)
      if (refs[0] !== undefined && this.isMetaDocument(refs[0])) {
        action.metaResult = true
      }
      const documents = refs.filter((ref) => !this.isMetaDocument(ref))
      const primary = this.documentPrimary(documents[0])
      if (primary !== undefined) {
        action.outputType = primary.type
        action.outputCardinality = primary.cardinality
        if (primary.cardinality === 'one' && this.takesRelatedQuery(op, primary.type)) {
          action.relatedQuery = true
        }
        // A `200` and a `201` naming different types can't share one output view; the first wins.
        for (const ref of documents.slice(1)) {
          const other = this.documentPrimary(ref)
          if (other !== undefined && other.type !== primary.type) {
            // eslint-disable-next-line no-console
            console.warn(
              `json-api codegen: custom action path "${path}" answers with both a "${primary.type}" and a "${other.type}" document; its result is typed as "${primary.type}".`,
            )
          }
        }
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
    // Generator contract 10: media types other than JSON:API under a 2xx, picked by `Accept`.
    const rawOutput = this.rawOutput(op)
    if (rawOutput.length > 0) {
      action.rawOutput = rawOutput
    }
    // Several request media types, picked by `Content-Type`. One is already `input`/`contentType`.
    const requestContent = Object.entries(op.requestBody?.content ?? {})
    if (requestContent.length > 1) {
      action.inputMedia = requestContent.map(([mediaType, media]) => ({
        mediaType,
        kind: this.inputMediaKind(mediaType, media.schema),
      }))
    }
    // Generator contract 15: the flags the action declares, each only when declared.
    const safety = op['x-safety']
    for (const flag of ['readOnly', 'destructive', 'idempotent'] as const) {
      const value = safety?.[flag]
      if (typeof value === 'boolean') {
        action[flag] = value
      }
    }
    // Generator contract 16: the scopes its operation's `security` lists.
    const scopes = this.scopes(op)
    if (scopes !== undefined) {
      action.scopes = scopes
    }
    // Generator contract 17: a location document carrying the URL the action produced.
    const okSchema = okJsonApiSchema(op)
    const mediaType = okSchema === undefined ? undefined : locationMediaType(okSchema)
    if (mediaType !== undefined) {
      action.location = { mediaType }
    }
    const accepted = this.accepted(op, `custom action path "${path}"`)
    if (accepted !== undefined) {
      action.accepted = accepted
    }
    const documentMeta = this.actionDocumentMeta(op)
    if (documentMeta !== undefined) {
      action.documentMeta = documentMeta
    }
    if (requestMeta !== undefined) {
      action.requestMeta = requestMeta
    }
    return action
  }

  /** Whether an operation's JSON:API request document is meta-only: it has no `data` member. */
  private isMetaOnlyRequest(op: OperationObject): boolean {
    const ref = this.requestBodyRef(op)
    const component = ref === undefined ? undefined : this.schemas[refName(ref) ?? '']
    return component !== undefined && !('data' in (component.properties ?? {}))
  }

  /**
   * The top-level `meta` each of an action's success statuses declares, `null` for a status whose
   * JSON:API document declares none. `undefined` when none declares any.
   */
  private actionDocumentMeta(
    op: OperationObject,
  ): Record<string, DocumentMetaDescriptor | null> | undefined {
    const out: Record<string, DocumentMetaDescriptor | null> = {}
    let declared = false
    for (const [status, ref] of this.okJsonApiResponses(op)) {
      const meta = this.declaredMeta(ref)
      out[status] = meta ?? null
      declared ||= meta !== undefined
    }
    return declared ? out : undefined
  }

  /**
   * The non-JSON:API media types an action answers with under its 2xx responses, each once, in
   * the document's order, with how the client reads its body.
   */
  private rawOutput(op: OperationObject): RawOutputMedia[] {
    const out: RawOutputMedia[] = []
    for (const [code, response] of Object.entries(op.responses ?? {})) {
      if (!isResultStatus(code)) {
        continue
      }
      for (const [mediaType, media] of Object.entries(response.content ?? {})) {
        if (isJsonApiMediaType(mediaType) || out.some((entry) => entry.mediaType === mediaType)) {
          continue
        }
        out.push({ mediaType, kind: this.rawMediaKind(mediaType, media.schema) })
      }
    }
    return out
  }

  /**
   * How the client reads or sends a non-JSON:API body: `binary` for `format: binary` (or no schema
   * on a type that isn't text or JSON), `text` for any other string schema (or no schema on a
   * `text/*` type), `json` for any other schema (or no schema on a JSON type).
   */
  private rawMediaKind(mediaType: string, schema: SchemaObject | undefined): RawMediaKind {
    const resolved = this.resolveSchema(schema)
    if (resolved === undefined) {
      if (mediaType.startsWith('text/')) {
        return 'text'
      }
      return isJsonMediaType(mediaType) ? 'json' : 'binary'
    }
    if (resolved.type === 'string') {
      return resolved.format === 'binary' ? 'binary' : 'text'
    }
    return 'json'
  }

  /** How the client sends one of an action's several request media types. */
  private inputMediaKind(mediaType: string, schema: SchemaObject | undefined): InputMediaKind {
    if (isJsonApiMediaType(mediaType)) {
      return 'document'
    }
    if (mediaType.startsWith('multipart/')) {
      return 'multipart'
    }
    if (mediaType === 'application/x-www-form-urlencoded') {
      return 'form'
    }
    return this.rawMediaKind(mediaType, schema)
  }

  /** A schema with a component `$ref` followed, else the schema as is. */
  private resolveSchema(schema: SchemaObject | undefined): SchemaObject | undefined {
    if (schema === undefined || typeof schema.$ref !== 'string') {
      return schema
    }
    const name = refName(schema.$ref)
    return name === undefined ? schema : (this.schemas[name] ?? schema)
  }

  /**
   * The wire type (and cardinality) of a document component's primary `data` — a `$ref` to a
   * resource, an inline object carrying `properties.type.const` (a create-request body), or an
   * array of resource/identifier refs (a collection). `undefined` when the type can't be resolved.
   */
  private documentPrimary(
    ref: string | undefined,
  ): { type: string; cardinality: Cardinality } | undefined {
    const shared = this.sharedDocumentRef(ref)
    if (typeof shared !== 'string') {
      return undefined
    }
    const component = refName(shared)
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

  /**
   * The wire types a read's compound document can carry in `included`: the members of its
   * document's `included.items` union. `undefined` when the document has no `included`, or types
   * its items only as a generic `{type, id}` object.
   */
  private includedTypes(op: OperationObject | undefined): readonly string[] | undefined {
    const ref = op === undefined ? undefined : this.sharedDocumentRef(this.firstOkJsonApiRef(op))
    const document = ref === undefined ? undefined : this.schemas[refName(ref) ?? '']
    const included = document?.properties?.['included']
    const items = isSchema(included) ? included.items : undefined
    const types =
      items === undefined || !Array.isArray(items.oneOf) ? undefined : this.unionTypes(items)
    return types !== undefined && types.length > 0 ? types : undefined
  }

  /** The `$ref` of the first 2xx JSON:API response body on an operation (the output document). */
  private firstOkJsonApiRef(op: OperationObject): string | undefined {
    return this.okJsonApiRefs(op)[0]
  }

  /**
   * The `$ref` of each 2xx JSON:API response body on an operation, in status order: an action's
   * `200` document, then the `201` document of the resource it created.
   */
  private okJsonApiRefs(op: OperationObject): string[] {
    return this.okJsonApiResponses(op).map(([, ref]) => ref)
  }

  /** Each 2xx status answering with a JSON:API document, and that document's `$ref`, in order. */
  private okJsonApiResponses(op: OperationObject): [string, string][] {
    const out: [string, string][] = []
    for (const [code, response] of Object.entries(op.responses ?? {})) {
      if (!isResultStatus(code)) {
        continue
      }
      const schema = response.content?.[JSON_API_MEDIA_TYPE]?.schema
      // A response offering a location document too names its other document in a `oneOf`.
      const ref = schema === undefined ? undefined : documentArms(schema)[0]?.$ref
      if (typeof ref === 'string') {
        out.push([code, ref])
      }
    }
    return out
  }

  /** Resolve a relationship component's `data` into a {@link RelationDescriptor}. */
  private relationFromComponent(component: SchemaObject): RelationDescriptor | undefined {
    const data = component.properties?.['data']
    if (!isSchema(data)) {
      return undefined
    }

    // to-many: data.type === 'array'
    if (data.type === 'array') {
      const entry = data.items === undefined ? undefined : this.linkageEntry(data.items)
      if (entry === undefined || entry.types.length === 0) {
        return undefined
      }
      return this.relationOf('many', entry)
    }

    // to-one: data.anyOf with the non-null entries being $refs, unions or typed-meta allOfs.
    if (Array.isArray(data.anyOf)) {
      const merged: LinkageEntry = { types: [], polymorphic: false }
      for (const item of data.anyOf) {
        const entry = this.linkageEntry(item)
        if (entry === undefined) {
          continue
        }
        merged.types.push(...entry.types)
        merged.polymorphic ||= entry.polymorphic
        if (merged.pivot === undefined && entry.pivot !== undefined) {
          merged.pivot = entry.pivot
        }
        if (merged.identifierMeta === undefined && entry.identifierMeta !== undefined) {
          merged.identifierMeta = entry.identifierMeta
        }
      }
      return merged.types.length === 0 ? undefined : this.relationOf('one', merged)
    }

    return undefined
  }

  /**
   * One linkage identifier schema: a `$ref` to a type's identifier, a polymorphic union of them,
   * or an `allOf` of either with a narrowing that types the identifier's `meta` (its `pivot` and
   * the members an identifier meta resolver declares). `undefined` for any other shape.
   */
  private linkageEntry(schema: SchemaObject): LinkageEntry | undefined {
    if (typeof schema.$ref === 'string') {
      const type = this.resolveConst(schema.$ref)
      return type === undefined ? undefined : { types: [type], polymorphic: false }
    }
    if (Array.isArray(schema.allOf)) {
      let base: LinkageEntry | undefined
      for (const part of schema.allOf) {
        if (
          typeof part.$ref === 'string' ||
          Array.isArray(part.oneOf) ||
          Array.isArray(part.anyOf)
        ) {
          base ??= this.linkageEntry(part)
        }
      }
      if (base === undefined) {
        return undefined
      }
      const meta = metaNodesFromAllOf(schema.allOf, this.schemas)
      return {
        ...base,
        ...(meta.pivot === undefined ? {} : { pivot: meta.pivot }),
        ...(meta.identifierMeta === undefined ? {} : { identifierMeta: meta.identifierMeta }),
      }
    }
    const union = this.unionTypes(schema)
    return union === undefined ? undefined : { types: union, polymorphic: true }
  }

  /** A {@link RelationDescriptor} from a parsed linkage entry. */
  private relationOf(cardinality: Cardinality, entry: LinkageEntry): RelationDescriptor {
    const pivot = entry.pivot !== undefined
    const relation: RelationDescriptor = entry.polymorphic
      ? { cardinality, types: entry.types, polymorphic: true, pivot }
      : { cardinality, types: entry.types, pivot }
    const readPivot = pivot ? this.pivotDescriptor(entry.pivot, 'read') : undefined
    if (readPivot !== undefined) {
      relation.readPivot = readPivot
    }
    const identifierMeta = this.pivotDescriptor(entry.identifierMeta, 'read', 'identifierMeta')
    if (identifierMeta !== undefined) {
      relation.identifierMeta = identifierMeta
    }
    return relation
  }

  /**
   * The request pivot of a pivot relation: read off the component a write body (or a
   * relationship mutation) refs, falling back to the rendered relationship's pivot minus its
   * `readOnly` fields when no request shape is published (before generator contract 8).
   */
  private writePivot(ref: string | undefined, fallback: SchemaObject): PivotDescriptor | undefined {
    const component = ref === undefined ? undefined : this.schemas[refName(ref) ?? '']
    return this.pivotDescriptor(
      pivotNodeOf(component ?? fallback, this.schemas) ?? pivotNodeOf(fallback, this.schemas),
      'write',
    )
  }

  /**
   * A {@link PivotDescriptor} from a member's `meta.pivot` schema: field hints, the required
   * fields and the nullable ones. Generator contract 8 refs a `<Type><Rel>Pivot` (response) or
   * `<Type><Rel>WritePivot` (request) component, each with its own `required`. An older document
   * inlines one shared schema in the write context, so a read takes every field as rendered and a
   * write drops the `readOnly` ones. Each records what its `additionalProperties` opens it to. An
   * identifier meta object leaves out its `pivot`, which {@link RelationDescriptor.readPivot}
   * types, and records that it is closed. `undefined` when the schema has no fields and isn't open.
   */
  private pivotDescriptor(
    node: SchemaObject | undefined,
    side: 'read' | 'write',
    kind: 'pivot' | 'identifierMeta' = 'pivot',
  ): PivotDescriptor | undefined {
    if (node === undefined) {
      return undefined
    }
    const shared = typeof node.$ref !== 'string'
    const schema = shared ? node : this.schemas[refName(node.$ref as string) ?? '']
    const fields: Record<string, string> = {}
    const values: Record<string, MetaLiteral[]> = {}
    const nullable: string[] = []
    for (const [name, prop] of Object.entries(schema?.properties ?? {})) {
      if (
        !isSchema(prop) ||
        prop[side === 'read' ? 'writeOnly' : 'readOnly'] === true ||
        (kind === 'identifierMeta' && name === 'pivot')
      ) {
        continue
      }
      fields[name] = formatHint(prop, this.schemas)
      const listed = memberValues(prop, fields[name], this.schemas)
      if (listed !== undefined) {
        values[name] = listed
      }
      if (isNullable(prop)) {
        nullable.push(name)
      }
    }
    const names = Object.keys(fields)
    const additional = schema === undefined ? undefined : this.additionalMembers(schema)
    if (names.length === 0 && additional === undefined) {
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
    if (additional !== undefined) {
      out.additional = additional
    } else if (kind === 'identifierMeta' && schema?.['additionalProperties'] === false) {
      out.additional = false
    }
    if (Object.keys(values).length > 0) {
      out.values = sortRecord(values)
    }
    return out
  }

  /**
   * The wire types of a union of `$ref`s: a `oneOf` discriminated by `type`, or the `anyOf` an
   * older document writes. A member whose component carries no `type` const falls back to the
   * discriminator mapping's key for its `$ref`. `undefined` when the schema is no union.
   */
  private unionTypes(schema: SchemaObject): string[] | undefined {
    if (Array.isArray(schema.oneOf)) {
      const byRef = discriminatorTypesByRef(schema)
      const types: string[] = []
      for (const entry of schema.oneOf) {
        if (typeof entry.$ref !== 'string') {
          continue
        }
        const type = this.resolveConst(entry.$ref) ?? byRef.get(entry.$ref)
        if (type !== undefined) {
          types.push(type)
        }
      }
      return types
    }
    return Array.isArray(schema.anyOf) ? this.constsFromRefs(schema.anyOf) : undefined
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
   * Find the collection and item paths for a type, then derive each per-operation path that
   * actually exists. The collection path P is the one whose POST requestBody refs
   * `<Base>CreateRequest`, else the GET whose 200 response refs `<Base>Collection`, and the
   * item path is `P/{id}`. A singleton has no collection, and its item path is the one its
   * resource names in `x-singleton`. Any other type without a collection is read at its own
   * top-level item path, when it has one.
   */
  private operationPaths(base: string): Record<string, string> {
    const collection = this.collectionPath(base)
    const item = this.itemPath(base)
    const out: Record<string, string> = {}

    if (collection !== undefined && this.operation(collection, 'get')) {
      out['fetchMany'] = collection
    }
    if (collection !== undefined && this.operation(collection, 'post')) {
      out['create'] = collection
    }
    if (item === undefined) {
      return sortRecord(out)
    }

    if (this.operation(item, 'get')) {
      out['fetchOne'] = item
    }
    if (this.operation(item, 'patch')) {
      out['update'] = item
    }
    if (this.operation(item, 'delete')) {
      out['delete'] = item
    }

    if (this.hasRelatedPath(item)) {
      out['fetchRelated'] = `${item}/{rel}`
    }
    if (this.hasRelationshipPath(item)) {
      out['fetchRelationship'] = `${item}/relationships/{rel}`
    }

    return sortRecord(out)
  }

  /**
   * The path a singleton type is served at, which its `<Base>Resource` names in `x-singleton`.
   * `undefined` for any other type.
   */
  private singletonPath(base: string): string | undefined {
    const path = this.schemas[`${base}Resource`]?.['x-singleton']
    return typeof path === 'string' ? path : undefined
  }

  /** The path of a type's single resource: `{collection}/{id}`, or a singleton's own path. */
  private itemPath(base: string): string | undefined {
    const singleton = this.singletonPath(base)
    if (singleton !== undefined) {
      return singleton
    }
    const collection = this.collectionPath(base)
    return collection === undefined ? this.itemOnlyPath(base) : `${collection}/{id}`
  }

  /**
   * The item path of a type served without a collection, such as a job type read only at
   * `/jobs/{id}`: a top-level `/<segment>/{id}` path whose GET answers `<Base>Document`, or whose
   * PATCH takes `<Base>UpdateRequest`.
   */
  private itemOnlyPath(base: string): string | undefined {
    for (const [path, item] of Object.entries(this.paths)) {
      if (!/^\/[^/{}]+\/\{id\}$/.test(path)) {
        continue
      }
      if (
        refEndsWith(this.okResponseRef(item.get), `${base}Document`) ||
        refEndsWith(this.requestBodyRef(item.patch), `${base}UpdateRequest`)
      ) {
        return path
      }
    }
    return undefined
  }

  /**
   * A type's collection path. A singleton has none, even when to-many relations elsewhere reference
   * its `<Base>Collection` component.
   */
  private collectionPath(base: string): string | undefined {
    if (this.singletonPath(base) !== undefined) {
      return undefined
    }
    let byCollection: string | undefined
    for (const [path, item] of Object.entries(this.paths)) {
      // An action may take a type's create body as its input without being that type's collection.
      if (path.includes('/-actions/')) {
        continue
      }
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

  /** Any `<item>/<rel>` related path (excludes relationships/ and custom `-actions`). */
  private hasRelatedPath(item: string): boolean {
    const prefix = `${item}/`
    return Object.keys(this.paths).some((path) => {
      if (!path.startsWith(prefix)) {
        return false
      }
      const rest = path.slice(prefix.length)
      return rest.length > 0 && !rest.includes('/') && !rest.startsWith('-')
    })
  }

  private hasRelationshipPath(item: string): boolean {
    const prefix = `${item}/relationships/`
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
    // as unpaginated; warn rather than swallow it.
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
   * `countable` mirrors the endpoint `list` reads, and {@link resourceCountable} records the
   * single-resource operations, so neither advertises tokens its call cannot legally send.
   */
  private countable(collection: string | undefined): CountableDescriptor | undefined {
    if (collection === undefined) {
      return undefined
    }
    return withCountParam(this.operation(collection, 'get'))
  }

  /**
   * The `withCount` of the type's operations that answer with one resource: the single read
   * (`GET /{id}`), the create (`POST`) and the update (`PATCH /{id}`), each read off its own
   * `withCount` parameter as {@link countable} reads the collection's. An operation documenting
   * no `withCount` has no entry; `undefined` when none does. The tokens never include `_self_`,
   * which counts a collection.
   */
  private resourceCountable(
    collection: string | undefined,
    item: string | undefined,
  ): Partial<Record<ResourceCountOperation, CountableDescriptor>> | undefined {
    const operations: readonly [ResourceCountOperation, OperationObject | undefined][] = [
      ['fetchOne', item === undefined ? undefined : this.operation(item, 'get')],
      ['create', collection === undefined ? undefined : this.operation(collection, 'post')],
      ['update', item === undefined ? undefined : this.operation(item, 'patch')],
    ]
    const out: Partial<Record<ResourceCountOperation, CountableDescriptor>> = {}
    for (const [operation, op] of operations) {
      const countable = withCountParam(op)
      if (countable !== undefined) {
        out[operation] = {
          tokens: countable.tokens.filter((token) => token !== '_self_'),
          profile: countable.profile,
        }
      }
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  /**
   * The operations of a type that take `relatedQuery` for the resources they answer with: the
   * collection and single reads, the create and the update.
   */
  private relatedQueryOperations(
    wireType: string,
    collection: string | undefined,
    item: string | undefined,
  ): RelatedQueryOperation[] {
    const read = (path: string | undefined, method: HttpMethod) =>
      path === undefined ? undefined : this.operation(path, method)
    const operations: readonly [RelatedQueryOperation, OperationObject | undefined][] = [
      ['fetchMany', read(collection, 'get')],
      ['fetchOne', read(item, 'get')],
      ['create', read(collection, 'post')],
      ['update', read(item, 'patch')],
    ]
    return operations
      .filter(([, op]) => this.takesRelatedQuery(op, wireType))
      .map(([operation]) => operation)
  }

  /**
   * Whether `op` documents `relatedQuery` (the Relationship Queries profile) for the resources of
   * `renderedType` it answers with. The parameter is a `<Type>RelatedQuery` component shared by
   * every operation rendering that type, so its addressable relations, the keys of its schema's
   * `properties`, and its `x-profile` are recorded once per type.
   */
  private takesRelatedQuery(op: OperationObject | undefined, renderedType: string): boolean {
    const param = (op?.parameters ?? [])
      .map((p) => this.resolveParameter(p))
      .find((p) => p?.name === 'relatedQuery' && p.in === 'query')
    const profile = param?.['x-profile']
    if (typeof profile !== 'string') {
      return false
    }
    const relations = Object.keys(param?.schema?.properties ?? {})
    const known = this.relatedQueries.get(renderedType)
    if (known === undefined) {
      this.relatedQueries.set(renderedType, { relations, profile })
    } else if (known.relations.join() !== relations.join()) {
      // eslint-disable-next-line no-console
      console.warn(
        `json-api codegen: operations rendering "${renderedType}" document different relatedQuery relations; keeping ${JSON.stringify(known.relations)}.`,
      )
    }
    return true
  }

  /** A parameter with a `#/components/parameters/` `$ref` followed, else the parameter as is. */
  private resolveParameter(param: ParameterObject): ParameterObject | undefined {
    if (typeof param.$ref !== 'string') {
      return param
    }
    const prefix = '#/components/parameters/'
    return param.$ref.startsWith(prefix)
      ? this.sharedParameters[param.$ref.slice(prefix.length)]
      : undefined
  }

  /**
   * The relation paths the read endpoints accept in `include` — the `include` query
   * parameter's `schema.items.enum` (already including nested dotted paths) on `read`, the
   * collection GET, or a singleton's single read. Returns `undefined` when it advertises no
   * `include` (nothing includable). The bundle advertises the same `include` enum on the
   * collection and single-resource GETs.
   */
  private includable(read: OperationObject | undefined): readonly string[] | undefined {
    const tokens = paramItemsEnum(read, 'include')
    return tokens !== undefined && tokens.length > 0 ? tokens : undefined
  }

  /**
   * The sort tokens the COLLECTION read accepts — the `sort` query parameter's fixed enum
   * (signed field names) on the collection GET: `schema.items.enum`, or the enum branch of
   * `schema.items.anyOf` when the parameter also accepts sort families. Returns `undefined` when
   * the collection advertises no `sort` parameter or no fixed keys.
   */
  private sortable(collection: string | undefined): readonly string[] | undefined {
    return collection === undefined ? undefined : sortTokens(this.operation(collection, 'get'))
  }

  /**
   * The sort families the COLLECTION read accepts, from the `sort` parameter's
   * `x-sort-families`: each a key prefix and the pattern its suffix must match. Returns
   * `undefined` when the parameter lists none.
   */
  private sortFamilies(
    collection: string | undefined,
  ): readonly SortFamilyDescriptor[] | undefined {
    return collection === undefined ? undefined : sortFamiliesOf(this.operation(collection, 'get'))
  }

  /**
   * The filter keys the COLLECTION read accepts in `filter[...]` (the `filter[<key>]` parameter
   * names, `<key>` extracted), sorted for deterministic output. Returns `undefined` when the
   * collection advertises no `filter[...]` parameters (filtering unsupported). Value shapes are
   * deliberately not captured — `filter` values stay `unknown` (out of scope for v0.1).
   */
  private filterable(collection: string | undefined): readonly string[] | undefined {
    return collection === undefined ? undefined : filterKeys(this.operation(collection, 'get'))
  }

  /**
   * The attributes of a type whose single keys a `fields[<type>]` parameter accepts, each with the
   * pattern its key must match, and the paths into nested objects it accepts. Every operation
   * rendering the type carries the same parameter, so the first that accepts any key answers.
   * Returns `undefined` when none does.
   */
  private nestedFieldsets(wireType: string): NestedFieldsets | undefined {
    for (const item of Object.values(this.paths)) {
      for (const op of Object.values(item) as (OperationObject | undefined)[]) {
        const keys = nestedFieldsetsOf(op, wireType)
        if (keys !== undefined) {
          return keys
        }
      }
    }
    return undefined
  }

  private operation(path: string, method: HttpMethod): OperationObject | undefined {
    return this.paths[path]?.[method]
  }

  /** The shared request document an operation's JSON:API body refs, through any narrowing of its `meta`. */
  private requestBodyRef(op: OperationObject | undefined): string | undefined {
    return this.sharedDocumentRef(
      op?.requestBody?.content?.['application/vnd.api+json']?.schema?.$ref,
    )
  }

  private okResponseRef(op: OperationObject | undefined): string | undefined {
    return this.sharedDocumentRef(
      op?.responses?.['200']?.content?.['application/vnd.api+json']?.schema?.$ref,
    )
  }
}

/** A parsed linkage identifier: its type(s) and the schema nodes typing its `meta`. */
interface LinkageEntry {
  types: string[]
  polymorphic: boolean
  /** The `meta.pivot` schema node. */
  pivot?: SchemaObject
  /** The `$ref` to the `<Type><Rel>IdentifierMeta` component typing the declared meta members. */
  identifierMeta?: SchemaObject
}

/**
 * The schema nodes typing an identifier's `meta`, from the `allOf` narrowing it: `meta` is an
 * object with a `pivot`, a `$ref` to the declared identifier meta, or an `allOf` of the two.
 */
function metaNodesFromAllOf(
  allOf: readonly SchemaObject[],
  schemas: Readonly<Record<string, SchemaObject>>,
): {
  pivot?: SchemaObject
  identifierMeta?: SchemaObject
} {
  for (const entry of allOf) {
    const meta = entry.properties?.['meta']
    if (isSchema(meta)) {
      return metaNodes(meta, schemas)
    }
  }
  return {}
}

/**
 * The `pivot` and declared identifier meta nodes of an identifier's `meta`. A `$ref` to the
 * declared identifier meta may list `pivot` among its own properties.
 */
function metaNodes(
  meta: SchemaObject,
  schemas: Readonly<Record<string, SchemaObject>>,
): { pivot?: SchemaObject; identifierMeta?: SchemaObject } {
  const out: { pivot?: SchemaObject; identifierMeta?: SchemaObject } = {}
  const pivot = meta.properties?.['pivot']
  if (isSchema(pivot)) {
    out.pivot = pivot
  }
  if (typeof meta.$ref === 'string') {
    out.identifierMeta = meta
    const declared = schemas[refName(meta.$ref) ?? '']?.properties?.['pivot']
    if (out.pivot === undefined && isSchema(declared)) {
      out.pivot = declared
    }
  }
  for (const part of meta.allOf ?? []) {
    const nested = metaNodes(part, schemas)
    if (out.pivot === undefined && nested.pivot !== undefined) {
      out.pivot = nested.pivot
    }
    if (out.identifierMeta === undefined && nested.identifierMeta !== undefined) {
      out.identifierMeta = nested.identifierMeta
    }
  }
  return out
}

/** The `meta.pivot` schema node of a pivot `allOf` entry list, if any. */
function pivotNodeFromAllOf(
  allOf: readonly SchemaObject[],
  schemas: Readonly<Record<string, SchemaObject>>,
): SchemaObject | undefined {
  return metaNodesFromAllOf(allOf, schemas).pivot
}

/**
 * The `meta.pivot` schema node of a relationship component or document: its to-many `items`
 * `allOf`, or a to-one `anyOf` entry's `allOf`.
 */
function pivotNodeOf(
  component: SchemaObject,
  schemas: Readonly<Record<string, SchemaObject>>,
): SchemaObject | undefined {
  const data = component.properties?.['data']
  if (!isSchema(data)) {
    return undefined
  }
  if (Array.isArray(data.items?.allOf)) {
    return pivotNodeFromAllOf(data.items.allOf, schemas)
  }
  for (const entry of data.anyOf ?? []) {
    if (Array.isArray(entry.allOf)) {
      return pivotNodeFromAllOf(entry.allOf, schemas)
    }
  }
  return undefined
}

/** A `type` discriminator's mapping, inverted to the wire type each `$ref` stands for. */
function discriminatorTypesByRef(schema: SchemaObject): Map<string, string> {
  const byRef = new Map<string, string>()
  const discriminator = schema['discriminator']
  if (typeof discriminator !== 'object' || discriminator === null) {
    return byRef
  }
  const { propertyName, mapping } = discriminator as { propertyName?: unknown; mapping?: unknown }
  if (propertyName !== 'type' || typeof mapping !== 'object' || mapping === null) {
    return byRef
  }
  for (const [type, ref] of Object.entries(mapping)) {
    if (typeof ref === 'string') {
      byRef.set(ref, type)
    }
  }
  return byRef
}

/** Whether a schema admits `null`: a `null` type, or a `null` branch in `anyOf`/`oneOf`. */
function isNullable(schema: SchemaObject): boolean {
  const type = schema.type
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) {
    return true
  }
  return [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].some((branch) => branch.type === 'null')
}

/**
 * The literals a meta member lists: a list's for its items when its hint is `array`, else its own.
 * See {@link literalValues} and {@link listValues}.
 */
function memberValues(
  schema: SchemaObject,
  hint: string,
  schemas: Record<string, SchemaObject>,
): MetaLiteral[] | undefined {
  return hint === 'array' ? listValues(schema, schemas) : literalValues(schema, schemas)
}

/**
 * The literals every item of a list limits itself to, read from its `items` as
 * {@link literalValues} reads a value, following a `$ref`, a lone `allOf` and the one non-null
 * branch of a nullable `anyOf` or `oneOf` to the list. `undefined` when its items take other
 * values, `null` among them.
 */
function listValues(
  schema: SchemaObject,
  schemas: Record<string, SchemaObject>,
  seen: ReadonlySet<string> = new Set(),
): MetaLiteral[] | undefined {
  if (typeof schema.$ref === 'string') {
    const target = refName(schema.$ref)
    const resolved = target === undefined || seen.has(target) ? undefined : schemas[target]
    return resolved === undefined
      ? undefined
      : listValues(resolved, schemas, new Set([...seen, target!]))
  }
  if (schema.allOf?.length === 1) {
    return listValues(schema.allOf[0]!, schemas, seen)
  }
  const items = schema.items
  if (typeKeys(schema.type).includes('array') && isSchema(items)) {
    const takesNull = (node: SchemaObject): boolean =>
      isNullable(node) ||
      node.const === null ||
      (Array.isArray(node.enum) && node.enum.includes(null)) ||
      [...(node.anyOf ?? []), ...(node.oneOf ?? [])].some(takesNull)
    return takesNull(items) ? undefined : literalValues(items, schemas)
  }
  const branches = (schema.anyOf ?? schema.oneOf ?? []).filter((branch) => branch.type !== 'null')
  return branches.length === 1 ? listValues(branches[0]!, schemas, seen) : undefined
}

/**
 * The literals a schema limits its value to, from its `enum` or `const`, following a `$ref` to an
 * enum component and the non-null branches of an `anyOf` or `oneOf` when each lists its own.
 * `null` is left out, since nullability is recorded on its own. `undefined` when the value isn't
 * limited to literals.
 */
function literalValues(
  schema: SchemaObject,
  schemas: Record<string, SchemaObject>,
  seen: ReadonlySet<string> = new Set(),
): MetaLiteral[] | undefined {
  const isLiteral = (value: unknown): value is MetaLiteral =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  const listed = (candidates: readonly unknown[]): MetaLiteral[] | undefined => {
    const present = candidates.filter((value) => value !== null)
    return present.length > 0 && present.every(isLiteral) ? present : undefined
  }
  if (Array.isArray(schema.enum)) {
    return listed(schema.enum)
  }
  if ('const' in schema) {
    return listed([schema['const']])
  }
  if (typeof schema.$ref === 'string') {
    const target = refName(schema.$ref)
    const resolved = target === undefined || seen.has(target) ? undefined : schemas[target]
    return resolved === undefined
      ? undefined
      : literalValues(resolved, schemas, new Set([...seen, target!]))
  }
  if (schema.allOf?.length === 1) {
    return literalValues(schema.allOf[0]!, schemas, seen)
  }
  const branches = (schema.anyOf ?? schema.oneOf ?? []).filter(
    (branch) => !(branch.type === 'null' || (branch.const === null && branch.enum === undefined)),
  )
  if (branches.length === 0) {
    return undefined
  }
  const values: MetaLiteral[] = []
  for (const branch of branches) {
    const own = literalValues(branch, schemas, seen)
    if (own === undefined) {
      return undefined
    }
    values.push(...own.filter((value) => !values.includes(value)))
  }
  return values
}

/**
 * A schema's wire format hint: explicit `format`, else the JSON type, else a ref-enum is `string`.
 * A value of several JSON types, as a `type` list or a `oneOf` of them, has no one hint and is
 * `unknown`, since a `format` there scopes to its string member only. A `$ref` to a named shape
 * (generator contract 32) takes its component's hint.
 */
function formatHint(
  schema: SchemaObject,
  schemas: Record<string, SchemaObject>,
  seen: ReadonlySet<string> = new Set(),
): string {
  const types = typeKeys(schema.type)
  if (types.length > 1) {
    return 'unknown'
  }
  if (typeof schema.format === 'string') {
    return schema.format
  }
  if (types.length > 0) {
    return types[0]!
  }
  // A $ref to an enum component renders as a string union.
  if (typeof schema.$ref === 'string') {
    const target = refName(schema.$ref)
    const resolved = target === undefined || seen.has(target) ? undefined : schemas[target]
    if (target !== undefined && resolved !== undefined && !Array.isArray(resolved.enum)) {
      return formatHint(resolved, schemas, new Set([...seen, target]))
    }
    return 'string'
  }
  // A nullable `$ref` is `anyOf: [{ $ref }, { type: 'null' }]`: hint the value branch.
  const isNullOnly = (branch: SchemaObject): boolean =>
    branch.type !== undefined && typeKeys(branch.type).length === 0
  const branches = (schema.anyOf ?? schema.oneOf ?? []).filter((branch) => !isNullOnly(branch))
  if (branches.length === 1) {
    return formatHint(branches[0]!, schemas, seen)
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

/** The schema of the operation's parameter of that name, if it carries one. */
function paramSchema(op: OperationObject | undefined, paramName: string): SchemaObject | undefined {
  return op?.parameters?.find((param) => param.name === paramName)?.schema
}

/** The keys and nested paths a type's `fields[<type>]` parameter accepts, by attribute. */
interface NestedFieldsets {
  keys: Record<string, string>
  paths?: Record<string, string[][]>
}

/**
 * The attributes whose single keys an operation's `fields[<type>]` parameter accepts. Its items are
 * either the member enum or an `anyOf` of that enum and one pattern per such attribute,
 * `^<attribute>\.<key>$`, then one per path into a nested object, `^<attribute>\.<key>\.<key>$`.
 * A pattern names its attribute by the escaped name of an enum member, and what follows the dot
 * splits into one pattern per key at each `\.` outside a group or class. Returns `undefined` when
 * the items list no pattern.
 */
function nestedFieldsetsOf(
  op: OperationObject | undefined,
  wireType: string,
): NestedFieldsets | undefined {
  const branches = paramSchema(op, `fields[${wireType}]`)?.items?.anyOf
  if (branches === undefined) {
    return undefined
  }
  const members = branches.flatMap((branch) =>
    Array.isArray(branch.enum) ? branch.enum.filter((v): v is string => typeof v === 'string') : [],
  )
  const keys: Record<string, string> = {}
  const paths: Record<string, string[][]> = {}
  for (const branch of branches) {
    const pattern = branch['pattern']
    if (typeof pattern !== 'string' || !pattern.endsWith('$')) {
      continue
    }
    for (const member of members) {
      const head = `^${escapePattern(member)}\\.`
      if (pattern.startsWith(head) && pattern.length > head.length + 1) {
        const segments = keySegments(pattern.slice(head.length, -1))
        if (segments.length === 1) {
          keys[member] ??= segments[0]!
        } else {
          ;(paths[member] ??= []).push(segments)
        }
        break
      }
    }
  }
  if (Object.keys(keys).length === 0) {
    return undefined
  }
  const nested = Object.fromEntries(
    Object.entries(paths).filter(([attribute]) => keys[attribute] !== undefined),
  )
  return Object.keys(nested).length > 0 ? { keys, paths: nested } : { keys }
}

/** A key path pattern split at each `\.` that stands outside a group or a character class. */
function keySegments(pattern: string): string[] {
  const segments: string[] = []
  let depth = 0
  let inClass = false
  let start = 0
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '\\') {
      if (pattern[i + 1] === '.' && depth === 0 && !inClass) {
        segments.push(pattern.slice(start, i))
        start = i + 2
      }
      i++
    } else if (inClass) {
      inClass = char !== ']'
    } else if (char === '[') {
      inClass = true
    } else if (char === '(') {
      depth++
    } else if (char === ')') {
      depth--
    }
  }
  segments.push(pattern.slice(start))
  return segments
}

/** A literal escaped for an ECMA-262 pattern, the way the server escapes an attribute name. */
function escapePattern(literal: string): string {
  return literal.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
}

/** The sort keys and families a relation's own reads accept, read off `op`. */
function sortQueries(
  op: OperationObject | undefined,
): Pick<RelationDescriptor, 'sortable' | 'sortFamilies'> {
  const out: Pick<RelationDescriptor, 'sortable' | 'sortFamilies'> = {}
  const sortable = sortTokens(op)
  if (sortable !== undefined) {
    out.sortable = sortable
  }
  const sortFamilies = sortFamiliesOf(op)
  if (sortFamilies !== undefined) {
    out.sortFamilies = sortFamilies
  }
  return out
}

/** The filter keys, list filters and filter families a relation's own reads accept, read off `op`. */
function filterQueries(
  op: OperationObject | undefined,
): Pick<RelationDescriptor, 'filterable' | 'listFilters' | 'filterFamilies'> {
  const out: Pick<RelationDescriptor, 'filterable' | 'listFilters' | 'filterFamilies'> = {}
  const filterable = filterKeys(op)
  if (filterable !== undefined) {
    out.filterable = filterable
  }
  const listFilters = listFilterKeys(op)
  if (listFilters !== undefined) {
    out.listFilters = listFilters
  }
  const filterFamilies = filterFamiliesOf(op)
  if (filterFamilies !== undefined) {
    out.filterFamilies = filterFamilies
  }
  return out
}

/**
 * What an operation says about its sorts, as a string to compare two reads by: the keys, the
 * families with their descriptions, and what each key orders by. The sort `default`, a relation's
 * read order, is left out because the descriptor doesn't carry it.
 */
function sortVocabulary(op: OperationObject | undefined): string {
  const schema = paramSchema(op, 'sort')
  return JSON.stringify([
    sortTokens(op) ?? [],
    schema?.['x-sort-families'] ?? [],
    schema?.['x-sort-descriptions'] ?? {},
  ])
}

/**
 * What an operation says about its filters, as a string to compare two reads by: the keys, the list
 * filters, the families with their descriptions and examples, and each filter's default.
 */
function filterVocabulary(op: OperationObject | undefined): string {
  const defaults: [string, unknown][] = []
  for (const param of op?.parameters ?? []) {
    const key = filterParamKey(param)
    if (key !== undefined && param.schema !== undefined && 'default' in param.schema) {
      defaults.push([key, param.schema['default']])
    }
  }
  // oxlint-disable-next-line no-array-sort -- sorting a freshly-built array
  defaults.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify([
    filterKeys(op) ?? [],
    listFilterKeys(op) ?? [],
    paramSchema(op, 'filter')?.['x-filter-families'] ?? [],
    defaults,
  ])
}

/**
 * The fixed sort tokens an operation's `sort` parameter accepts: `schema.items.enum`, or the enum
 * branch of `schema.items.anyOf` when the parameter also accepts sort families. Returns
 * `undefined` when the operation takes no `sort` or no fixed keys.
 */
function sortTokens(op: OperationObject | undefined): readonly string[] | undefined {
  const items = paramSchema(op, 'sort')?.items
  const branches = items?.anyOf ?? (items === undefined ? [] : [items])
  const tokens = branches.flatMap((branch) =>
    Array.isArray(branch.enum) ? branch.enum.filter((v): v is string => typeof v === 'string') : [],
  )
  return tokens.length > 0 ? tokens : undefined
}

/**
 * The sort families an operation's `sort` parameter accepts, from its `x-sort-families`, or
 * `undefined` when it lists none.
 */
function sortFamiliesOf(
  op: OperationObject | undefined,
): readonly SortFamilyDescriptor[] | undefined {
  const declared = paramSchema(op, 'sort')?.['x-sort-families']
  if (!Array.isArray(declared)) {
    return undefined
  }
  const families: SortFamilyDescriptor[] = []
  for (const family of declared) {
    if (typeof family.prefix === 'string' && typeof family.suffixPattern === 'string') {
      families.push({ prefix: family.prefix, suffixPattern: family.suffixPattern })
    }
  }
  return families.length > 0 ? families : undefined
}

/**
 * The string members of an array-valued query parameter's `schema.items.enum` (the shape the
 * `include` parameter uses). Returns `undefined` when the operation carries no parameter of
 * that name, or one whose schema declares no enum.
 */
function paramItemsEnum(
  op: OperationObject | undefined,
  paramName: string,
): readonly string[] | undefined {
  const enumValues = paramSchema(op, paramName)?.items?.enum
  return Array.isArray(enumValues)
    ? enumValues.filter((v): v is string => typeof v === 'string')
    : undefined
}

/**
 * True for the Atomic Operations ext media type — `application/vnd.api+json` carrying the
 * atomic `ext` parameter ({@link ATOMIC_EXT}). Tolerant of quoting/whitespace so any of
 * `ext="…"` / `ext=…` matches.
 */
function isAtomicMediaType(mediaType: string): boolean {
  return mediaType.startsWith(JSON_API_MEDIA_TYPE) && mediaType.includes(ATOMIC_EXT)
}

/** Whether a media type is JSON:API, with or without `ext` / `profile` parameters. */
function isJsonApiMediaType(mediaType: string): boolean {
  return mediaType.split(';')[0]!.trim().toLowerCase() === JSON_API_MEDIA_TYPE
}

/** Whether a non-JSON:API media type carries JSON: `application/json` or a `+json` suffix. */
function isJsonMediaType(mediaType: string): boolean {
  const essence = mediaType.split(';')[0]!.trim().toLowerCase()
  return essence === 'application/json' || essence.endsWith('+json')
}

/**
 * The keys of an operation's `filter[<key>]` query parameters, sorted, or `undefined` when it
 * takes none. A list filter's `filter[<key>][]` parameter names its key in `x-filter-list`, so a
 * filter that takes both forms is one key.
 */
function filterKeys(op: OperationObject | undefined): readonly string[] | undefined {
  const keys = new Set<string>()
  for (const param of op?.parameters ?? []) {
    const key = filterParamKey(param)
    if (key !== undefined) {
      keys.add(key)
    }
  }
  // oxlint-disable-next-line no-array-sort -- sorting a freshly-created key array
  return keys.size > 0 ? [...keys].sort() : undefined
}

/** The filter key a `filter[...]` parameter carries, or `undefined` for any other parameter. */
export function filterParamKey(param: ParameterObject): string | undefined {
  const list = param['x-filter-list']
  if (typeof list?.key === 'string') {
    return list.key
  }
  const name = param.name
  return typeof name === 'string' &&
    name.startsWith('filter[') &&
    name.endsWith(']') &&
    !name.endsWith('][]')
    ? name.slice('filter['.length, -1)
    : undefined
}

/**
 * The keys of an operation's filters that take a list, read from the `x-filter-list` of their
 * `filter[<key>][]` parameters, sorted, or `undefined` when none does.
 */
function listFilterKeys(op: OperationObject | undefined): readonly string[] | undefined {
  const keys = (op?.parameters ?? []).flatMap((param) => {
    const key = param['x-filter-list']?.key
    return typeof key === 'string' ? [key] : []
  })
  // oxlint-disable-next-line no-array-sort -- sorting a freshly-created key array
  return keys.length > 0 ? keys.sort() : undefined
}

/**
 * The filter families an operation accepts, from the `x-filter-families` of its `filter`
 * parameter: each a key prefix, the pattern its suffix must match, and whether it takes a list.
 * Returns `undefined` when it lists none.
 */
function filterFamiliesOf(
  op: OperationObject | undefined,
): readonly FilterFamilyDescriptor[] | undefined {
  const declared = paramSchema(op, 'filter')?.['x-filter-families']
  if (!Array.isArray(declared)) {
    return undefined
  }
  const families: FilterFamilyDescriptor[] = []
  for (const family of declared) {
    if (typeof family.prefix === 'string' && typeof family.suffixPattern === 'string') {
      families.push(
        family.list === true
          ? { prefix: family.prefix, suffixPattern: family.suffixPattern, list: true }
          : { prefix: family.prefix, suffixPattern: family.suffixPattern },
      )
    }
  }
  return families.length > 0 ? families : undefined
}

/** The HTTP methods an action operation may be advertised under, in resolution preference order. */
const ACTION_METHODS: readonly HttpMethod[] = ['post', 'get', 'put', 'patch', 'delete']

/**
 * The operations an action is invoked over, the preferred one first: POST when advertised (the
 * common default), else the first advertised method. The other methods follow only when their
 * `operationId` differs from the preferred one's, as contract 15 makes it for an action answering
 * to several methods. An older document gave every method one id, and its client exposed only the
 * preferred one. Empty when the path item carries no operation at all.
 */
function pickOperations(item: PathItemObject): { method: HttpMethod; op: OperationObject }[] {
  const available = ACTION_METHODS.filter((method) => item[method] !== undefined)
  const preferred = available.includes('post') ? 'post' : available[0]
  if (preferred === undefined) {
    return []
  }
  const first = item[preferred]!
  const out = [{ method: preferred, op: first }]
  for (const method of available) {
    const op = item[method]!
    if (method !== preferred && op.operationId !== first.operationId) {
      out.push({ method, op })
    }
  }
  return out
}

/**
 * The name a multi-method action's other methods go under: the action's name and the method,
 * joined the way the name joins its words. So `export` gives `exportGet` and `bulk-import` gives
 * `bulk-import-get`. Core refuses action ids that differ only in case or punctuation, so the
 * name can't clash with another action's.
 */
function methodActionName(name: string, method: HttpMethod): string {
  const separator = /[-_.]/.exec(name)?.[0]
  return separator === undefined
    ? `${name}${method[0]!.toUpperCase()}${method.slice(1)}`
    : `${name}${separator}${method}`
}

/** The body shape a custom action accepts: a JSON:API document, none, or a raw payload. */
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

/**
 * What a custom action returns: a `meta`-only document when every 2xx JSON:API document is the
 * shared `MetaDocument` or narrows it, a resource `document` when any is another JSON:API body, a
 * `location` when the first offers only a location document, or `none` (only a `204`).
 */
function actionOutput(
  op: OperationObject,
  isMetaDocument: (ref: string | undefined) => boolean,
): ActionDescriptor['output'] {
  const schema = okJsonApiSchema(op)
  if (schema === undefined) {
    return 'none'
  }
  const arm = documentArms(schema)[0]
  if (arm === undefined) {
    return locationMediaType(schema) === undefined ? 'document' : 'location'
  }
  const arms: SchemaObject[] = []
  for (const [code, response] of Object.entries(op.responses ?? {})) {
    const body = isResultStatus(code) ? response.content?.[JSON_API_MEDIA_TYPE]?.schema : undefined
    const first = body === undefined ? undefined : documentArms(body)[0]
    if (first !== undefined) {
      arms.push(first)
    }
  }
  return arms.every((entry) => isMetaDocument(entry.$ref)) ? 'meta' : 'document'
}

/**
 * Whether a status answers with the operation's result: any `2xx` but a `202`, whose body is the
 * job of a write accepted for later.
 */
export function isResultStatus(code: string): boolean {
  return code.startsWith('2') && code !== '202'
}

/** The JSON:API schema of an operation's first success response that declares one. */
function okJsonApiSchema(op: OperationObject): SchemaObject | undefined {
  for (const [code, response] of Object.entries(op.responses ?? {})) {
    if (!isResultStatus(code)) {
      continue
    }
    const schema = response.content?.[JSON_API_MEDIA_TYPE]?.schema
    if (schema !== undefined) {
      return schema
    }
  }
  return undefined
}

/** Whether a schema is a location document: a `$ref` to `LocationDocument`, or an `allOf` with one. */
function isLocationSchema(schema: SchemaObject): boolean {
  const isRef = (entry: SchemaObject) =>
    typeof entry.$ref === 'string' && refName(entry.$ref) === 'LocationDocument'
  return isRef(schema) || (schema.allOf?.some(isRef) ?? false)
}

/**
 * The documents a success response's schema offers besides a location document (generator
 * contract 17): each `oneOf` member that isn't one, or the schema itself when it isn't one.
 */
function documentArms(schema: SchemaObject): SchemaObject[] {
  const arms = schema.oneOf ?? [schema]
  return arms.filter((arm) => !isLocationSchema(arm))
}

/**
 * The media type a location document's `links.location.type` is fixed to (generator contract
 * 17), `application/octet-stream` when the schema fixes none, or `undefined` when the schema
 * offers no location document.
 */
function locationMediaType(schema: SchemaObject): string | undefined {
  const location = (schema.oneOf ?? [schema]).find(isLocationSchema)
  if (location === undefined) {
    return undefined
  }
  for (const entry of location.allOf ?? []) {
    const links = entry.properties?.['links']
    const link = isSchema(links) ? links.properties?.['location'] : undefined
    const type = isSchema(link) ? link.properties?.['type'] : undefined
    if (isSchema(type) && typeof type.const === 'string') {
      return type.const
    }
  }
  return 'application/octet-stream'
}

/** Build the {@link ApiDescriptor} from a parsed OpenAPI document. */
export function buildDescriptor(doc: OpenApiDocument): ApiDescriptor {
  return new DescriptorBuilder(doc).build()
}

/** The atomic relationship operation kind each relationship verb records. */
export const ATOMIC_RELATIONSHIP_KINDS = {
  add: 'Add',
  remove: 'Remove',
  replace: 'Update',
  set: 'Update',
} as const satisfies Record<keyof RelationMutations, string>

type AtomicRelationshipKind = (typeof ATOMIC_RELATIONSHIP_KINDS)[keyof RelationMutations]

/** The `const` a schema, or any `allOf` member of it, pins property `name` to. */
function pinned(schema: SchemaOrBool | undefined, name: string): unknown {
  if (!isSchema(schema)) {
    return undefined
  }
  const own = schema.properties?.[name]
  if (isSchema(own) && own.const !== undefined) {
    return own.const
  }
  for (const member of schema.allOf ?? []) {
    const value = pinned(member, name)
    if (value !== undefined) {
      return value
    }
  }
  return undefined
}

/**
 * The atomic relationship operation kinds a type has of its own, by relation and kind: the
 * components marked `x-request-meta` named `<Base><Rel>AtomicRelationship<Kind>Operation`, whose
 * `ref` pins the type and the relationship.
 */
export function atomicRelationshipOperations(
  schemas: Readonly<Record<string, SchemaObject>>,
  base: string,
  wireType: string,
): Map<string, Partial<Record<AtomicRelationshipKind, SchemaObject>>> {
  const out = new Map<string, Partial<Record<AtomicRelationshipKind, SchemaObject>>>()
  for (const [name, component] of Object.entries(schemas)) {
    const kind = /AtomicRelationship(Add|Update|Remove)Operation$/.exec(name)?.[1] as
      | AtomicRelationshipKind
      | undefined
    if (kind === undefined || !name.startsWith(base) || component['x-request-meta'] !== true) {
      continue
    }
    const ref = component.properties?.['ref']
    const relationship = pinned(ref, 'relationship')
    if (pinned(ref, 'type') !== wireType || typeof relationship !== 'string') {
      continue
    }
    out.set(relationship, { ...out.get(relationship), [kind]: component })
  }
  return out
}

/** Detect the server-level Atomic Operations capability (`null` when none). */
export function buildAtomic(doc: OpenApiDocument): AtomicDescriptor | null {
  return new DescriptorBuilder(doc).buildAtomic()
}

/**
 * Classify a page member set: `number`+`size` = `page`; `offset`+`limit` = `offset`; either
 * cursor bound (`after`/`before`) = `cursor` (link-driven); `number` alone = `fixed` (the
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
