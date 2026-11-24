import type { JsonApiError, JsonApiErrorObject } from './errors'

/** The {@link JsonApiError} members of `E`, read without distributing over a union such as a query's error. */
export type JsonApiErrorOf<E> = Extract<NonNullable<E>, JsonApiError<string>>

/** The codes `E`'s {@link JsonApiError} carries, else `Fallback`. */
export type CodesOf<E, Fallback extends string = string> = [JsonApiErrorOf<E>] extends [never]
  ? Fallback
  : JsonApiErrorOf<E> extends JsonApiError<infer C>
    ? C
    : Fallback

/** An error object's first non-empty `detail` or `title`, then its `code` when `withCode` is set. */
export function errorText(
  error: JsonApiErrorObject | undefined,
  withCode = false,
): string | undefined {
  return [error?.detail, error?.title, withCode ? error?.code : undefined].find(
    (s) => s !== undefined && s !== '',
  )
}
