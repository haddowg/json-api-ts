import {
  assertInInjectionContext,
  computed,
  inject,
  type InjectionToken,
  Injector,
  type Signal,
  signal,
} from '@angular/core'
import { type ErrorCodeOf, JsonApiError } from '@haddowg/json-api-client'
import { JSON_API_CLIENT, type RegisteredClient } from './provide'
import type { JsonApiResourceError } from './resource'

/** Options for {@link jsonApiMutation}. */
export interface JsonApiMutationOptions<C> {
  /** The client to write with. Defaults to the one `provideJsonApiClient` registered without a token. */
  client?: InjectionToken<C>
  /** Create the mutation outside an injection context. */
  injector?: Injector
}

/**
 * The signal-based handle {@link jsonApiMutation} returns. `E` is the client's error-code union,
 * so a generated client's `jsonApiError()` carries its server's `ErrorCode`.
 */
export interface JsonApiMutationRef<I, T, E extends string = string> {
  /**
   * Run the write. Resolves with its result and rejects with its error; the signals track the
   * latest call either way.
   */
  mutate(input: I): Promise<T>
  readonly isPending: Signal<boolean>
  readonly error: Signal<JsonApiResourceError<E> | undefined>
  /** The error when it is a `JsonApiError`; use `byPath()` on it for form errors. */
  readonly jsonApiError: Signal<JsonApiError<E> | undefined>
  /** The latest successful result. */
  readonly value: Signal<T | undefined>
  /** Clear the value and error. A call still in flight no longer updates the signals. */
  reset(): void
}

/**
 * Wrap a client write (create, update, delete, a relationship mutation, a custom action or an
 * atomic batch) in signals. Nothing is cached or invalidated: `reload()` the resources the write
 * affects.
 *
 * ```ts
 * readonly rename = jsonApiMutation((client, title: string) =>
 *   client.albums.id(this.id()).update({ title }),
 * )
 * ```
 */
export function jsonApiMutation<I, T, C = RegisteredClient>(
  mutation: (client: C, input: I) => PromiseLike<T>,
  options: JsonApiMutationOptions<C> = {},
): JsonApiMutationRef<I, T, ErrorCodeOf<C>> {
  if (options.injector === undefined) {
    assertInInjectionContext(jsonApiMutation)
  }
  const injector = options.injector ?? inject(Injector)
  const client = injector.get(options.client ?? (JSON_API_CLIENT as InjectionToken<C>))

  const value = signal<T | undefined>(undefined)
  const error = signal<JsonApiResourceError | undefined>(undefined)
  const pending = signal(0)
  // Each call and reset bumps this, so only the latest call writes to the signals.
  let generation = 0

  const mutate = async (input: I): Promise<T> => {
    const current = ++generation
    pending.update((n) => n + 1)
    error.set(undefined)
    try {
      const result = await mutation(client, input)
      if (current === generation) {
        value.set(result)
      }
      return result
    } catch (thrown) {
      if (current === generation) {
        error.set(thrown instanceof Error ? thrown : new Error(String(thrown), { cause: thrown }))
      }
      throw thrown
    } finally {
      pending.update((n) => Math.max(0, n - 1))
    }
  }

  return {
    mutate,
    isPending: computed(() => pending() > 0),
    error: error.asReadonly(),
    jsonApiError: computed(() => {
      const e = error()
      return e instanceof JsonApiError ? e : undefined
    }),
    value: value.asReadonly(),
    reset: () => {
      generation++
      value.set(undefined)
      error.set(undefined)
      pending.set(0)
    },
  }
}
