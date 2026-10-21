import { HttpClient } from '@angular/common/http'
import {
  assertInInjectionContext,
  type EnvironmentProviders,
  inject,
  InjectionToken,
  type Injector,
  makeEnvironmentProviders,
} from '@angular/core'
import type { ClientOptions, JsonApiTransport } from '@haddowg/json-api-client'
import { httpClientTransport } from './transport'

/**
 * Options for {@link provideJsonApiClient}: the client's options with the transport made
 * optional. Leave `transport` out to send through `HttpClient`; set it only to opt out.
 */
export type JsonApiClientOptions = Omit<ClientOptions, 'transport'> & {
  transport?: JsonApiTransport
}

/** A generated client factory: the bound `createClient` a codegen module exports. */
export type JsonApiClientFactory<C> = (options: ClientOptions) => C

/** The client type a generated `createClient` returns. */
export type JsonApiClientOf<F> = F extends (options: ClientOptions) => infer C ? C : never

/**
 * Register the app's default client type once, so `injectJsonApiClient()` and `jsonApiResource()`
 * are typed without a token:
 *
 * ```ts
 * declare module '@haddowg/json-api-angular' {
 *   interface Register {
 *     client: JsonApiClientOf<typeof createClient>
 *   }
 * }
 * ```
 */
// oxlint-disable-next-line typescript/no-empty-object-type -- filled in by module augmentation
export interface Register {}

/** The default client's type: whatever {@link Register} declares, else `unknown`. */
export type RegisteredClient = Register extends { client: infer C } ? C : unknown

/** The token {@link provideJsonApiClient} uses when none is given. */
export const JSON_API_CLIENT = new InjectionToken<unknown>('JSON_API_CLIENT')

/**
 * Create an injection token for one client, so an app can provide several (one per server).
 * Type it with the client: `createJsonApiClientToken<JsonApiClientOf<typeof createAdminClient>>()`.
 */
export function createJsonApiClientToken<C>(description = 'JsonApiClient'): InjectionToken<C> {
  return new InjectionToken<C>(description)
}

/**
 * Provide a generated client to the environment injector. The client sends through `HttpClient`
 * (so `provideHttpClient()` must also be present) unless `options.transport` overrides it.
 *
 * `options` may be a function, which runs in an injection context, to read values such as the
 * base URL from other providers. `token` defaults to {@link JSON_API_CLIENT}; pass one from
 * {@link createJsonApiClientToken} to provide a second client alongside it.
 */
export function provideJsonApiClient<C>(
  createClient: JsonApiClientFactory<C>,
  options: JsonApiClientOptions | (() => JsonApiClientOptions),
  token: InjectionToken<C> = JSON_API_CLIENT as InjectionToken<C>,
): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: token,
      useFactory: (): C => {
        const resolved = typeof options === 'function' ? options() : options
        return createClient({
          ...resolved,
          transport: resolved.transport ?? httpClientTransport(inject(HttpClient)),
        })
      },
    },
  ])
}

/**
 * Inject a provided client. Without a token this returns the default client, typed by
 * {@link Register}. With a token it returns that token's client.
 */
export function injectJsonApiClient<C = RegisteredClient>(
  token?: InjectionToken<C>,
  options?: { injector?: Injector },
): C {
  const resolved = token ?? (JSON_API_CLIENT as InjectionToken<C>)
  if (options?.injector !== undefined) {
    return options.injector.get(resolved)
  }
  assertInInjectionContext(injectJsonApiClient)
  return inject(resolved)
}
