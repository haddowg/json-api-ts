/**
 * Flatten the client's materialised results into plain tool output. A resource becomes
 * `{ id, type, ...attributes, relation, links? }`, where a relation is an id (ids for a to-many,
 * or type and id for a polymorphic relation), or the flattened related resource when it was
 * included, and `links` holds only the links the type names. Generic links such as `self` and
 * resource meta are dropped. Results go back in a JSON:API-like envelope of `data`, `links` and
 * `meta`, where `links` only carries a collection's pagination.
 */
import { type ApiDescriptor, isPolymorphic } from '@haddowg/json-api-client'
import { isObject } from './openapi'

/** What flattening needs from the model. */
export interface FlattenContext {
  descriptor: ApiDescriptor
  /** How many relationships deep a result nests included resources; null for no cap. */
  includeDepth: number | null
  /** The links each type names. A type missing from it keeps no links. */
  resourceLinks: Readonly<Record<string, readonly string[]>>
}

/** A materialised related value carries `$raw` when it was included, not when it's only linkage. */
const isIncluded = (value: object): boolean => '$raw' in value

function identifier(value: Record<string, unknown>, polymorphic: boolean): unknown {
  return polymorphic ? { type: value['type'], id: value['id'] } : value['id']
}

/** A link as a flattened resource carries it: `{ href, type?, title?, meta? }`. */
function flatLink(link: unknown): Record<string, unknown> | undefined {
  if (typeof link === 'string') {
    return { href: link }
  }
  if (!isObject(link) || typeof link['href'] !== 'string') {
    return undefined
  }
  const out: Record<string, unknown> = { href: link['href'] }
  if (typeof link['type'] === 'string') out['type'] = link['type']
  if (typeof link['title'] === 'string') out['title'] = link['title']
  if (isObject(link['meta'])) out['meta'] = link['meta']
  return out
}

/** The links of a resource its type names, or undefined when it carries none of them. */
function namedLinks(
  value: Record<string, unknown>,
  names: readonly string[] | undefined,
): Record<string, unknown> | undefined {
  const links = (value as { $links?: unknown }).$links
  if (names === undefined || !isObject(links)) {
    return undefined
  }
  const out: Record<string, unknown> = {}
  for (const name of names) {
    const link = flatLink(links[name])
    if (link !== undefined) {
      out[name] = link
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Flatten one materialised resource. A resource already on the path, or one more than
 * `includeDepth` relationships from the root, is cut back to its id.
 */
export function flattenResource(
  value: Record<string, unknown>,
  ctx: FlattenContext,
  path: readonly string[] = [],
): Record<string, unknown> {
  const type = String(value['type'])
  const key = `${type}:${String(value['id'])}`
  const relations = ctx.descriptor[type]?.relations ?? {}
  const maxDepth = ctx.includeDepth
  const out: Record<string, unknown> = { id: value['id'], type }
  for (const [name, member] of Object.entries(value)) {
    if (name === 'id' || name === 'type') {
      continue
    }
    const relation = relations[name]
    if (relation === undefined) {
      out[name] = member
      continue
    }
    const polymorphic = isPolymorphic(relation)
    const one = (item: unknown): unknown => {
      if (!isObject(item)) {
        return item
      }
      const itemKey = `${String(item['type'])}:${String(item['id'])}`
      return isIncluded(item) &&
        itemKey !== key &&
        !path.includes(itemKey) &&
        (maxDepth === null || path.length < maxDepth)
        ? flattenResource(item, ctx, [...path, key])
        : identifier(item, polymorphic)
    }
    out[name] = Array.isArray(member) ? member.map(one) : one(member)
  }
  const links = namedLinks(value, ctx.resourceLinks[type])
  if (links !== undefined) {
    out['links'] = links
  }
  return out
}

const PAGE_LINKS = ['first', 'prev', 'next', 'last'] as const

function linkHref(link: unknown): string | undefined {
  if (typeof link === 'string') return link
  if (isObject(link) && typeof link['href'] === 'string') return link['href']
  return undefined
}

/** The document `meta` a materialised resource came with. */
function resourceDocumentMeta(value: unknown): Record<string, unknown> | undefined {
  const document = isObject(value)
    ? (value as { $document?: { meta?: unknown } }).$document
    : undefined
  return isObject(document?.meta) ? document.meta : undefined
}

/**
 * One resource in its envelope: `{ data, meta? }`, with `data` null when there is none.
 * `fallbackMeta` is the document meta when the value can't carry it, such as a null.
 */
export function resourceEnvelope(
  value: unknown,
  ctx: FlattenContext,
  fallbackMeta?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    data: isObject(value) ? flattenResource(value, ctx) : null,
  }
  const meta = resourceDocumentMeta(value) ?? fallbackMeta
  if (meta !== undefined) {
    out['meta'] = meta
  }
  return out
}

/** A materialised collection in its envelope: `{ data, links, meta? }`. */
export function collectionEnvelope(
  value: readonly unknown[] & { $links?: Record<string, unknown>; $meta?: Record<string, unknown> },
  ctx: FlattenContext,
): Record<string, unknown> {
  const links: Record<string, string> = {}
  for (const name of PAGE_LINKS) {
    const href = linkHref(value.$links?.[name])
    if (href !== undefined) {
      links[name] = href
    }
  }
  const out: Record<string, unknown> = {
    data: value.map((item) => (isObject(item) ? flattenResource(item, ctx) : item)),
    links,
  }
  if (value.$meta !== undefined) {
    out['meta'] = value.$meta
  }
  return out
}
