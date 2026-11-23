/**
 * How the cache tells resources apart: by their string `type` and `id`.
 *
 * @internal
 */

/** A plain object or class instance, never an array. @internal */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The `{ type, id }` a value carries, when both are strings. @internal */
export function identityOf(value: unknown): { type: string; id: string } | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const { type, id } = value
  return typeof type === 'string' && typeof id === 'string' ? { type, id } : undefined
}

/** Whether `value` carries `ref`'s `type` and `id`. @internal */
export const addresses = (
  value: unknown,
  ref: { readonly type: string; readonly id: string },
): boolean => isRecord(value) && value['type'] === ref.type && value['id'] === ref.id

const IDENTIFIER_KEYS: ReadonlySet<string> = new Set(['type', 'id', 'lid', 'meta'])

/**
 * Whether `value` holds a key beyond an identifier's `type`, `id`, `lid` and `meta` and the
 * `$`-prefixed accessors.
 * @internal
 */
export const carriesData = (value: Record<string, unknown>): boolean =>
  Object.keys(value).some((key) => !IDENTIFIER_KEYS.has(key) && !key.startsWith('$'))

// NUL can't appear in a type name, so the first one always ends the type, whatever the id holds.
const SEPARATOR = '\u0000'

/**
 * The map key of `type:id`; a singleton addressed by type alone (`id` undefined) keys as id `''`.
 * @internal
 */
export const identityKey = (type: string, id: string | undefined): string =>
  `${type}${SEPARATOR}${id ?? ''}`

/** The map key of relation `rel` of `type:id`. @internal */
export const relationIdentityKey = (type: string, id: string | undefined, rel: string): string =>
  `${identityKey(type, id)}${SEPARATOR}${rel}`

/** The `type` and `id` an {@link identityKey} was made from. @internal */
export function splitIdentityKey(key: string): [type: string, id: string] {
  const at = key.indexOf(SEPARATOR)
  return [key.slice(0, at), key.slice(at + 1)]
}
