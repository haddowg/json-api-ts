import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http'
import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core'
import { type JsonApiClientOf, provideJsonApiClient } from '@haddowg/json-api-angular'
import { createClient } from '../generated/music-catalog.gen'
import { mockBackendInterceptor } from './mock-backend'
import { trackRequestsInterceptor } from './request-tracker'

// Type the default client once, so injectJsonApiClient() and jsonApiResource() know its shape.
declare module '@haddowg/json-api-angular' {
  interface Register {
    client: JsonApiClientOf<typeof createClient>
  }
}

const API_URL = '/api'

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
    provideJsonApiClient(createClient, { baseUrl: API_URL }),
  ],
}
