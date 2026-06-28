/** The JSON:API media type. */
export const JSON_API_MEDIA_TYPE = 'application/vnd.api+json'

/** The Atomic Operations extension URI. */
export const ATOMIC_EXT = 'https://jsonapi.org/ext/atomic'

/**
 * The media-type parameters a request opts into: extension URIs (`ext`) and/or profile URIs
 * (`profile`). Each is rendered as a space-joined, quoted media-type parameter per RFC 6839 /
 * the JSON:API spec (`ext="<uri> <uri>"`, `profile="<uri> <uri>"`).
 */
export interface MediaTypeParams {
  ext?: readonly string[] | undefined
  profiles?: readonly string[] | undefined
}

/**
 * Compose the JSON:API media type with any opted-in `ext`/`profile` parameters. Each parameter
 * is a space-joined, double-quoted URI list, in the canonical order `ext` then `profile` so the
 * output is deterministic (stable for caching/assertions). Empty/absent lists are omitted; with
 * neither, the bare {@link JSON_API_MEDIA_TYPE} is returned (no behaviour change for a plain
 * request). Used for both `Accept` and (when a body is present) `Content-Type`.
 */
export function mediaType(params: MediaTypeParams = {}): string {
  let out = JSON_API_MEDIA_TYPE
  if (params.ext !== undefined && params.ext.length > 0) {
    out += `; ext="${params.ext.join(' ')}"`
  }
  if (params.profiles !== undefined && params.profiles.length > 0) {
    out += `; profile="${params.profiles.join(' ')}"`
  }
  return out
}

/**
 * The media type for an Atomic Operations request/response: the JSON:API media type carrying
 * the atomic `ext` parameter. Sent as both `Content-Type` and `Accept` on a `client.atomic`
 * batch (per the JSON:API atomic extension).
 */
export const ATOMIC_MEDIA_TYPE = mediaType({ ext: [ATOMIC_EXT] })

/** A resource identifier: the shape a non-included but linked relation takes. */
export interface ResourceIdentifier<TType extends string = string> {
  type: TType
  id: string
  meta?: Record<string, unknown>
}

/** A local id reference used inside an atomic transaction (`{ type, lid }`). */
export interface LocalIdentifier<TType extends string = string> {
  type: TType
  lid: string
}
