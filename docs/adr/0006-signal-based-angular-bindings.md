# Angular bindings are signals over an HttpClient transport, with no shared cache

Angular apps route HTTP through `HttpClient` and depend on its interceptors for cookies, tenant hosts and progress, which the default `fetch` transport would skip, and TanStack has no stable Angular adapter. So `@haddowg/json-api-angular` sends through `HttpClient`, wraps reads in Angular's `resource()` and writes in a small signal handle, and leaves RxJS at the edges (`toObservable()`, `from()`). RxJS bindings and TanStack's experimental Angular adapter over the existing query factories were the alternatives.

## Consequences

There is no shared cache: each resource holds its own value and the caller reloads what a write affects. A later cache would be TanStack's Angular adapter or a small signal store keyed by `type:id`. `resource()` is experimental before Angular 22, so only one module touches it.
