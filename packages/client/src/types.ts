/** The JSON:API media type. */
export const JSON_API_MEDIA_TYPE = 'application/vnd.api+json'

/** The Atomic Operations extension URI. */
export const ATOMIC_EXT = 'https://jsonapi.org/ext/atomic'

/**
 * The media type for an Atomic Operations request/response: the JSON:API media type carrying
 * the atomic `ext` parameter. Sent as both `Content-Type` and `Accept` on a `client.atomic`
 * batch (per the JSON:API atomic extension).
 */
export const ATOMIC_MEDIA_TYPE = `${JSON_API_MEDIA_TYPE}; ext="${ATOMIC_EXT}"`

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
