import type {
  ApiDescriptor,
  PaginatorDescriptor,
  PaginatorKind,
  RelationDescriptor,
} from './descriptor'
import { type Page, type ResolvedPaginator, resolvePaginator } from './pagination'
import { type NestedFieldset, nestedFieldset } from './nested-fieldset'
import type { Document } from './request'
import { stampFromDocument } from './request-stamp'
import type { ResourceIdentifier } from './types'
import { assertJsonApiDocument, type ResolvedValidator, validateDocument } from './validate'

/** A trimmed, by-reference top-level envelope shared by every resource from one response. */
export interface DocumentEnvelope {
  jsonapi?: Record<string, unknown>
  meta?: Record<string, unknown>
  links?: Record<string, unknown>
}

/** A JSON:API link object. */
export interface LinkObject {
  href: string
  rel?: string
  describedby?: string | LinkObject
  title?: string
  type?: string
  hreflang?: string | string[]
  meta?: Record<string, unknown>
}

/**
 * A link as the wire carries it. A server renders the links it builds as link objects unless it
 * opts out to bare strings, and an author-supplied link keeps whichever shape it was given.
 */
export type Link = string | LinkObject

/** Resource-level links (`self` is the common one; the wire may carry more). */
export interface ResourceLinks {
  self?: Link
  [key: string]: unknown
}

/**
 * The relationship-instance envelope for a materialised related value (its `$edge`). `Meta`
 * types `meta` when the relation declares its identifier meta members.
 */
export interface Edge<Meta extends Record<string, unknown> = Record<string, unknown>> {
  links?: Record<string, unknown>
  meta?: Meta
}

/**
 * A member a cache layer (an optimistic draft in `@haddowg/json-api-query`) predicted for a
 * relation but couldn't show yet, because no copy of it fits the slot: its identifier, and the
 * member the write supplied when it supplied more than an identifier (a row the user picked, or a
 * new resource's create input), so a placeholder can show what is known of it.
 */
export interface PendingMember<TType extends string = string> extends ResourceIdentifier<TType> {
  /** The member the write supplied, when it carried more than its identifier. */
  readonly member?: Readonly<Record<string, unknown>>
}

/**
 * Where an optimistic create was placed in a list: first (`'start'`), last (`'end'`), or before
 * the member at an index of the list (of the page, in an infinite query's pages).
 */
export type PendingPlacement = 'start' | 'end' | number

/**
 * A create a cache layer placed in a list but couldn't show as a member, because the row it can
 * build from the create's input doesn't hold everything the list's members promise (an attribute
 * only the server sets, or an included resource that isn't cached). `input` is what the write sent
 * (`I` types it where the create input's type is known), `id` the id the row carries (the one sent,
 * or a temporary id swapped for the server's once the write succeeds), and `at` where in the list
 * it belongs.
 */
export interface PendingCreate<
  I = Readonly<Record<string, unknown>>,
  TType extends string = string,
> {
  readonly type: TType
  readonly id: string
  readonly at: PendingPlacement
  readonly input: I
}

/** The uniform shape `$rel(name)` returns. */
export interface RelationView {
  data?: unknown
  links?: Record<string, unknown>
  meta?: Record<string, unknown>
}

/** Non-enumerable envelope accessors shared by every materialised resource. */
export interface ResourceEnvelope {
  readonly $meta: Record<string, unknown> | undefined
  readonly $links: ResourceLinks | undefined
  /** The `self` link's href, whether the wire carried a bare URL or a link object. */
  readonly $self: string | undefined
  readonly $document: DocumentEnvelope
  readonly $raw: RawResource
  /**
   * The keys the request's sparse fieldset selected of each attribute it narrowed, under the Nested
   * Fieldsets profile. An attribute named here holds only those of its keys the resource has.
   */
  readonly $nestedFieldset: NestedFieldset
  $rel(name: string): RelationView | undefined
  /**
   * A relationship's count, from its `meta.total` (a `withCount` read): a finite number, else
   * `undefined`. Read from the raw relationship, so it works when the relation carries no data.
   */
  $count(name: string): number | undefined
  /**
   * `'pending'` while a cache layer holds an unconfirmed optimistic change to this resource (an
   * attribute it predicted, or a change to one of its relations), else `undefined`.
   */
  readonly $optimistic: 'pending' | undefined
  /**
   * The members a cache layer predicted for relation `name` but couldn't show yet, because no copy
   * of them fits the slot, each carrying the member the write supplied when it supplied one. Empty
   * when there are none.
   */
  $pending(name: string): readonly PendingMember[]
}

/** Edge-local accessors carried by a materialised related VALUE (per-edge view). */
export interface EdgeEnvelope {
  readonly $edge: Edge | undefined
  readonly $pivot: Record<string, unknown> | undefined
  /** `'pending'` while a cache layer holds an unconfirmed optimistic change to this member. */
  readonly $optimistic: 'pending' | undefined
}

/** Relationship-level accessors carried by an augmented to-many array. */
export interface ArrayEnvelope {
  readonly $page: Page
  readonly $links: Record<string, unknown> | undefined
  readonly $meta: Record<string, unknown> | undefined
  $next(options?: NavigateOptions): Promise<unknown>
  $prev(options?: NavigateOptions): Promise<unknown>
}

/** The accessor a to-many relationship array carries beside its {@link ArrayEnvelope}. */
export interface RelationArrayEnvelope {
  /** The relationship's count, from its `meta.total`: a finite number, else `undefined`. */
  readonly $count: number | undefined
}

/** Per-call options for `$next()`/`$prev()`. */
export interface NavigateOptions {
  /** Cancels the page fetch when signalled. */
  signal?: AbortSignal
}

/** The runtime context materialise reads its descriptor + navigation seam from. */
export interface MaterialiseContext {
  descriptor: ApiDescriptor
  /**
   * Re-fetch + re-materialise a link (wired in Build 4); returns the materialised value.
   * `linkage` propagates the originating surface so a paginated relationship-endpoint
   * array re-materialises as identifiers (not resources) on `$next()`/`$prev()`. `paginator`
   * carries the strategy that answered the current page, so the re-materialised page reports the
   * same `$page` (a divergent per-relation paginator, a picked menu arm, or an EMPTY next page
   * that carries no member to sniff).
   */
  navigate: (
    url: string,
    linkage?: boolean,
    paginator?: ResolvedPaginator,
    signal?: AbortSignal,
  ) => Promise<unknown>
  /**
   * The opt-in per-resource validator, resolved from `ClientOptions.validate`. When
   * present, every wire resource in `data`/`included` is validated against its per-type schema
   * before the document is materialised. Absent => no per-field validation (the default).
   */
  validate?: ResolvedValidator | undefined
  /**
   * The sparse fieldsets the request sent, by type, which tell an attribute narrowed to some of
   * its keys from one rendered whole (see {@link ResourceEnvelope.$nestedFieldset}).
   */
  fields?: Readonly<Record<string, readonly string[]>> | undefined
}

/** A raw JSON:API resource object (or bare identifier) off the wire. */
interface RawResource {
  type: string
  id: string
  meta?: Record<string, unknown>
  links?: ResourceLinks
  attributes?: Record<string, unknown>
  relationships?: Record<string, RawRelationship>
}

interface RawRelationship {
  data?: unknown
  links?: Record<string, unknown>
  meta?: Record<string, unknown>
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const define = (target: object, key: string, value: unknown): void => {
  Object.defineProperty(target, key, { value, enumerable: false, configurable: true })
}

const defineGetter = (target: object, key: string, get: () => unknown): void => {
  Object.defineProperty(target, key, { get, enumerable: false, configurable: true })
}

// ── The cache-layer overlay ─────────────────────────────────────────────────────────────────

/**
 * What a cache layer (such as `@haddowg/json-api-query`'s optimistic drafts) reports about the
 * materialised values it holds, consulted by `$optimistic`, `$pending()` and `$count`. Each call
 * gets the value the accessor was read on followed by the values it reads through to (a per-edge
 * view, then the node it views), so a layer that recorded any of them answers for all.
 *
 * @internal
 */
export interface MaterialisedOverlay {
  /** `'pending'` when the layer holds an unconfirmed change to any of `targets`. */
  optimistic(targets: readonly object[]): 'pending' | undefined
  /** The members of relation `name` the layer predicted for `targets` but couldn't show. */
  pending(targets: readonly object[], name: string): readonly PendingMember[]
  /**
   * The creates the layer placed in the collection `targets` (an augmented array, then what it
   * reads through to) but couldn't show as members. Absent: none.
   */
  creates?(targets: readonly object[]): readonly PendingCreate[]
  /**
   * The total the collection `targets` reports, given the `raw` total its response carried
   * (`$page.meta.total`, and a top-level collection's `$meta.total`). Absent: the raw total.
   */
  total?(targets: readonly object[], raw: number): number
  /**
   * The count `targets` report for relation `name`, given the `raw` count the response carried.
   * `name` is `undefined` when the target is the to-many array itself (its own `$count`).
   */
  count(
    targets: readonly object[],
    name: string | undefined,
    raw: number | undefined,
  ): number | undefined
}

let overlay: MaterialisedOverlay | undefined

/**
 * Install the cache layer's {@link MaterialisedOverlay}, or remove it with `undefined`. One layer is
 * installed at a time; without one, `$optimistic` is `undefined`, `$pending()` is empty and `$count`
 * is the response's count.
 *
 * @internal
 */
export function setMaterialisedOverlay(next: MaterialisedOverlay | undefined): void {
  overlay = next
}

const NO_IDENTIFIERS: readonly PendingMember[] = Object.freeze([])

const NO_CREATES: readonly PendingCreate[] = Object.freeze([])

/** The value each per-edge view reads through to. */
const SOURCES = new WeakMap<object, object>()

/** The raw (response) count of each node's relations, by node. */
const RAW_COUNTS = new WeakMap<object, (name: string) => number | undefined>()

/** `target` followed by the values it reads through to, nearest first. */
function chainOf(target: object): object[] {
  const chain: object[] = []
  let at: object | undefined = target
  while (at !== undefined && !chain.includes(at)) {
    chain.push(at)
    at = SOURCES.get(at)
  }
  return chain
}

/** The raw count of relation `name` the first value in `chain` with one carries. */
function rawCount(chain: readonly object[], name: string): number | undefined {
  for (const value of chain) {
    const count = RAW_COUNTS.get(value)
    if (count !== undefined) {
      return count(name)
    }
  }
  return undefined
}

/** Define the overlay-backed accessors (`$optimistic`, `$pending`, `$count`) of a resource value. */
function attachOverlayAccessors(target: object): void {
  defineGetter(target, '$optimistic', () => overlay?.optimistic(chainOf(target)))
  define(
    target,
    '$pending',
    (name: string): readonly PendingMember[] =>
      overlay?.pending(chainOf(target), name) ?? NO_IDENTIFIERS,
  )
  define(target, '$count', (name: string): number | undefined => {
    const chain = chainOf(target)
    const raw = rawCount(chain, name)
    return overlay === undefined ? raw : overlay.count(chain, name, raw)
  })
}

/** A relationship object's `meta.total` when it is a finite number, else `undefined`. */
const relationTotal = (rel: RawRelationship | undefined): number | undefined => {
  const total = rel?.meta?.['total']
  return typeof total === 'number' && Number.isFinite(total) ? total : undefined
}

/**
 * Materialise a JSON:API document into a hydrated graph (ADR 0002):
 *
 * - single resource -> a flattened resource object (own enumerable type/id/attributes/
 *   relations + non-enumerable `$`-accessors);
 * - collection / related collection -> an augmented array of resource objects;
 * - relationship linkage -> an augmented array of identifier views (to-many) or a single
 *   identifier / null (to-one).
 *
 * Included resources hydrate into nested per-edge views (reads through to the shared
 * node for attributes, owns its own `$edge`/`$pivot`); linked-but-not-included relations
 * stay as identifiers; links-only relations are `undefined`. The envelope rides
 * non-enumerable `$`-accessors so `{...res}` / `JSON.stringify(res)` are clean.
 *
 * `linkage` discriminates a relationship-endpoint response (primary `data` is pure
 * resource-identifier linkage) from a resource/collection response (primary `data` is a
 * full resource) — a structural guess can't tell them apart for an attribute-less,
 * relation-less resource, so the caller passes the surface it issued.
 *
 * `paginatorOverride` sets the top-level array's `$page` for a related/relationship read, where the
 * paginator is the RELATION's (which may diverge from the related type's collection — D6a), for a
 * menu read that picked an arm, and where an empty page carries no member to sniff a type from. A
 * bare kind is read with its canonical wire keys. `primaryType` is preferred for a
 * top-level collection read (statically-known); both override the sniff-from-`data[0]` fallback.
 */
export function materialise(
  doc: Document,
  ctx: MaterialiseContext,
  linkage = false,
  primaryType?: string,
  paginatorOverride?: ResolvedPaginator | PaginatorKind,
): unknown {
  const value = materialiseDocument(doc, ctx, linkage, primaryType, paginatorOverride)
  if (typeof value === 'object' && value !== null) {
    MATERIALISED.add(value)
  }
  return stampFromDocument(doc, value)
}

const MATERIALISED = new WeakSet<object>()

/**
 * Whether `value` is a top-level result `materialise` built: a resource, a collection or a linkage
 * value, including the pages `$next()` and `$prev()` re-materialise. A plain copy of one, such as
 * data that went through `JSON.stringify` on a server and back, has lost its `$`-accessors and
 * answers `false`, which is how a hydrated cache entry is told from a fresh read.
 */
export function isMaterialised(value: unknown): value is object {
  return typeof value === 'object' && value !== null && MATERIALISED.has(value)
}

function materialiseDocument(
  doc: Document,
  ctx: MaterialiseContext,
  linkage: boolean,
  primaryType: string | undefined,
  paginatorOverride: ResolvedPaginator | PaginatorKind | undefined,
): unknown {
  // Always-on light structural guards: prove the envelope invariant the runtime relies on (a
  // JSON:API document; each data/included member carries type+id). Then, only when configured,
  // run the opt-in per-field validation over each wire resource by its type.
  assertJsonApiDocument(doc)
  if (ctx.validate !== undefined) {
    validateDocument(doc, ctx.validate, ctx.fields)
  }

  const env: DocumentEnvelope = {}
  if (doc.jsonapi !== undefined) env.jsonapi = doc.jsonapi
  if (doc.meta !== undefined) env.meta = doc.meta
  if (doc.links !== undefined) env.links = doc.links

  const index = buildIndex(doc.included)
  // One node per type:id, shared by reference for attribute reads.
  const nodes = new Map<string, object>()
  const build = (raw: RawResource): object => buildNode(raw, env, index, nodes, ctx)

  const data = doc.data

  if (data === null) {
    return null
  }

  if (Array.isArray(data)) {
    const raws = data as RawResource[]
    const members = linkage
      ? raws.map((raw) => buildIdentifierView(raw))
      : raws.map((raw) => buildEdgeView(build(raw), raw))
    return augmentArray(members, doc, ctx, linkage, primaryType, paginatorOverride)
  }

  if (isObject(data)) {
    const raw = data as unknown as RawResource
    if (linkage) {
      return buildIdentifierView(raw)
    }
    return build(raw)
  }

  // No primary data (e.g. a meta-only document); expose nothing materialisable.
  return undefined
}

/** Index `included` by `type:id` so relationship linkage can be hydrated. */
function buildIndex(included: unknown[] | undefined): Map<string, RawResource> {
  const index = new Map<string, RawResource>()
  if (!included) return index
  for (const raw of included) {
    if (isObject(raw) && typeof raw['type'] === 'string' && typeof raw['id'] === 'string') {
      index.set(key(raw['type'], raw['id']), raw as unknown as RawResource)
    }
  }
  return index
}

const key = (type: string, id: string): string => `${type}:${id}`

/**
 * Build (or reuse) the shared NODE for a resource: flattened type/id/attributes + hydrated
 * relations as own enumerable props, plus the resource-level `$`-accessors. The node is
 * memoised by `type:id` so attribute reads share one object; per-edge data never lands here.
 */
function buildNode(
  raw: RawResource,
  env: DocumentEnvelope,
  index: Map<string, RawResource>,
  nodes: Map<string, object>,
  ctx: MaterialiseContext,
): object {
  const id = key(raw.type, raw.id)
  const existing = nodes.get(id)
  if (existing) return existing

  const node: Record<string, unknown> = { type: raw.type, id: raw.id }
  // Seed the cache before recursing so a relation cycle resolves to this same node.
  nodes.set(id, node)

  if (raw.attributes) {
    for (const [k, v] of Object.entries(raw.attributes)) {
      node[k] = v
    }
  }

  const rels = raw.relationships ?? {}
  const resType = ctx.descriptor[raw.type]
  for (const [name, rel] of Object.entries(rels)) {
    if (!('data' in rel)) {
      // Links-only relation: no value to carry an edge -> undefined (reachable via $rel).
      continue
    }
    const relDesc = resType?.relations[name]
    node[name] = hydrateRelation(
      rel,
      relDesc?.cardinality,
      resolvePaginator(relatedPaginator(relDesc, ctx)),
      env,
      index,
      nodes,
      ctx,
    )
  }

  attachResourceEnvelope(node, raw, env, rels, nestedFieldset(ctx.fields?.[raw.type]))
  return node
}

/**
 * Resolve one relationship's value: an included member hydrates to a per-edge view, a
 * linked-but-not-included member stays an identifier, an empty to-one is `null`, and a
 * to-many is always an augmented array (of views and/or identifiers).
 *
 * `related` is the relation's paginator (from the descriptor), threaded so a to-many array
 * reports the same `$page` it would on its dedicated endpoint without a `page` argument.
 */
function hydrateRelation(
  rel: RawRelationship,
  cardinality: 'one' | 'many' | undefined,
  related: ResolvedPaginator,
  env: DocumentEnvelope,
  index: Map<string, RawResource>,
  nodes: Map<string, object>,
  ctx: MaterialiseContext,
): unknown {
  const data = rel.data

  if (Array.isArray(data)) {
    const raws = data as RawResource[]
    const members = raws.map((member) => resolveMember(member, env, index, nodes, ctx))
    const hydrated = raws.some((member) => index.has(key(member.type, member.id)))
    return augmentRelationArray(members, rel, related, ctx, hydrated)
  }

  // A declared to-many with no array yet (count-free / lazy) still reads as an array.
  if (data === undefined && cardinality === 'many') {
    return augmentRelationArray([], rel, related, ctx, false)
  }

  if (data === null || data === undefined) {
    return data === null ? null : undefined
  }

  if (isObject(data)) {
    // A to-one's edge envelope carries the relationship object's self/related links/meta
    // ($edge = { links:{self,related}, meta }; docs/materialisation.md) so there's no need to go via
    // the parent's $rel for to-ones.
    return resolveMember(data as unknown as RawResource, env, index, nodes, ctx, {
      links: rel.links,
      meta: rel.meta,
    })
  }

  return undefined
}

/** The relationship-object envelope threaded onto a to-one member's `$edge`. */
interface RelationEdge {
  links: Record<string, unknown> | undefined
  meta: Record<string, unknown> | undefined
}

/** A single linkage member -> a hydrated per-edge view if included, else an identifier view. */
function resolveMember(
  member: RawResource,
  env: DocumentEnvelope,
  index: Map<string, RawResource>,
  nodes: Map<string, object>,
  ctx: MaterialiseContext,
  relationEdge?: RelationEdge,
): object {
  const included = index.get(key(member.type, member.id))
  if (included) {
    return buildEdgeView(buildNode(included, env, index, nodes, ctx), member, relationEdge)
  }
  return buildIdentifierView(member, relationEdge)
}

/**
 * Attach the resource-level `$`-accessors ($meta/$links/$self/$document/$raw/$nestedFieldset/$rel,
 * and the overlay-backed $count/$optimistic/$pending).
 */
function attachResourceEnvelope(
  node: object,
  raw: RawResource,
  env: DocumentEnvelope,
  rels: Record<string, RawRelationship>,
  selection: NestedFieldset,
): void {
  defineGetter(node, '$meta', () => raw.meta)
  defineGetter(node, '$links', () => raw.links)
  defineGetter(node, '$self', () => linkHref(raw.links?.self))
  defineGetter(node, '$document', () => env)
  defineGetter(node, '$raw', () => raw)
  defineGetter(node, '$nestedFieldset', () => selection)
  define(node, '$rel', (name: string): RelationView | undefined => {
    const rel = rels[name]
    if (!rel) return undefined
    const view: RelationView = {}
    if ('data' in rel) view.data = rel.data
    if (rel.links !== undefined) view.links = rel.links
    if (rel.meta !== undefined) view.meta = rel.meta
    return view
  })
  RAW_COUNTS.set(node, (name: string): number | undefined =>
    Object.hasOwn(rels, name) ? relationTotal(rels[name]) : undefined,
  )
  attachOverlayAccessors(node)
}

/**
 * A per-edge VIEW over a node: a distinct wrapper per membership that reads through to the
 * shared node for attributes (and the resource-level `$`-accessors) but owns its own
 * edge-local `$edge`/`$pivot`. Identity is by `type:id`, never reference.
 *
 * `relationEdge` (set for a to-one) carries the relationship object's self/related links and
 * meta, which ride the value's `$edge` (docs/materialisation.md).
 */
function buildEdgeView(
  node: object,
  member: RawResource,
  relationEdge?: RelationEdge,
  pick?: (key: string) => boolean,
): object {
  const view: Record<string, unknown> = {}
  // Copy the node's own enumerable props (type/id/attributes/relations) into this per-edge view.
  // INVARIANT (normalize.ts, ADR 0003): every cache patch must walk and patch ALL cached views
  // of a resource, not just the canonical node — `patchAll`/`walkResources`/`patchNode` do exactly
  // that, so these copied props stay consistent across writes. A future node-only write path would
  // leave edge views stale, so it must preserve this walk-every-view invariant.
  if (pick === undefined) {
    Object.assign(view, node)
  } else {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'type' || k === 'id' || pick(k)) {
        view[k] = v
      }
    }
  }
  SOURCES.set(view, node)
  // Delegate the node's non-enumerable `$`-accessors so they read through to the node.
  for (const k of ['$meta', '$links', '$self', '$document', '$raw', '$nestedFieldset'] as const) {
    delegate(view, node, k)
  }
  const rel = (node as { $rel?: unknown }).$rel
  define(
    view,
    '$rel',
    typeof rel === 'function' ? rel.bind(node) : (): RelationView | undefined => undefined,
  )
  // Its own overlay accessors, which ask about this view and then the node it reads through to.
  attachOverlayAccessors(view)
  // A full-resource member's own `links` is its self-link (already on `$links`/`$self`), so a
  // to-many member's `$edge` is meta-only; a to-one additionally carries the relationship
  // object's self/related links via `relationEdge`.
  attachEdgeEnvelope(view, member, false, relationEdge)
  return view
}

/** The linkage member a per-edge or identifier view is built for: its identity and its meta. */
export interface EdgeMember {
  type: string
  id: string
  meta?: Record<string, unknown>
}

/**
 * A per-edge view over `node` for the membership `member` describes, as `materialise` builds one
 * for an included member: it copies `node`'s own enumerable members (those `pick` keeps, when
 * given; `type` and `id` always), reads its resource-level `$`-accessors through to `node`, and
 * owns its `$edge`/`$pivot` from `member.meta`. `node` may be any resource value, a materialised
 * one or a plain object; accessors it lacks read as `undefined`.
 *
 * For a cache layer placing a member in a slot (`@haddowg/json-api-query`'s optimistic drafts).
 *
 * @internal
 */
export function edgeViewOf(
  node: object,
  member: EdgeMember,
  pick?: (key: string) => boolean,
): object {
  return buildEdgeView(node, member as RawResource, undefined, pick)
}

/**
 * An identifier view for `member`, as `materialise` builds one for a linked member that isn't
 * included: `{ type, id, meta? }` with its `$edge`/`$pivot`.
 *
 * @internal
 */
export function identifierViewOf(member: EdgeMember): object {
  return buildIdentifierView(member as RawResource)
}

/** An identifier VIEW for a linked-but-not-included member: a clean `{type,id,meta?}` + edge. */
function buildIdentifierView(member: RawResource, relationEdge?: RelationEdge): object {
  const view: Record<string, unknown> = { type: member.type, id: member.id }
  if (member.meta !== undefined) view.meta = member.meta
  defineGetter(view, '$optimistic', () => overlay?.optimistic([view]))
  // A bare linkage member has no resource of its own, so any `links` it carries are edge links.
  attachEdgeEnvelope(view, member, true, relationEdge)
  return view
}

/**
 * Attach `$edge` (the member's identifier-level edge meta/links) and `$pivot` sugar over it.
 * For a to-one, the relationship object's self/related links + meta (`relationEdge`) merge in,
 * with member-level meta winning on key collision.
 */
function attachEdgeEnvelope(
  view: object,
  member: RawResource,
  includeLinks: boolean,
  relationEdge?: RelationEdge,
): void {
  defineGetter(view, '$edge', () => {
    const memberLinks = includeLinks ? member.links : undefined
    const links = memberLinks ?? relationEdge?.links
    const meta = mergeMeta(relationEdge?.meta, member.meta)
    if (links === undefined && meta === undefined) return undefined
    const edge: Edge = {}
    if (links !== undefined) edge.links = links
    if (meta !== undefined) edge.meta = meta
    return edge
  })
  defineGetter(view, '$pivot', () => {
    const pivot = member.meta?.['pivot']
    return isObject(pivot) ? pivot : undefined
  })
}

/** Merge a relationship-object meta with member-level meta (member wins on key collision). */
function mergeMeta(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (base === undefined) return override
  if (override === undefined) return base
  return { ...base, ...override }
}

/** Mirror a non-enumerable accessor from `source` onto `target`, reading through live. */
function delegate(target: object, source: object, k: string): void {
  const value = (source as Record<string, unknown>)[k]
  if (typeof value === 'function') {
    define(target, k, (value as (...a: unknown[]) => unknown).bind(source))
  } else {
    defineGetter(target, k, () => (source as Record<string, unknown>)[k])
  }
}

/**
 * A top-level / related collection array: `$page` from `doc`, links/meta from the document.
 * `linkage` propagates to `$next()`/`$prev()` so a relationship-endpoint page re-materialises
 * as identifiers, not resources.
 */
function augmentArray(
  members: object[],
  doc: Document,
  ctx: MaterialiseContext,
  linkage: boolean,
  primaryType?: string,
  paginatorOverride?: ResolvedPaginator | PaginatorKind,
): object[] {
  const arr = [...members]
  const links = doc.links
  defineGetter(arr, '$links', () => links)
  // Read through `this`, as `$page` and `$pending` are, so a copy of the array carrying these
  // accessors (a cache layer's edited membership) asks the overlay about itself.
  Object.defineProperty(arr, '$meta', {
    get(this: object): Record<string, unknown> | undefined {
      return withTotal(doc.meta, this)
    },
    enumerable: false,
    configurable: true,
  })
  const paginator =
    paginatorOverride === undefined
      ? resolvePaginator(primaryPaginator(doc, ctx, primaryType))
      : typeof paginatorOverride === 'string'
        ? resolvePaginator(paginatorOverride)
        : paginatorOverride
  attachPage(arr, paginator, pageMeta(doc.meta), links, ctx, linkage)
  return arr
}

/**
 * A to-many relationship array: `$page`/links/meta come from the relationship object.
 * `paginator` is the relation's (so an in-document compound-include to-many reports the same
 * discriminant it would when fetched at its own relationship/related endpoint — "one model,
 * three surfaces").
 *
 * A rendered to-many holds only its first page, and its page links usually address the
 * relationship endpoint, which answers with identifiers. So `$next()`/`$prev()` keep the shape the
 * array has: an included (`hydrated`) array reads the same page from the related endpoint, which
 * answers with the resources, and an array of identifiers reads the page as linkage.
 */
function augmentRelationArray(
  members: object[],
  rel: RawRelationship,
  paginator: ResolvedPaginator,
  ctx: MaterialiseContext,
  hydrated: boolean,
): object[] {
  const arr = [...members]
  const links = rel.links
  defineGetter(arr, '$links', () => links)
  defineGetter(arr, '$meta', () => rel.meta)
  // Read through `this`, so a copy of the array carrying this accessor (a cache layer's edited
  // membership) asks the overlay about itself.
  Object.defineProperty(arr, '$count', {
    get(this: object): number | undefined {
      const raw = relationTotal(rel)
      return overlay === undefined ? raw : overlay.count([this], undefined, raw)
    },
    enumerable: false,
    configurable: true,
  })
  attachPage(
    arr,
    paginator,
    pageMeta(rel.meta),
    links,
    ctx,
    !hydrated,
    hydrated ? (link) => relatedPageLink(link, links) : undefined,
  )
  return arr
}

/**
 * A relationship page link moved to the related endpoint: a link addressing the relationship's
 * `self` path takes its `related` path and keeps its query, so it reads the same page as
 * resources. Any other link, such as one already addressing the related endpoint, is unchanged.
 */
function relatedPageLink(link: string, links: Record<string, unknown> | undefined): string {
  const self = linkHref(links?.['self'])
  const related = linkHref(links?.['related'])
  if (self === undefined || related === undefined) {
    return link
  }
  const at = link.indexOf('?')
  const path = at < 0 ? link : link.slice(0, at)
  const selfPath = self.split('?')[0]
  return path === selfPath ? `${related.split('?')[0]}${at < 0 ? '' : link.slice(at)}` : link
}

/** Attach `$page` + `$next()`/`$prev()` driven by link presence (count-free-safe). */
function attachPage(
  arr: object[],
  paginator: ResolvedPaginator,
  meta: Record<string, unknown> | undefined,
  links: Record<string, unknown> | undefined,
  ctx: MaterialiseContext,
  linkage: boolean,
  follow: (link: string) => string = (link) => link,
): void {
  const page: Page = { kind: paginator.kind, keys: paginator.keys, links: pageLinks(links) }
  if (paginator.arm !== undefined) page.arm = paginator.arm
  if (meta !== undefined) page.meta = meta
  // Through `this`, so a copy of the array (a cache layer's edited membership) reports its own
  // total and pending creates.
  Object.defineProperty(arr, '$page', {
    get(this: object): Page {
      return pageWithTotal(page, this)
    },
    enumerable: false,
    configurable: true,
  })
  define(arr, '$pending', function (this: object): readonly PendingCreate[] {
    return overlay?.creates?.([this]) ?? NO_CREATES
  })
  const go = (link: string | undefined, signal: AbortSignal | undefined) =>
    navigateLink(link === undefined ? undefined : follow(link), ctx, linkage, paginator, signal)
  define(arr, '$next', (options?: NavigateOptions) => go(page.links.next, options?.signal))
  define(arr, '$prev', (options?: NavigateOptions) => go(page.links.prev, options?.signal))
}

const navigateLink = (
  link: string | undefined,
  ctx: MaterialiseContext,
  linkage: boolean,
  paginator: ResolvedPaginator,
  signal: AbortSignal | undefined,
): Promise<unknown> => {
  if (link === undefined) {
    return Promise.resolve(undefined)
  }
  return signal === undefined
    ? ctx.navigate(link, linkage, paginator)
    : ctx.navigate(link, linkage, paginator, signal)
}

/** Extract the navigation links (a link may be a string or a `{href}` object). */
function pageLinks(links: Record<string, unknown> | undefined): Page['links'] {
  const out: Page['links'] = {}
  if (!links) return out
  for (const k of ['first', 'prev', 'next', 'last'] as const) {
    const href = linkHref(links[k])
    if (href !== undefined) out[k] = href
  }
  return out
}

const linkHref = (link: unknown): string | undefined => {
  if (typeof link === 'string') return link
  if (isObject(link) && typeof link['href'] === 'string') return link['href']
  return undefined
}

/** `meta` with its `total` moved as the overlay reports for `target`, when both say so. */
function withTotal(
  meta: Record<string, unknown> | undefined,
  target: object,
): Record<string, unknown> | undefined {
  const raw = meta?.['total']
  if (overlay?.total === undefined || typeof raw !== 'number' || !Number.isFinite(raw)) {
    return meta
  }
  const total = overlay.total([target], raw)
  return total === raw ? meta : cachedCopy(meta!, total, () => ({ ...meta, total }))
}

/** `page` with its `meta.total` moved as the overlay reports for `target`. */
function pageWithTotal(page: Page, target: object): Page {
  const meta = page.meta === undefined ? undefined : withTotal(page.meta, target)
  if (meta === undefined || meta === page.meta) {
    return page
  }
  return cachedCopy(page, meta['total'] as number, () => ({ ...page, meta }))
}

/** The copies made of each value per total, so an unchanged total reads back the same object. */
const COPIES = new WeakMap<object, Map<number, object>>()

function cachedCopy<V extends object>(value: V, total: number, make: () => V): V {
  const copies = COPIES.get(value) ?? new Map<number, object>()
  COPIES.set(value, copies)
  let copy = copies.get(total)
  if (copy === undefined) {
    copy = make()
    copies.set(total, copy)
  }
  return copy as V
}

const pageMeta = (meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
  isObject(meta?.['page']) ? (meta['page'] as Record<string, unknown>) : undefined

/**
 * The document's paginator (from the primary type's descriptor). Prefers the statically-known
 * `primaryType` (passed by the descriptor binding at the call site) so an EMPTY page still reports
 * the collection's real kind; falls back to sniffing the first member's type (for a re-materialised
 * `$next()` page or a related read, where the primary type isn't threaded).
 */
function primaryPaginator(
  doc: Document,
  ctx: MaterialiseContext,
  primaryType?: string,
): PaginatorDescriptor | undefined {
  const first = Array.isArray(doc.data) ? doc.data[0] : doc.data
  const type =
    primaryType ??
    (isObject(first) && typeof first['type'] === 'string' ? first['type'] : undefined)
  return type !== undefined ? ctx.descriptor[type]?.paginator : undefined
}

/**
 * A to-many relation's paginator. The relation's OWN related/relationship endpoint may
 * paginate differently than the related type's top-level collection (D6a), so prefer the
 * per-relation `paginator` (carried in the descriptor only when it diverges); otherwise fall back
 * to the related type's own paginator (the relationship and related endpoints both paginate that
 * type), so the discriminant is identical across the three surfaces. A polymorphic relation
 * resolves off its first declared related type (its members span types, matching the relationship
 * endpoint's first-member resolution).
 */
export function relatedPaginator(
  relation: RelationDescriptor | undefined,
  ctx: MaterialiseContext,
): PaginatorDescriptor | undefined {
  if (relation?.paginator !== undefined) return relation.paginator
  const relatedType = relation?.types[0]
  return relatedType === undefined ? undefined : ctx.descriptor[relatedType]?.paginator
}

/** The kind a relation's related read answers with when it sends no `page`. See {@link relatedPaginator}. */
export function relatedPaginatorKind(
  relation: RelationDescriptor | undefined,
  ctx: MaterialiseContext,
): PaginatorKind {
  return resolvePaginator(relatedPaginator(relation, ctx)).kind
}
