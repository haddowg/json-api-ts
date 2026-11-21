/**
 * @haddowg/json-api-angular/query: the JSON:API client on TanStack Query, the Angular way.
 *
 * `provideJsonApiQuery` connects a provided client to the `QueryClient` from `provideTanStackQuery`
 * (installing the `type:id` normalisation), `injectJsonApiReads`/`injectJsonApiWrites` hand out the
 * client's bound option factories, and `JsonApiErrorPipe`/`asJsonApiError` narrow an error to its
 * `JsonApiError`. Queries and mutations are TanStack's own: call `injectQuery`,
 * `injectInfiniteQuery` and `injectMutation` from `@tanstack/angular-query` with these factories.
 */
export { asJsonApiError, JsonApiErrorPipe, type RegisteredErrorCode } from './error'
export {
  injectJsonApiReads,
  injectJsonApiWrites,
  type JsonApiQueryOptions,
  type JsonApiReads,
  type JsonApiWrites,
  provideJsonApiQuery,
} from './provide'
