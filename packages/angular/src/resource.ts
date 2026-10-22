// The only module that touches Angular's `resource()`. It is experimental before Angular 22, so a
// change to its options or ref shape is absorbed here.
import {
  assertInInjectionContext,
  computed,
  inject,
  type InjectionToken,
  Injector,
  resource,
  type ResourceRef,
  type ResourceStatus,
  type Signal,
  type ValueEqualityFn,
} from '@angular/core'
import { type ErrorCodeOf, JsonApiError, type StructuralGuardError } from '@haddowg/json-api-client'
import { JSON_API_CLIENT, type RegisteredClient } from './provide'

/**
 * What a read can fail with: a `JsonApiError` for a non-2xx response, a `StructuralGuardError`
 * for a response that isn't a JSON:API document, or any other error (a network failure, a
 * validator's error). Narrow with `instanceof`. `E` types the `JsonApiError`'s codes.
 */
export type JsonApiResourceError<E extends string = string> =
  | JsonApiError<E>
  | StructuralGuardError
  | Error

/** What the loader receives each time the params change or the resource reloads. */
export interface JsonApiLoaderContext<C, P> {
  client: C
  params: P
  /** Aborts when the params change again or the resource is destroyed. Pass it to the read. */
  abortSignal: AbortSignal
  previous: { status: ResourceStatus }
}

/** Options for {@link jsonApiResource}. */
export interface JsonApiResourceOptions<T, P, C> {
  /**
   * A reactive function computing the read's params from signals. Return `undefined` while the
   * read isn't ready (no id yet, say) and the resource stays idle. Leave it out to load once.
   */
  params?: () => P | undefined
  /** Make the read. Return the client call's promise, passing `abortSignal` as its `signal`. */
  loader: (context: JsonApiLoaderContext<C, P>) => PromiseLike<T>
  /** The client to read with. Defaults to the one `provideJsonApiClient` registered without a token. */
  client?: InjectionToken<C>
  /** The value while nothing has loaded yet. */
  defaultValue?: T
  equal?: ValueEqualityFn<T>
  /** Create the resource outside an injection context. */
  injector?: Injector
  debugName?: string
}

/**
 * Angular's `ResourceRef` with `error()` typed to what a JSON:API read throws, plus
 * `jsonApiError()`, the error when it is a `JsonApiError` (handy in templates, which can't
 * use `instanceof`). `E` is the client's error-code union, so a generated client's
 * `jsonApiError()` carries its server's `ErrorCode`.
 */
export interface JsonApiResourceRef<T, E extends string = string> extends Omit<
  ResourceRef<T>,
  'error' | 'hasValue'
> {
  readonly error: Signal<JsonApiResourceError<E> | undefined>
  readonly jsonApiError: Signal<JsonApiError<E> | undefined>
  /** Whether a value is loaded. Narrows `value()` to exclude `undefined`, in templates too. */
  hasValue(
    this: T extends undefined ? this : never,
  ): this is JsonApiResourceRef<Exclude<T, undefined>, E>
  hasValue(): boolean
}

/**
 * A signal-based JSON:API read: a thin wrapper over Angular's `resource()` that injects the
 * client and hands it to the loader. Changing a signal the params read starts a new load and
 * aborts the one in flight.
 *
 * ```ts
 * readonly albums = jsonApiResource({
 *   params: () => ({ filter: { title: this.search() } }),
 *   loader: ({ client, params, abortSignal }) =>
 *     client.albums.list({ ...params, include: ['artist'], signal: abortSignal }),
 * })
 * ```
 */
export function jsonApiResource<T, P = unknown, C = RegisteredClient>(
  options: JsonApiResourceOptions<T, P, C> & { defaultValue: T },
): JsonApiResourceRef<T, ErrorCodeOf<C>>
export function jsonApiResource<T, P = unknown, C = RegisteredClient>(
  options: JsonApiResourceOptions<T, P, C>,
): JsonApiResourceRef<T | undefined, ErrorCodeOf<C>>
export function jsonApiResource<T, P, C>(
  options: JsonApiResourceOptions<T, P, C>,
): JsonApiResourceRef<T | undefined, ErrorCodeOf<C>> {
  if (options.injector === undefined) {
    assertInInjectionContext(jsonApiResource)
  }
  const injector = options.injector ?? inject(Injector)
  const client = injector.get(options.client ?? (JSON_API_CLIENT as InjectionToken<C>))

  const ref = resource<T | undefined, P | undefined>({
    ...(options.params !== undefined ? { params: options.params } : {}),
    loader: ({ params, abortSignal, previous }) =>
      options.loader({ client, params: params as P, abortSignal, previous }),
    ...(options.defaultValue !== undefined ? { defaultValue: options.defaultValue } : {}),
    ...(options.equal !== undefined
      ? { equal: options.equal as ValueEqualityFn<T | undefined> }
      : {}),
    ...(options.debugName !== undefined ? { debugName: options.debugName } : {}),
    injector,
  })

  const jsonApiError = computed(() => {
    const error = ref.error()
    return error instanceof JsonApiError ? error : undefined
  })
  Object.defineProperty(ref, 'jsonApiError', { value: jsonApiError, enumerable: true })
  return ref as unknown as JsonApiResourceRef<T | undefined, ErrorCodeOf<C>>
}
