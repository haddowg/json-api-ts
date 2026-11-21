import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http'
import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core'
import { type JsonApiClientOf, provideJsonApiClient } from '@haddowg/json-api-angular'
import { provideJsonApiQuery } from '@haddowg/json-api-angular/query'
import { JsonApiMutationCache } from '@haddowg/json-api-query'
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query'
import { createClient, resourceMap } from '../generated/music-catalog.gen'
import { mockBackendInterceptor } from './mock-backend'
import { trackRequestsInterceptor } from './request-tracker'

// Type the default client once, so injectJsonApiReads() and injectJsonApiWrites() know its shape.
declare module '@haddowg/json-api-angular' {
  interface Register {
    client: JsonApiClientOf<typeof createClient>
  }
}

export const API_URL = '/api'

// The JSON:API client over HttpClient, and TanStack Query on top of it. The mutation cache runs
// each write's cache upkeep (and its optimistic edit), so it has to be a JsonApiMutationCache.
// For the query devtools, pass `withDevtools()` from `@tanstack/angular-query-devtools` as the
// second argument of `provideTanStackQuery`.
export const apiProviders = [
  provideJsonApiClient(createClient, { baseUrl: API_URL }),
  provideTanStackQuery(
    () =>
      new QueryClient({
        mutationCache: new JsonApiMutationCache(),
        defaultOptions: { queries: { staleTime: 30_000 } },
      }),
  ),
  provideJsonApiQuery(resourceMap),
]

// Add `?live` to the page URL to talk to a real server through the dev-server proxy
// (proxy.conf.json) instead of the in-memory mock.
const live = new URLSearchParams(location.search).has('live')

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(
      withFetch(),
      withInterceptors(
        live
          ? [trackRequestsInterceptor]
          : [trackRequestsInterceptor, mockBackendInterceptor(API_URL)],
      ),
    ),
    ...apiProviders,
  ],
}
