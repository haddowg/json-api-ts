import type { ActionLocationDescriptor } from './descriptor'
import type { Document } from './request'

/**
 * The URL an action answered with (generator contract 17), read from its location document. The
 * client never fetches it: a presigned storage URL is for the browser or the caller to open.
 */
export interface ActionLocation {
  /** The URL, from `links.location.href`. */
  url: string
  /**
   * The media type the URL serves: the link's `type`, else the one the action declares. A server
   * may name another type for one response, such as a file whose type varies.
   */
  type: string
  /** When the URL stops working, as the server's ISO 8601 string. Absent when it doesn't expire. */
  expiresAt?: string
}

/**
 * Whether a value is an {@link ActionLocation}, for an action that answers with either a resource
 * or a URL. A materialised resource always has an `id`, which a location never has.
 */
export function isActionLocation(value: unknown): value is ActionLocation {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || 'id' in value) {
    return false
  }
  const record = value as Record<string, unknown>
  return typeof record['url'] === 'string' && typeof record['type'] === 'string'
}

/** A link's `href` and the object it came from, whether written as a string or a link object. */
function linkObject(link: unknown): { href: string; link: Record<string, unknown> } | undefined {
  if (typeof link === 'string') {
    return { href: link, link: {} }
  }
  if (typeof link === 'object' && link !== null && !Array.isArray(link)) {
    const object = link as Record<string, unknown>
    return typeof object['href'] === 'string' ? { href: object['href'], link: object } : undefined
  }
  return undefined
}

/**
 * The URL a location document carries, or `undefined` when the document is something else, such
 * as a resource document from an action that answers with either.
 */
export function readActionLocation(
  doc: Document,
  declared: ActionLocationDescriptor,
): ActionLocation | undefined {
  if (doc.data !== undefined) {
    return undefined
  }
  const location = linkObject(doc.links?.['location'])
  if (location === undefined) {
    return undefined
  }
  const out: ActionLocation = {
    url: location.href,
    type: typeof location.link['type'] === 'string' ? location.link['type'] : declared.mediaType,
  }
  const meta = location.link['meta']
  const linkExpiry =
    typeof meta === 'object' && meta !== null
      ? (meta as Record<string, unknown>)['expiresAt']
      : undefined
  const expiresAt = linkExpiry ?? doc.meta?.['expiresAt']
  if (typeof expiresAt === 'string') {
    out.expiresAt = expiresAt
  }
  return out
}
