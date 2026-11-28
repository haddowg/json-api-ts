import {
  assertInInjectionContext,
  DestroyRef,
  type EnvironmentProviders,
  inject,
  InjectionToken,
  type Injector,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
} from '@angular/core'
import type { ApiDescriptor, Client, WithLinks } from '@haddowg/json-api-client'
import {
  createMutationApi,
  createQueryApi,
  installNormalization,
  JsonApiMutationCache,
  type MutationApi,
  type QueryApi,
} from '@haddowg/json-api-query'
import { QueryClient } from '@tanstack/angular-query'
import { JSON_API_CLIENT, type RegisteredClient } from '../provide'

/**
 * The bound read-option factories of client type `C`: what `createQueryApi(client)` returns, with
 * the client's error codes typing each read's `error`.
 */
export type JsonApiReads<C> =
  C extends Client<infer D, infer A, infer _W, infer _Act, infer E, infer L, infer O>
    ? QueryApi<D, WithLinks<A, L>, E, O>
    : never

/**
 * The bound mutation-option factories of client type `C`: what `createMutationApi(...)` returns,
 * with the client's error codes typing each write's `error`.
 */
export type JsonApiWrites<C> =
  C extends Client<infer D, infer A, infer W, infer _Act, infer E, infer L, infer O>
    ? MutationApi<D, WithLinks<A, L>, W, E, O>
    : never

/** Options for {@link provideJsonApiQuery}. */
export interface JsonApiQueryOptions<C = unknown> {
  /**
   * The client whose reads and writes this registers: a token from `createJsonApiClientToken`,
   * provided with `provideJsonApiClient`. Defaults to the client provided without a token.
   */
  client?: InjectionToken<C>
  /**
   * The scope this client's queries and mutations are cached in, when several servers share the
   * QueryClient. Every key its factories build is led by `{ $scope }`. Omit for one server.
   */
  scope?: string
}

/** What {@link provideJsonApiQuery} registers for one client token, in the injector it runs in. */
interface Registration {
  readonly reads: unknown
  readonly writes: unknown
}

/**
 * One registration token per client token, so a `provideJsonApiQuery` resolves through DI like the
 * client it belongs to: a child environment injector can register its own.
 */
const registrations = new WeakMap<InjectionToken<unknown>, InjectionToken<Registration>>()

function registrationFor(client: InjectionToken<unknown>): InjectionToken<Registration> {
  let token = registrations.get(client)
  if (token === undefined) {
    token = new InjectionToken<Registration>(`JsonApiQuery(${client.toString()})`)
    registrations.set(client, token)
  }
  return token
}

const describeClient = (client: InjectionToken<unknown>): string =>
  client === JSON_API_CLIENT ? 'the default client' : client.toString()

/**
 * Connect a provided JSON:API client to the TanStack `QueryClient` that `provideTanStackQuery`
 * provides. It installs the `type:id` normalisation of `resourceMap` (the generated descriptor) on
 * the QueryClient, torn down when the environment injector is destroyed, and registers the client's
 * bound read and write factories for {@link injectJsonApiReads} and {@link injectJsonApiWrites}.
 *
 * ```ts
 * providers: [
 *   provideHttpClient(),
 *   provideJsonApiClient(createClient, { baseUrl: '/api' }),
 *   provideTanStackQuery(() => new QueryClient({ mutationCache: new JsonApiMutationCache() })),
 *   provideJsonApiQuery(resourceMap),
 * ]
 * ```
 *
 * A second server shares the QueryClient in a scope of its own:
 * `provideJsonApiQuery(adminMap, { client: ADMIN_API, scope: 'admin' })`.
 *
 * It fails when the environment starts if `provideTanStackQuery` is missing, or if the QueryClient
 * wasn't built with a `JsonApiMutationCache`, which runs every write's cache upkeep.
 */
export function provideJsonApiQuery<C>(
  resourceMap: ApiDescriptor,
  options: JsonApiQueryOptions<C> = {},
): EnvironmentProviders {
  const clientToken = (options.client ?? JSON_API_CLIENT) as InjectionToken<unknown>
  const scope = options.scope
  return makeEnvironmentProviders([
    {
      provide: registrationFor(clientToken),
      useFactory: (): Registration => {
        const queryClient = inject(QueryClient)
        const client = inject(clientToken) as never
        return {
          reads: createQueryApi(client, { scope }),
          writes: createMutationApi(queryClient, client, resourceMap, { scope }),
        }
      },
    },
    provideEnvironmentInitializer(() => {
      const queryClient = inject(QueryClient, { optional: true })
      if (queryClient === null) {
        throw new Error(
          '@haddowg/json-api-angular/query: provideJsonApiQuery() found no QueryClient. Add ' +
            'provideTanStackQuery(() => new QueryClient({ mutationCache: new JsonApiMutationCache() })) ' +
            'from @tanstack/angular-query to the same providers.',
        )
      }
      if (!(queryClient.getMutationCache() instanceof JsonApiMutationCache)) {
        throw new Error(
          '@haddowg/json-api-angular/query: the QueryClient provideTanStackQuery() provides was not ' +
            'built with a JsonApiMutationCache, so JSON:API writes could not keep the cache up to ' +
            'date. Build it with new QueryClient({ mutationCache: new JsonApiMutationCache() }) ' +
            '(JsonApiMutationCache comes from @haddowg/json-api-query).',
        )
      }
      const teardown = installNormalization(queryClient, resourceMap, { scope })
      inject(DestroyRef).onDestroy(teardown)
    }),
  ])
}

/**
 * The registration for `token` (the default client without one), or a clear error naming the
 * missing provider. Outside an injection context it needs `injector`.
 */
function registered(
  caller: (...args: never[]) => unknown,
  name: string,
  token: InjectionToken<unknown> | undefined,
  injector: Injector | undefined,
): Registration {
  if (injector === undefined) {
    assertInInjectionContext(caller)
  }
  token ??= JSON_API_CLIENT as InjectionToken<unknown>
  const registration = registrationFor(token)
  const found =
    injector !== undefined
      ? injector.get(registration, null, { optional: true })
      : inject(registration, { optional: true })
  if (found === null) {
    throw new Error(
      `@haddowg/json-api-angular/query: ${name}() found no provideJsonApiQuery() for ` +
        `${describeClient(token)}. Add provideJsonApiQuery(resourceMap${
          token === JSON_API_CLIENT ? '' : ', { client: <its token> }'
        }) to the providers that provide the client.`,
    )
  }
  return found
}

/**
 * The bound read-option factories of a provided client, to pass to TanStack's `injectQuery` and
 * `injectInfiniteQuery`:
 *
 * ```ts
 * private readonly reads = injectJsonApiReads()
 * readonly album = injectQuery(() => this.reads.albums.get(this.id(), { include: ['artist'] }))
 * ```
 *
 * Without a token it reads with the default client, typed by `Register`; with one, the client that
 * token provides. Its scope is the one `provideJsonApiQuery` gave that client.
 */
export function injectJsonApiReads<C = RegisteredClient>(
  token?: InjectionToken<C>,
  options?: { injector?: Injector },
): JsonApiReads<C> {
  return registered(
    injectJsonApiReads,
    'injectJsonApiReads',
    token as InjectionToken<unknown> | undefined,
    options?.injector,
  ).reads as JsonApiReads<C>
}

/**
 * The bound mutation-option factories of a provided client, to spread into TanStack's
 * `injectMutation`. The cache upkeep and optimism run in the `JsonApiMutationCache`, so the
 * callbacks an app adds alongside them never replace it:
 *
 * ```ts
 * private readonly writes = injectJsonApiWrites()
 * readonly rename = injectMutation(() => ({
 *   ...this.writes.albums.id(this.id()).update({ optimistic: true }),
 *   onSuccess: () => this.toast.show('Saved'),
 * }))
 * ```
 *
 * Without a token it writes with the default client, typed by `Register`; with one, the client that
 * token provides.
 */
export function injectJsonApiWrites<C = RegisteredClient>(
  token?: InjectionToken<C>,
  options?: { injector?: Injector },
): JsonApiWrites<C> {
  return registered(
    injectJsonApiWrites,
    'injectJsonApiWrites',
    token as InjectionToken<unknown> | undefined,
    options?.injector,
  ).writes as JsonApiWrites<C>
}
