import type { ApiDescriptor, PaginatorKind, RelationDescriptor } from './descriptor'
import type { Document } from './request'
import { assertJsonApiDocument, type ResolvedValidator, validateDocument } from './validate'

/** A trimmed, by-reference top-level envelope shared by every resource from one response. */
export interface DocumentEnvelope {
  jsonapi?: Record<string, unknown>
  meta?: Record<string, unknown>
  links?: Record<string, unknown>
}

/** Resource-level links (`self` is the common one; the wire may carry more). */
export interface ResourceLinks {
  self?: string
  [key: string]: unknown
}

/** The relationship-instance envelope for a materialised related value (its `$edge`). */
export interface Edge {
  links?: Record<string, unknown>
  meta?: Record<string, unknown>
}

/** Normalised pagination, discriminated by paginator kind; count-free-safe. */
export interface Page {
  kind: PaginatorKind
  /** The raw `meta.page` block, when present (shape varies by kind). */
  meta?: Record<string, unknown>
  /** Navigation links by relation (`first`/`prev`/`next`/`last`), when present. */
  links: { first?: string; prev?: string; next?: string; last?: string }
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
  readonly $self: string | undefined
  readonly $document: DocumentEnvelope
  readonly $raw: RawResource
  $rel(name: string): RelationView | undefined
}

/** Edge-local accessors carried by a materialised related VALUE (per-edge view). */
export interface EdgeEnvelope {
  readonly $edge: Edge | undefined
  readonly $pivot: Record<string, unknown> | undefined
}

/** Relationship-level accessors carried by an augmented to-many array. */
export interface ArrayEnvelope {
  readonly $page: Page
  readonly $links: Record<string, unknown> | undefined
  readonly $meta: Record<string, unknown> | undefined
  $next(): Promise<unknown>
  $prev(): Promise<unknown>
}

/** The runtime context materialise reads its descriptor + navigation seam from. */
export interface MaterialiseContext {
  descriptor: ApiDescriptor
  /**
   * Re-fetch + re-materialise a link (wired in Build 4); returns the materialised value.
   * `linkage` propagates the originating surface so a paginated relationship-endpoint
   * array re-materialises as identifiers (not resources) on `$next()`/`$prev()`.
   */
  navigate: (url: string, linkage?: boolean) => Promise<unknown>
  /**
   * The opt-in per-resource validator (ADR 0004), resolved from `ClientOptions.validate`. When
   * present, every wire resource in `data`/`included` is validated against its per-type schema
   * before the document is materialised. Absent => no per-field validation (the default).
   */
  validate?: ResolvedValidator | undefined
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

/**
 * Materialise a JSON:API document into a hydrated graph (ADR 0002 / CONTEXT.md):
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
 */
export function materialise(doc: Document, ctx: MaterialiseContext, linkage = false): unknown {
  // Always-on light structural guards: prove the envelope invariant the runtime relies on (a
  // JSON:API document; each data/included member carries type+id). Then, only when configured,
  // run the opt-in per-field validation over each wire resource by its type (ADR 0004).
  assertJsonApiDocument(doc)
  if (ctx.validate !== undefined) {
    validateDocument(doc, ctx.validate)
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
    return augmentArray(members, doc, ctx, linkage)
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
      relatedPaginatorKind(relDesc, ctx),
      env,
      index,
      nodes,
      ctx,
    )
  }

  attachResourceEnvelope(node, raw, env, rels)
  return node
}

/**
 * Resolve one relationship's value: an included member hydrates to a per-edge view, a
 * linked-but-not-included member stays an identifier, an empty to-one is `null`, and a
 * to-many is always an augmented array (of views and/or identifiers).
 *
 * `relatedKind` is the related type's paginator kind (from the descriptor), threaded so a
 * to-many array reports the same `$page.kind` it would on its dedicated endpoint.
 */
function hydrateRelation(
  rel: RawRelationship,
  cardinality: 'one' | 'many' | undefined,
  relatedKind: PaginatorKind,
  env: DocumentEnvelope,
  index: Map<string, RawResource>,
  nodes: Map<string, object>,
  ctx: MaterialiseContext,
): unknown {
  const data = rel.data

  if (Array.isArray(data)) {
    const members = (data as RawResource[]).map((member) =>
      resolveMember(member, env, index, nodes, ctx),
    )
    return augmentRelationArray(members, rel, relatedKind, ctx)
  }

  // A declared to-many with no array yet (count-free / lazy) still reads as an array.
  if (data === undefined && cardinality === 'many') {
    return augmentRelationArray([], rel, relatedKind, ctx)
  }

  if (data === null || data === undefined) {
    return data === null ? null : undefined
  }

  if (isObject(data)) {
    // A to-one's edge envelope carries the relationship object's self/related links/meta
    // (CONTEXT.md: $edge = { links:{self,related}, meta }) so there's no need to go via
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

/** Attach the resource-level `$`-accessors ($meta/$links/$self/$document/$raw/$rel). */
function attachResourceEnvelope(
  node: object,
  raw: RawResource,
  env: DocumentEnvelope,
  rels: Record<string, RawRelationship>,
): void {
  defineGetter(node, '$meta', () => raw.meta)
  defineGetter(node, '$links', () => raw.links)
  defineGetter(node, '$self', () => raw.links?.self)
  defineGetter(node, '$document', () => env)
  defineGetter(node, '$raw', () => raw)
  define(node, '$rel', (name: string): RelationView | undefined => {
    const rel = rels[name]
    if (!rel) return undefined
    const view: RelationView = {}
    if ('data' in rel) view.data = rel.data
    if (rel.links !== undefined) view.links = rel.links
    if (rel.meta !== undefined) view.meta = rel.meta
    return view
  })
}

/**
 * A per-edge VIEW over a node: a distinct wrapper per membership that reads through to the
 * shared node for attributes (and the resource-level `$`-accessors) but owns its own
 * edge-local `$edge`/`$pivot`. Identity is by `type:id`, never reference.
 *
 * `relationEdge` (set for a to-one) carries the relationship object's self/related links and
 * meta, which ride the value's `$edge` per CONTEXT.md.
 */
function buildEdgeView(node: object, member: RawResource, relationEdge?: RelationEdge): object {
  const view: Record<string, unknown> = {}
  // Copy the node's own enumerable props (type/id/attributes/relations) for a clean spread.
  // TODO(Phase 4): ADR-0002 wants the view to READ THROUGH to the node for attributes so a
  // normalized write-through patch is reflected; copying is correct for a single response (the
  // node is never mutated) but must become live read-through once normalization lands.
  Object.assign(view, node)
  // Delegate the node's non-enumerable `$`-accessors so they read through to the node.
  for (const k of ['$meta', '$links', '$self', '$document', '$raw', '$rel'] as const) {
    delegate(view, node, k)
  }
  // A full-resource member's own `links` is its self-link (already on `$links`/`$self`), so a
  // to-many member's `$edge` is meta-only; a to-one additionally carries the relationship
  // object's self/related links via `relationEdge`.
  attachEdgeEnvelope(view, member, false, relationEdge)
  return view
}

/** An identifier VIEW for a linked-but-not-included member: a clean `{type,id,meta?}` + edge. */
function buildIdentifierView(member: RawResource, relationEdge?: RelationEdge): object {
  const view: Record<string, unknown> = { type: member.type, id: member.id }
  if (member.meta !== undefined) view.meta = member.meta
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
): object[] {
  const arr = [...members]
  const links = doc.links
  defineGetter(arr, '$links', () => links)
  defineGetter(arr, '$meta', () => doc.meta)
  attachPage(arr, paginatorKind(doc, ctx), pageMeta(doc.meta), links, ctx, linkage)
  return arr
}

/**
 * A to-many relationship array: `$page`/links/meta come from the relationship object. `kind`
 * is the related type's paginator (so an in-document compound-include to-many reports the same
 * discriminant it would when fetched at its own relationship/related endpoint — "one model,
 * three surfaces").
 */
function augmentRelationArray(
  members: object[],
  rel: RawRelationship,
  kind: PaginatorKind,
  ctx: MaterialiseContext,
): object[] {
  const arr = [...members]
  const links = rel.links
  defineGetter(arr, '$links', () => links)
  defineGetter(arr, '$meta', () => rel.meta)
  attachPage(arr, kind, pageMeta(rel.meta), links, ctx, false)
  return arr
}

/** Attach `$page` + `$next()`/`$prev()` driven by link presence (count-free-safe). */
function attachPage(
  arr: object[],
  kind: PaginatorKind,
  meta: Record<string, unknown> | undefined,
  links: Record<string, unknown> | undefined,
  ctx: MaterialiseContext,
  linkage: boolean,
): void {
  const page: Page = { kind, links: pageLinks(links) }
  if (meta !== undefined) page.meta = meta
  defineGetter(arr, '$page', () => page)
  define(arr, '$next', () => navigateLink(page.links.next, ctx, linkage))
  define(arr, '$prev', () => navigateLink(page.links.prev, ctx, linkage))
}

const navigateLink = (
  link: string | undefined,
  ctx: MaterialiseContext,
  linkage: boolean,
): Promise<unknown> =>
  link === undefined ? Promise.resolve(undefined) : ctx.navigate(link, linkage)

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

const pageMeta = (meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
  isObject(meta?.['page']) ? (meta['page'] as Record<string, unknown>) : undefined

/** The document's paginator kind (from the primary type's descriptor; default `none`). */
function paginatorKind(doc: Document, ctx: MaterialiseContext): PaginatorKind {
  const first = Array.isArray(doc.data) ? doc.data[0] : doc.data
  if (isObject(first) && typeof first['type'] === 'string') {
    return ctx.descriptor[first['type']]?.paginator ?? 'none'
  }
  return 'none'
}

/**
 * A to-many relation's paginator kind: the related type's own paginator (the relationship
 * and related endpoints both paginate that type), so the discriminant is identical across the
 * three surfaces. A polymorphic relation resolves off its first declared related type (its
 * members span types, matching the relationship endpoint's first-member resolution).
 */
function relatedPaginatorKind(
  relation: RelationDescriptor | undefined,
  ctx: MaterialiseContext,
): PaginatorKind {
  const relatedType = relation?.types[0]
  if (relatedType === undefined) return 'none'
  return ctx.descriptor[relatedType]?.paginator ?? 'none'
}
