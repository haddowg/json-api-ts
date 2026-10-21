# 0006 — Angular bindings are signals over an HttpClient transport, with no shared cache

- **Status:** Accepted
- **Date:** 2026-10-21

The first Angular consumer routes all HTTP through `HttpClient` and depends on its interceptors
for session cookies, multi-tenant hosts and a progress bar, so the default `fetch` transport
would silently skip all of them. It doesn't use TanStack, which has no stable Angular adapter,
and its new code is moving to signals. We considered RxJS bindings (the plan in CONTEXT.md until
now) and TanStack's experimental Angular adapter over the existing query factories.

We chose signals. `@haddowg/json-api-angular` sends through an `HttpClient` transport by default,
puts the generated client in DI, wraps reads in Angular's own `resource()` and writes in a small
signal handle. RxJS stays at the edges: `toObservable()` on a signal, `from()` on a client call.
Cancellation needed one additive core change, an optional `signal` on `TransportRequest` and on
reads, which `fetchTransport` honours too.

The cost is that there is no shared cache in v1. Each resource holds its own value, nothing is
normalised by `type:id`, and after a write the caller reloads the resources it knows are
affected. If Angular screens later need a shared cache, the choice is between TanStack's Angular
adapter with the existing factories and a small signal store keyed by `type:id`; that waits for
real usage. `resource()` is also experimental before Angular 22, so the bindings touch it in one
module to keep a future change to it contained.
