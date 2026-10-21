/**
 * @haddowg/json-api-angular: signal-based Angular bindings for the JSON:API client.
 *
 * `httpClientTransport` sends through Angular's `HttpClient` so interceptors run;
 * `provideJsonApiClient`/`injectJsonApiClient` put a generated client in DI; `jsonApiResource`
 * wraps a read in Angular's `resource()`; `jsonApiMutation` wraps a write in signals; `nextPage`
 * and `loadAll` page through a materialised collection. See ADR 0006.
 */
export * from './mutation'
export * from './pagination'
export * from './provide'
export * from './resource'
export * from './transport'
