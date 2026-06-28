/**
 * The write serialisation layer (CONTEXT.md "Write surface" + "Transport seam & error
 * model"; ADR 0001/0002). Two descriptor-aware inverses of the wire shape:
 *
 * - {@link toDocument} builds the JSON:API write document from the caller's FLAT input
 *   (the client owns the envelope), routing each key to `attributes` or `relationships`
 *   by the descriptor and coercing relationship linkage by cardinality;
 * - {@link remapPointer} / {@link withRemappedPaths} invert a write error's
 *   `source.pointer` back to that flat path so {@link JsonApiError.byPath} groups by the
 *   shape the caller actually supplied (form/validation UX).
 */
import type { ApiDescriptor } from './descriptor'
import { JsonApiError, type JsonApiErrorObject } from './errors'

/** Per-edge writable pivot data, supplied on a to-many member as the `$pivot` key. */
const PIVOT_KEY = '$pivot'

/** The reserved input keys never routed to attributes/relationships. */
const RESERVED_INPUT: ReadonlySet<string> = new Set(['type', 'id'])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A JSON:API resource identifier in a write document: `{ type, id }` or — inside an atomic
 * batch — `{ type, lid }` (a reference to a resource created earlier in the same transaction).
 * May carry writable pivot meta on a to-many member.
 */
interface WriteIdentifier {
  type: string
  id?: string
  lid?: string
  meta?: { pivot: Record<string, unknown> } & Record<string, unknown>
}

/** A relationship document: `{ data: <linkage> }`. */
export interface RelationshipDocument {
  data: WriteIdentifier | WriteIdentifier[] | null
}

/** The JSON:API write document {@link toDocument} produces. */
export interface WriteDocument {
  data: {
    type: string
    id?: string
    attributes?: Record<string, unknown>
    relationships?: Record<string, RelationshipDocument>
  }
}

/** Options for {@link toDocument}. */
export interface ToDocumentOptions {
  /**
   * The resource id, supplied for an UPDATE (it comes from the handle, not the input). When
   * present it is always written as `data.id`. Omit for a CREATE — then `input.id` is written
   * only per the type's `clientId` policy.
   */
  id?: string
}

/**
 * Build a JSON:API write document from FLAT input. Each input key is routed via the
 * descriptor: a declared relation -> `data.relationships[name] = { data: <linkage> }`;
 * anything else -> `data.attributes[name]`. Relationship linkage is coerced by cardinality:
 *
 * - to-one accepts an identifier `{type,id}`, a materialised resource object (its `{type,id}`
 *   are extracted), or `null` (-> `data: null`, clearing the relationship);
 * - to-many accepts an array of those; a member may carry a `$pivot` object, rendered as the
 *   member identifier's `meta.pivot` (writable pivot fields).
 *
 * `data.type` is always the accessor `type`. `data.id` is written from `opts.id` (an update),
 * else from `input.id` only when the type's `clientId` policy allows it (omitted when
 * `forbidden`, passed through when `optional`/`required`).
 */
export function toDocument(
  descriptor: ApiDescriptor,
  type: string,
  input: Record<string, unknown>,
  opts?: ToDocumentOptions,
): WriteDocument {
  const resource = descriptor[type]
  const relations = resource?.relations ?? {}

  const data: WriteDocument['data'] = { type }

  const id = resolveId(input, opts, resource?.clientId)
  if (id !== undefined) {
    data.id = id
  }

  const attributes: Record<string, unknown> = {}
  const relationships: Record<string, RelationshipDocument> = {}

  for (const [keyName, value] of Object.entries(input)) {
    if (RESERVED_INPUT.has(keyName)) {
      continue
    }
    const relation = relations[keyName]
    if (relation !== undefined) {
      relationships[keyName] = { data: coerceLinkage(value, relation.cardinality) }
    } else {
      attributes[keyName] = value
    }
  }

  if (Object.keys(attributes).length > 0) {
    data.attributes = attributes
  }
  if (Object.keys(relationships).length > 0) {
    data.relationships = relationships
  }

  return { data }
}

/**
 * Build a relationship-mutation document `{ data: <linkage> }` for the
 * `/{type}/{id}/relationships/{rel}` endpoints, coercing the caller's refs by cardinality:
 *
 * - to-one accepts an identifier `{type,id}`, a materialised resource object, or `null`
 *   (-> `data: null`, clearing the relationship);
 * - to-many accepts an array of those; a member may carry `$pivot`, rendered as the member
 *   identifier's `meta.pivot`.
 *
 * The same {@link coerceLinkage} the whole-resource writer uses, so a relationship written
 * standalone and one embedded in a resource serialise identically.
 */
export function toRelationshipDocument(
  refs: unknown,
  cardinality: 'one' | 'many',
): RelationshipDocument {
  return { data: coerceLinkage(refs, cardinality) }
}

/** Resolve the document id: an update's handle id always wins; a create honours the policy. */
function resolveId(
  input: Record<string, unknown>,
  opts: ToDocumentOptions | undefined,
  clientId: ApiDescriptor[string]['clientId'] | undefined,
): string | undefined {
  if (opts?.id !== undefined) {
    return opts.id
  }
  if (clientId === 'forbidden') {
    return undefined
  }
  const candidate = input['id']
  return typeof candidate === 'string' ? candidate : undefined
}

/** Coerce one relationship value to linkage by cardinality (array for to-many, identifier/null for to-one). */
function coerceLinkage(
  value: unknown,
  cardinality: 'one' | 'many',
): WriteIdentifier | WriteIdentifier[] | null {
  if (cardinality === 'many') {
    const members = Array.isArray(value) ? value : value == null ? [] : [value]
    return members.map((member) => toIdentifier(member))
  }
  if (value === null || value === undefined) {
    return null
  }
  return toIdentifier(value)
}

/**
 * Extract a resource identifier from a linkage input value: an identifier `{type,id}`, a
 * materialised resource object (the same `{type,id}` enumerable props), or — inside an atomic
 * batch — a local identifier `{type,lid}` referencing a just-created resource (the handle a
 * `tx.create` returns). A `$pivot` key is lifted onto `meta.pivot` (writable pivot fields).
 * Throws on a value carrying no `type`, or neither an `id` nor a `lid`.
 */
function toIdentifier(value: unknown): WriteIdentifier {
  if (!isObject(value)) {
    throw new TypeError(
      `Relationship linkage must be an identifier or resource object; received ${describe(value)}`,
    )
  }
  const { type, id, lid } = value
  if (typeof type !== 'string') {
    throw new TypeError('Relationship linkage requires a `type`')
  }
  // An `id` identifies an existing resource; a `lid` references one created earlier in the
  // same atomic transaction. Exactly one is needed.
  const identifier: WriteIdentifier =
    typeof id === 'string'
      ? { type, id }
      : typeof lid === 'string'
        ? { type, lid }
        : (() => {
            throw new TypeError('Relationship linkage requires an `id` or a `lid`')
          })()

  const pivot = value[PIVOT_KEY]
  if (isObject(pivot)) {
    identifier.meta = { pivot }
  }
  return identifier
}

const describe = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value

/**
 * Invert a write error's `source.pointer` to the caller's FLAT input path, descriptor-aware:
 *
 * - `/data/attributes/title`                                 -> `title`
 * - `/data/relationships/artist/data`                        -> `artist`
 * - `/data/id`                                               -> `id` (client-id create conflict)
 * - `/data/attributes/releaseInfo/label`                     -> `releaseInfo.label` (nested map)
 * - `/data/relationships/orderedTracks/data/0/meta/pivot/position` -> `orderedTracks[0].$pivot.position`
 *
 * Pivot values nest under a member's `meta.pivot` (symmetric with reads — see
 * `JsonPointerBuilder::forLinkageMeta` / bundle ADR 0103), so a `meta/pivot/<field>` tail on
 * a member of a pivot-bearing to-many is surfaced as `.$pivot.<field>`.
 *
 * A query-side pointer is left untouched (those are already user-facing — see
 * {@link withRemappedPaths}). An unrecognised / non-write pointer is returned verbatim.
 * `/data/type` and a bare `/data` are passed through (the client owns those; the caller
 * never supplies them).
 */
export function remapPointer(descriptor: ApiDescriptor, type: string, pointer: string): string {
  const segments = pointer.split('/').filter((s) => s !== '')
  if (segments[0] !== 'data') {
    return pointer
  }

  if (segments[1] === 'attributes') {
    return remapAttribute(segments.slice(2))
  }
  if (segments[1] === 'id') {
    return 'id'
  }
  if (segments[1] === 'relationships') {
    return remapRelationship(descriptor[type]?.relations ?? {}, segments.slice(2))
  }

  return pointer
}

/** `[releaseInfo, label]` -> `releaseInfo.label`; a bare `[title]` -> `title`. */
function remapAttribute(rest: readonly string[]): string {
  return rest.join('.')
}

/**
 * Remap a relationship pointer's tail (everything after `relationships/`, or — for a
 * relationship-endpoint document — the relation name spliced ahead of the `data` tail). The
 * leading segment is the relation name; a `data` segment is dropped; a numeric index becomes
 * `[n]`; a `meta/pivot/<field>` tail on a pivot-bearing relation becomes `.$pivot.<field>`. The
 * `relations` map tells us whether the relation carries pivot (so a member's `meta.pivot`
 * fields are the pivot data the bundle validates).
 */
function remapRelationship(
  relations: Readonly<Record<string, { pivot?: boolean }>>,
  rest: readonly string[],
): string {
  const name = rest[0]
  if (name === undefined) {
    return 'data/relationships'
  }
  const hasPivot = relations[name]?.pivot === true

  let path = name
  for (let i = 1; i < rest.length; i++) {
    const seg = rest[i]!
    if (seg === 'data') {
      continue
    }
    if (/^\d+$/.test(seg)) {
      path += `[${seg}]`
    } else if (seg === 'meta' && hasPivot && rest[i + 1] === 'pivot') {
      // Pivot values nest under `meta.pivot` (bundle ADR 0103) — collapse the
      // `meta/pivot` pair to `$pivot`; the offending field follows.
      path += '.$pivot'
      i++
    } else {
      path += `.${seg}`
    }
  }

  return path
}

/**
 * Invert a relationship-MUTATION error's `source.pointer` to the caller's flat path, for the
 * `/{type}/{id}/relationships/{rel}` endpoints. Two pointer shapes reach here:
 *
 * - the LINKAGE document shape (validation on the linkage members), rooted at `data` — the
 *   relation name is supplied by the route, not the wire:
 *   - `/data`                             -> `<rel>`                  (to-one clear/set)
 *   - `/data/meta/pivot/position`         -> `<rel>.$pivot.position`  (to-one pivot, rare)
 *   - `/data/0/meta/pivot/position`       -> `<rel>[0].$pivot.position`
 * - the RESOURCE-document shape that core's relationship prohibitions emit unchanged
 *   (`FullReplacementProhibited`/`RemovalProhibited`/`AdditionProhibited`/
 *   `RelationshipTypeInappropriate` all point at `/data/relationships/<name>`) — short-circuited
 *   to the relation name (drop the `relationships/<name>` prefix) rather than treating
 *   `relationships` as a linkage sub-segment.
 *
 * A non-`data` pointer is returned verbatim.
 */
export function remapRelationshipPointer(rel: string, hasPivot: boolean, pointer: string): string {
  const segments = pointer.split('/').filter((s) => s !== '')
  if (segments[0] !== 'data') {
    return pointer
  }
  // A resource-document relationship pointer (`/data/relationships/<name>...`): the route's
  // relation name owns the path; drop the `relationships/<name>` prefix (segments[2] is the
  // wire name, == the route `rel`) and remap the remaining tail under the route relation.
  const tail = segments[1] === 'relationships' ? segments.slice(3) : segments.slice(1)
  return remapRelationship({ [rel]: { pivot: hasPivot } }, [rel, ...tail])
}

/**
 * Return a {@link JsonApiError} with each error object's `path` populated by remapping its
 * `source.pointer` (descriptor-aware) — so {@link JsonApiError.byPath} groups by the flat input
 * shape. Errors with no write pointer (e.g. a `source.parameter` query-side error, or no
 * source) are passed through unchanged. The original error is not mutated.
 */
export function withRemappedPaths(
  error: JsonApiError,
  descriptor: ApiDescriptor,
  type: string,
): JsonApiError {
  return mapErrors(error, (pointer) => ({ path: remapPointer(descriptor, type, pointer) }))
}

/**
 * The relationship-mutation twin of {@link withRemappedPaths}: remap each error's pointer
 * keyed by the relation name from the route. Handles both the linkage-document shape (rooted
 * at `data`) and the resource-document shape core's prohibition exceptions emit
 * (`/data/relationships/<rel>`). `hasPivot` lets a member-level `meta` field surface as
 * `$pivot`. The original error is not mutated.
 */
export function withRemappedRelationshipPaths(
  error: JsonApiError,
  rel: string,
  hasPivot: boolean,
): JsonApiError {
  return mapErrors(error, (pointer) => ({ path: remapRelationshipPointer(rel, hasPivot, pointer) }))
}

/**
 * Invert an atomic-batch error's `source.pointer` to `(opIndex, flatPath)`: an atomic 422
 * points at `/atomic:operations/{n}/data/...`, so strip the `atomic:operations/{n}` prefix to
 * the op index, resolve that op's wire type (`typeForOp`), and delegate the remaining `/data`
 * tail to the same {@link remapPointer} a standalone write uses (so the flat path is identical
 * — `title`, `releaseInfo.label`, `artist`, …). A pointer without the atomic prefix is remapped
 * verbatim under the (whole-batch) document at op index `undefined`. The original error is not
 * mutated.
 */
export function withRemappedAtomicPaths(
  error: JsonApiError,
  descriptor: ApiDescriptor,
  typeForOp: (opIndex: number) => string | undefined,
): JsonApiError {
  return mapErrors(error, (pointer) => {
    const segments = pointer.split('/').filter((s) => s !== '')
    if (segments[0] !== 'atomic:operations' || segments[1] === undefined) {
      return { path: pointer }
    }
    const opIndex = Number(segments[1])
    if (!Number.isInteger(opIndex)) {
      return { path: pointer }
    }
    const type = typeForOp(opIndex)
    const tail = `/${segments.slice(2).join('/')}`
    const path = type === undefined ? tail : remapPointer(descriptor, type, tail)
    return { opIndex, path }
  })
}

/** What a per-error remap resolves to: the flat `path` and, for an atomic batch, the `opIndex`. */
interface RemapResult {
  path: string
  opIndex?: number
}

/** Shared error-mapper: clone each error with `path`/`opIndex` from its `source.pointer`, else pass through. */
function mapErrors(error: JsonApiError, remap: (pointer: string) => RemapResult): JsonApiError {
  const remapped: JsonApiErrorObject[] = error.errors.map((e) => {
    const pointer = e.source?.pointer
    if (pointer === undefined) {
      return e
    }
    const { path, opIndex } = remap(pointer)
    return opIndex === undefined ? { ...e, path } : { ...e, path, opIndex }
  })
  return new JsonApiError(error.status, remapped, error.message)
}
