/**
 * What a cached view is and what its data promises (design B1a and B1b).
 *
 * A cached query's key decodes into a {@link QueryDescription}: the read it is, its address and its
 * params. From a description and the descriptor, {@link viewShape} computes the {@link ViewShape}
 * its data promises at the top level and, recursively, at every included relation slot below it,
 * and {@link fits} says whether a member may enter a slot of that shape. {@link isComplete} and
 * {@link isUnfilteredUnsorted} answer the two questions B1b's automatic placement asks of a view.
 *
 * Internal groundwork for optimistic drafts and read coherence; nothing here is public API.
 *
 * @internal
 */
import type { ApiDescriptor, RelationDescriptor } from '@haddowg/json-api-client'
import type { Query } from '@tanstack/query-core'
import {
  INFINITE_SEGMENT,
  isScopeSegment,
  isSkippedSegment,
  type QueryKey,
  type ReadOperation,
} from './keys'
import { carriesData, identityOf, isRecord } from './identity'
import { isInfiniteValue } from './normalize'

// ── Decoding a cached query ────────────────────────────────────────────────────────────────

/** A `filter` and `sort` the Relationship Queries profile applies to one relation's members. */
export interface RelatedQueryEntry {
  readonly filter?: Readonly<Record<string, unknown>>
  readonly sort?: string | readonly string[]
}

/** The params a cached read was made with, as its key's trailing segment records them. */
export interface QueryParams {
  readonly filter?: Readonly<Record<string, unknown>>
  readonly sort?: string | readonly string[]
  readonly page?: Readonly<Record<string, unknown>>
  readonly include?: readonly string[]
  readonly fields?: Readonly<Record<string, readonly string[]>>
  readonly withCount?: readonly string[]
  readonly relatedQuery?: Readonly<Record<string, RelatedQueryEntry>>
}

/**
 * The typed decoded description of a cached query: which read it is, what it addresses, the
 * params it was made with, and whether it is infinite or skipped.
 *
 * @internal
 */
export interface QueryDescription {
  /** The scope the key is in, absent for an unscoped key. */
  readonly scope?: string
  /** The type the read addresses: the parent's type for a related or relationship read. */
  readonly type: string
  readonly operation: ReadOperation
  /** The addressed resource's id; absent for a list, a singleton, and a skipped read. */
  readonly id?: string
  /** The relation of a related or relationship read. */
  readonly rel?: string
  readonly params: QueryParams
  readonly infinite: boolean
  /** A skipped read (`skipToken`): it holds no data and carries no params. */
  readonly skipped: boolean
  /**
   * The types the view's members are: the read's own type, or for a related or relationship read
   * the relation's target types (several for a polymorphic relation).
   */
  readonly types: readonly string[]
  /** Whether the view's data is a collection (a list, or a to-many relation's read). */
  readonly collection: boolean
}

const READ_OPERATIONS: ReadonlySet<string> = new Set([
  'fetchMany',
  'fetchOne',
  'fetchRelated',
  'fetchRelationship',
])

/** A relation of `type` a read can address: declared, and not write-only. */
function readableRelation(
  descriptor: ApiDescriptor,
  type: string,
  rel: string,
): RelationDescriptor | undefined {
  const relation = descriptor[type]?.relations[rel]
  return relation === undefined || relation.writeOnly === true ? undefined : relation
}

/**
 * Decode a cached query (or its key) into its {@link QueryDescription}, or `undefined` for a key
 * that isn't one the binding builds for `descriptor`. Every key form `keyFor`, `infiniteKeyFor` and
 * the skipped reads produce round-trips: scoped or not, a singleton's (no id), a related or
 * relationship read's, an infinite read's (`'$infinite'` last) and a skipped read's
 * (`[type, operation, { $skip: true }, rel?]`, its skip segment compared by value).
 *
 * @internal
 */
export function describeQuery(
  query: Pick<Query, 'queryKey'> | QueryKey | readonly unknown[],
  descriptor: ApiDescriptor,
): QueryDescription | undefined {
  const key: readonly unknown[] = Array.isArray(query)
    ? (query as readonly unknown[])
    : (query as Pick<Query, 'queryKey'>).queryKey
  let rest = key
  let scope: string | undefined
  if (isScopeSegment(rest[0])) {
    scope = rest[0].$scope
    rest = rest.slice(1)
  }
  const infinite = rest.at(-1) === INFINITE_SEGMENT
  if (infinite) {
    rest = rest.slice(0, -1)
  }
  const [type, operation] = rest
  if (typeof type !== 'string' || typeof operation !== 'string') {
    return undefined
  }
  const resource = descriptor[type]
  if (resource === undefined || !READ_OPERATIONS.has(operation)) {
    return undefined
  }
  const op = operation as ReadOperation
  if (infinite && op !== 'fetchMany' && op !== 'fetchRelated') {
    return undefined
  }
  const relational = op === 'fetchRelated' || op === 'fetchRelationship'
  const singleton = resource.singleton === true

  let at = 2
  let id: string | undefined
  let rel: string | undefined
  let skipped = false
  if (isSkippedSegment(rest[at])) {
    skipped = true
    at++
  } else if (!singleton && op !== 'fetchMany') {
    const segment = rest[at]
    if (typeof segment !== 'string') {
      return undefined
    }
    id = segment
    at++
  }
  if (relational) {
    const segment = rest[at]
    if (typeof segment !== 'string') {
      return undefined
    }
    rel = segment
    at++
  }
  let params: QueryParams = {}
  if (!skipped && at < rest.length) {
    const segment = rest[at]
    if (!isRecord(segment) || isScopeSegment(segment)) {
      return undefined
    }
    params = decodeParams(segment)
    at++
  }
  if (at !== rest.length) {
    return undefined
  }

  let types: readonly string[] = [type]
  let collection = op === 'fetchMany'
  if (rel !== undefined) {
    const relation = readableRelation(descriptor, type, rel)
    if (relation === undefined) {
      return undefined
    }
    types = relation.types
    collection = relation.cardinality === 'many'
  }
  return {
    ...(scope === undefined ? {} : { scope }),
    type,
    operation: op,
    ...(id === undefined ? {} : { id }),
    ...(rel === undefined ? {} : { rel }),
    params,
    infinite,
    skipped,
    types,
    collection,
  }
}

/** A list param as a list: a comma-separated string split, an array's strings kept. */
function stringList(value: unknown): readonly string[] | undefined {
  if (typeof value === 'string') {
    return value === '' ? [] : value.split(',')
  }
  if (Array.isArray(value)) {
    return value.filter((member): member is string => typeof member === 'string')
  }
  return undefined
}

/** A `sort` as the key holds it: a string, or a list of strings. */
function sortParam(value: unknown): string | readonly string[] | undefined {
  return typeof value === 'string' ? value : stringList(value)
}

/** The typed params of a key's trailing (normalised) segment; unknown members are dropped. */
function decodeParams(segment: Record<string, unknown>): QueryParams {
  const out: {
    -readonly [K in keyof QueryParams]: QueryParams[K]
  } = {}
  const { filter, sort, page, include, fields, withCount, relatedQuery } = segment
  if (isRecord(filter)) {
    out.filter = filter
  }
  const sorted = sortParam(sort)
  if (sorted !== undefined) {
    out.sort = sorted
  }
  if (isRecord(page)) {
    out.page = page
  }
  const included = stringList(include)
  if (included !== undefined) {
    out.include = included
  }
  if (isRecord(fields)) {
    const map: Record<string, readonly string[]> = {}
    for (const [type, members] of Object.entries(fields)) {
      const list = stringList(members)
      if (list !== undefined) {
        map[type] = list
      }
    }
    out.fields = map
  }
  const counted = stringList(withCount)
  if (counted !== undefined) {
    out.withCount = counted
  }
  if (isRecord(relatedQuery)) {
    const map: Record<string, RelatedQueryEntry> = {}
    for (const [rel, entry] of Object.entries(relatedQuery)) {
      if (!isRecord(entry)) {
        continue
      }
      const relSort = sortParam(entry['sort'])
      map[rel] = {
        ...(isRecord(entry['filter']) ? { filter: entry['filter'] } : {}),
        ...(relSort === undefined ? {} : { sort: relSort }),
      }
    }
    out.relatedQuery = map
  }
  return out
}

// ── The shape a view promises ──────────────────────────────────────────────────────────────

/** A slot that promises identifiers: any `{ type, id }` satisfies it. */
export interface IdentifiersShape {
  readonly kind: 'identifiers'
}

/**
 * A slot that promises resources: of one of `types`, each holding the attributes its type's
 * fieldset selects, and each included relation below it hydrated to its own shape.
 */
export interface ResourcesShape {
  readonly kind: 'resources'
  readonly types: ReadonlySet<string>
  /**
   * Per member type, the attribute keys a member must hold: those `fields[type]` selects when the
   * view gives a fieldset for the type, else every attribute the descriptor declares. An attribute
   * the fieldset narrows to some of its keys (`credits.producer`) counts as selected.
   */
  readonly attributes: ReadonlyMap<string, ReadonlySet<string>>
  /** The included relations below this slot (the first segment of each include path), by name. */
  readonly relations: ReadonlyMap<string, ResourcesShape>
  /**
   * Per member type, the relations a member of that type renders: declared, readable, and selected
   * by `fields[type]` when the view gives one. A relation in {@link relations} applies only to the
   * member types rendering it.
   */
  readonly rendered: ReadonlyMap<string, ReadonlySet<string>>
}

/** The shape a view promises at one slot. */
export type ViewShape = IdentifiersShape | ResourcesShape

/** The identifiers shape (relationship reads, and relation slots not included). */
export const IDENTIFIERS: IdentifiersShape = Object.freeze({ kind: 'identifiers' })

/**
 * The shape a view's data promises at the top level: identifiers for a relationship read, else
 * resources of the view's {@link QueryDescription.types} with its `fields` and its `include` paths
 * hydrated below. A skipped read is described by the same shape as the read it stands in for.
 *
 * @internal
 */
export function viewShape(description: QueryDescription, descriptor: ApiDescriptor): ViewShape {
  if (description.operation === 'fetchRelationship') {
    return IDENTIFIERS
  }
  return resourcesShape(
    description.types,
    description.params.include ?? [],
    description.params.fields,
    descriptor,
  )
}

/**
 * The resources shape of members of `types`, with `include` (dotted paths, relative to these
 * members) hydrated below and `fields` (the document-wide sparse fieldsets, by type) narrowing
 * every level.
 *
 * Key selections (the Field Selection profile's `fields[type]=credits.producer`) name the
 * attribute before the first full stop as selected: the member must hold `credits`, though it may
 * hold only some of its keys. Requiring the selected keys themselves would refuse a cached copy
 * holding the whole attribute, and the attribute's presence is what the view's type promises.
 *
 * @internal
 */
export function resourcesShape(
  types: readonly string[],
  include: readonly string[],
  fields: Readonly<Record<string, readonly string[]>> | undefined,
  descriptor: ApiDescriptor,
): ResourcesShape {
  const attributes = new Map<string, ReadonlySet<string>>()
  const rendered = new Map<string, ReadonlySet<string>>()
  for (const type of types) {
    const resource = descriptor[type]
    const declared = Object.keys(resource?.attributes ?? {})
    const readable = Object.entries(resource?.relations ?? {})
      .filter(([, relation]) => relation.writeOnly !== true)
      .map(([name]) => name)
    const fieldset = fields?.[type]
    if (fieldset === undefined) {
      attributes.set(type, new Set(declared))
      rendered.set(type, new Set(readable))
      continue
    }
    const selected = new Set(fieldset.map((member) => member.split('.')[0] ?? member))
    attributes.set(type, new Set(declared.filter((name) => selected.has(name))))
    rendered.set(type, new Set(readable.filter((name) => selected.has(name))))
  }

  // The include paths below, grouped by their first segment.
  const below = new Map<string, string[]>()
  for (const path of include) {
    const dot = path.indexOf('.')
    const head = dot < 0 ? path : path.slice(0, dot)
    const tail = dot < 0 ? undefined : path.slice(dot + 1)
    const paths = below.get(head) ?? []
    if (tail !== undefined && tail !== '') {
      paths.push(tail)
    }
    below.set(head, paths)
  }

  const relations = new Map<string, ResourcesShape>()
  for (const [rel, paths] of below) {
    // The relation's targets, over every member type that renders it.
    const targets = new Set<string>()
    for (const type of types) {
      if (rendered.get(type)?.has(rel) !== true) {
        continue
      }
      for (const target of descriptor[type]?.relations[rel]?.types ?? []) {
        targets.add(target)
      }
    }
    if (targets.size > 0) {
      relations.set(rel, resourcesShape([...targets], paths, fields, descriptor))
    }
  }
  return { kind: 'resources', types: new Set(types), attributes, relations, rendered }
}

/**
 * The shape of relation `rel` on a member of `type` in a slot of `shape`: the included shape when
 * the view includes it, {@link IDENTIFIERS} when the member renders it unincluded, and `undefined`
 * when the member doesn't render it (not declared, write-only, or left out of the fieldset). The
 * value a cached member holds there may still be `undefined` (a links-only relation), which no
 * shape describes: nothing is known of its membership.
 *
 * @internal
 */
export function slotShape(shape: ViewShape, type: string, rel: string): ViewShape | undefined {
  if (shape.kind === 'identifiers' || shape.rendered.get(type)?.has(rel) !== true) {
    return undefined
  }
  return shape.relations.get(rel) ?? IDENTIFIERS
}

/** Each type's declared relation names, by descriptor. */
const relationLists = new WeakMap<ApiDescriptor, Map<string, readonly string[]>>()

/**
 * Each type's declared relation names in `descriptor`, memoised.
 * @internal
 */
export function relationNames(descriptor: ApiDescriptor): (type: string) => readonly string[] {
  let names = relationLists.get(descriptor)
  if (names === undefined) {
    names = new Map()
    relationLists.set(descriptor, names)
  }
  const cache = names
  return (type) => {
    let list = cache.get(type)
    if (list === undefined) {
      list = Object.keys(descriptor[type]?.relations ?? {})
      cache.set(type, list)
    }
    return list
  }
}

/** The objects a walk has reached. @internal */
export interface Seen {
  has(value: object): boolean
  add(value: object): void
}

/**
 * A visitor of each resource a walk reaches, with its type, id, the shape of its slot, and what the
 * visitor returned for the resource whose slot `rel` it was reached through. What it returns is
 * handed on to the resources below.
 * @internal
 */
export type Visitor<T> = (
  node: Record<string, unknown>,
  type: string,
  id: string,
  shape: ViewShape | undefined,
  from: T | undefined,
  rel: string | undefined,
) => T

/**
 * Walk a cached value (a resource, an array, an infinite query's data, whose every page it walks,
 * or `null`/`undefined`), visiting every reachable resource once, with the shape of the slot it was
 * reached in: `shape` at the top (every page of an infinite query shares it), and below each
 * resource the {@link slotShape} of the relation it sits in. Only declared relation slots are
 * followed. A slot whose shape the view doesn't describe (a relation its fieldset leaves out, held
 * anyway) is walked with an `undefined` shape, as is everything when `shape` is `undefined`.
 *
 * A resource reached twice is visited only the first time, with the shape it was first reached in;
 * `again` is told of each object reached after its first time.
 * @internal
 */
export function walkGraph<T>(
  value: unknown,
  shape: ViewShape | undefined,
  relations: (type: string) => readonly string[],
  seen: Seen,
  visit: Visitor<T>,
  again?: (value: object) => void,
  from?: T,
  rel?: string,
): void {
  if (value === null || value === undefined || typeof value !== 'object') {
    return
  }
  if (Array.isArray(value)) {
    for (const member of value) {
      walkGraph(member, shape, relations, seen, visit, again, from, rel)
    }
    return
  }
  if (seen.has(value)) {
    again?.(value)
    return
  }
  seen.add(value)
  const node = value as Record<string, unknown>
  const { type, id } = node
  if (typeof type !== 'string' || typeof id !== 'string') {
    if (isInfiniteValue(value)) {
      for (const page of value.pages) {
        walkGraph(page, shape, relations, seen, visit, again, from, rel)
      }
    }
    return
  }
  const token = visit(node, type, id, shape, from, rel)
  for (const name of relations(type)) {
    const slot = node[name]
    if (slot !== undefined) {
      const below = shape === undefined ? undefined : slotShape(shape, type, name)
      walkGraph(slot, below, relations, seen, visit, again, token, name)
    }
  }
}

/**
 * {@link walkGraph} with a visitor of each resource and its slot's shape alone.
 * @internal
 */
export function walkShaped(
  value: unknown,
  shape: ViewShape | undefined,
  descriptor: ApiDescriptor,
  visit: (node: Record<string, unknown>, shape: ViewShape | undefined) => void,
  seen: Seen = new Set(),
): void {
  walkGraph(value, shape, relationNames(descriptor), seen, (node, _type, _id, slot) => {
    visit(node, slot)
  })
}

// ── Fit ────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether a member is a resource rather than a bare identifier: a materialised resource (it
 * carries `$raw`), or a plain object holding a key beyond `type`, `id`, `lid`, `meta` and the
 * `$`-prefixed accessors. A plain `{ type, id }` of a type with no attributes therefore never fills
 * a resources slot, which is the safe side of the ambiguity.
 */
function isResource(member: Record<string, unknown>): boolean {
  if ((member as { $raw?: unknown }).$raw !== undefined) {
    return true
  }
  return carriesData(member)
}

const hasOwnEnumerable = (target: object, key: string): boolean =>
  Object.prototype.propertyIsEnumerable.call(target, key)

/**
 * Whether `member` may enter a slot of `shape` (B1a: "the member satisfies a destination when it
 * holds every attribute key the destination's fieldset selects, and, recursively, every included
 * relation below that destination is itself satisfied; identifier destinations are always
 * satisfied by `{ type, id }`").
 *
 * - An identifiers shape accepts anything carrying a string `type` and `id`.
 * - A resources shape accepts a resource (never a bare identifier) whose `type` is among the
 *   shape's types, which holds every required attribute of that type as an own enumerable key, and
 *   whose every included relation its type renders is present in the right form and fits in turn:
 *   a to-one holds `null` or a fitting member, a to-many an array of fitting members. A relation
 *   slot that is `undefined` (absent, or links-only) does not fit an included relation.
 *
 * @internal
 */
export function fits(member: unknown, shape: ViewShape, descriptor: ApiDescriptor): boolean {
  const identity = identityOf(member)
  if (identity === undefined) {
    return false
  }
  if (shape.kind === 'identifiers') {
    return true
  }
  const record = member as Record<string, unknown>
  if (!shape.types.has(identity.type) || !isResource(record)) {
    return false
  }
  for (const attribute of shape.attributes.get(identity.type) ?? []) {
    if (!hasOwnEnumerable(record, attribute)) {
      return false
    }
  }
  const rendered = shape.rendered.get(identity.type)
  for (const [rel, below] of shape.relations) {
    if (rendered?.has(rel) !== true) {
      continue
    }
    const value = record[rel]
    const cardinality = descriptor[identity.type]?.relations[rel]?.cardinality
    if (cardinality === 'many') {
      if (!Array.isArray(value) || !value.every((item) => fits(item, below, descriptor))) {
        return false
      }
    } else if (value !== null && !fits(value, below, descriptor)) {
      return false
    }
  }
  return true
}

// ── Completeness and placement ─────────────────────────────────────────────────────────────

/** Whether a materialised array's `$page` says there is no page after it. */
function lastPage(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false
  }
  const page = (value as { $page?: unknown }).$page
  if (!isRecord(page) || !isRecord(page['links'])) {
    return false
  }
  return typeof page['links']['next'] !== 'string'
}

/**
 * Whether a collection value holds the whole collection: a top-level collection, a related read or
 * a to-many slot inside a resource (an augmented array) whose `$page` carries no `next` link, or an
 * infinite query's data whose last loaded page carries none. An array without `$page` (nothing
 * says what it holds) and anything that isn't a collection answer `false`. An included to-many is
 * judged the same way, since it can itself be a first page only.
 *
 * @internal
 */
export function isComplete(collection: unknown): boolean {
  if (isInfiniteValue(collection)) {
    return collection.pages.length > 0 && lastPage(collection.pages.at(-1))
  }
  return lastPage(collection)
}

/** Whether a `sort` param orders anything. */
const sorts = (sort: string | readonly string[] | undefined): boolean =>
  sort !== undefined && sort.length > 0

/** Whether a `filter` param filters anything. */
const filters = (filter: Readonly<Record<string, unknown>> | undefined): boolean =>
  filter !== undefined && Object.keys(filter).length > 0

/**
 * Whether a view is unfiltered and unsorted, the first two conditions of B1b's automatic
 * placement: its params carry no `filter` and no explicit `sort`. With `relation`, the question is
 * asked of that relation's slot inside the view's resources instead: whether the view's
 * `relatedQuery` filters or sorts that relation's members.
 *
 * @internal
 */
export function isUnfilteredUnsorted(description: QueryDescription, relation?: string): boolean {
  if (relation !== undefined) {
    const entry = description.params.relatedQuery?.[relation]
    return !filters(entry?.filter) && !sorts(entry?.sort)
  }
  return !filters(description.params.filter) && !sorts(description.params.sort)
}
