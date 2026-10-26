/**
 * Flatten the client's materialised results into plain tool output. A resource becomes
 * `{ id, type, ...attributes, relation }`, where a relation is an id (ids for a to-many, or type
 * and id for a polymorphic relation), or the flattened related resource when it was included.
 * Links and meta on resources are dropped; a collection keeps only its pagination links.
 */
import type { ApiDescriptor } from '@haddowg/json-api-client'
import { isObject } from './openapi'

/** A materialised related value carries `$raw` when it was included, not when it's only linkage. */
const isIncluded = (value: object): boolean => '$raw' in value

function identifier(value: Record<string, unknown>, polymorphic: boolean): unknown {
  return polymorphic ? { type: value['type'], id: value['id'] } : value['id']
}

/** Flatten one materialised resource. A resource already on the path is cut back to its id. */
export function flattenResource(
  value: Record<string, unknown>,
  descriptor: ApiDescriptor,
  path: readonly string[] = [],
): Record<string, unknown> {
  const type = String(value['type'])
  const key = `${type}:${String(value['id'])}`
  const relations = descriptor[type]?.relations ?? {}
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
    const polymorphic = relation.types.length > 1
    const one = (item: unknown): unknown => {
      if (!isObject(item)) {
        return item
      }
      const itemKey = `${String(item['type'])}:${String(item['id'])}`
      return isIncluded(item) && itemKey !== key && !path.includes(itemKey)
        ? flattenResource(item, descriptor, [...path, key])
        : identifier(item, polymorphic)
    }
    out[name] = Array.isArray(member) ? member.map(one) : one(member)
  }
  return out
}

const PAGE_LINKS = ['first', 'prev', 'next', 'last'] as const

function linkHref(link: unknown): string | undefined {
  if (typeof link === 'string') return link
  if (isObject(link) && typeof link['href'] === 'string') return link['href']
  return undefined
}

/** Flatten a materialised collection into `{ items, links, meta? }`. */
export function flattenCollection(
  value: readonly unknown[] & { $links?: Record<string, unknown>; $meta?: Record<string, unknown> },
  descriptor: ApiDescriptor,
): Record<string, unknown> {
  const links: Record<string, string> = {}
  for (const name of PAGE_LINKS) {
    const href = linkHref(value.$links?.[name])
    if (href !== undefined) {
      links[name] = href
    }
  }
  const out: Record<string, unknown> = {
    items: value.map((item) => (isObject(item) ? flattenResource(item, descriptor) : item)),
    links,
  }
  if (value.$meta !== undefined) {
    out['meta'] = value.$meta
  }
  return out
}
