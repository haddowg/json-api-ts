# @haddowg/json-api-angular

> **Part of the [jsonapi.rest](https://jsonapi.rest) suite** — a complete, spec-compliant
> JSON:API 1.1 stack: a framework-agnostic PHP [core](https://github.com/haddowg/json-api), a
> [Symfony bundle](https://github.com/haddowg/json-api-symfony), a
> [Laravel package](https://github.com/haddowg/json-api-laravel), and this **typed TypeScript
> client**, bound together by one conformance-tested OpenAPI 3.1 contract.
> Full documentation: **[haddowg.github.io/json-api-ts](https://haddowg.github.io/json-api-ts/)**.

Signal-based Angular bindings for a generated [`@haddowg/json-api-client`](../client). The client
goes into dependency injection and sends through Angular's `HttpClient`, so your interceptors run
on every request. Reads become signals through Angular's `resource()`, and writes get a small
signal-based mutation handle.

## Install

```bash
npm install @haddowg/json-api-angular @haddowg/json-api-client
```

`@angular/core` and `@angular/common` (20, 21 or 22) are peer dependencies.

## Provide the client

```ts
import { provideHttpClient, withInterceptors } from '@angular/common/http'
import { provideJsonApiClient } from '@haddowg/json-api-angular'
import { createClient } from './api/music.gen'

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withInterceptors([authInterceptor])),
    provideJsonApiClient(createClient, { baseUrl: '/api/v5' }),
  ],
}
```

Register the client's type once so it is typed everywhere without a token:

```ts
import type { JsonApiClientOf } from '@haddowg/json-api-angular'

declare module '@haddowg/json-api-angular' {
  interface Register {
    client: JsonApiClientOf<typeof createClient>
  }
}
```

For a second client (another server), create a token with `createJsonApiClientToken()` and pass it
as the third argument to `provideJsonApiClient`, then to `injectJsonApiClient(token)` or a
resource's `client` option.

## Read with a resource

```ts
@Component({
  template: `
    @if (albums.hasValue()) {
      @for (album of albums.value(); track album.id) {
        <li>{{ album.title }} by {{ album.artist?.name }}</li>
      }
    }
    @if (albums.jsonApiError(); as error) {
      <p>{{ error.status }}</p>
    }
  `,
})
export class AlbumList {
  readonly search = signal('')

  readonly albums = jsonApiResource({
    params: () => ({ filter: { title: this.search() } }),
    loader: ({ client, params, abortSignal }) =>
      client.albums.list({ ...params, include: ['artist'], signal: abortSignal }),
  })
}
```

Changing `search` starts a new read and cancels the one in flight. Return `undefined` from
`params` to hold the read until its inputs are ready. As with any Angular resource, `value()`
throws in the error state, so guard it with `hasValue()`.

`nextPage(list)` and `prevPage(list)` return the `page` params from a collection's links, ready to
set on the signal your params read. `loadAll(firstPage, { signal })` follows `next` links and
returns every member in one array.

## Write with a mutation

```ts
readonly rename = jsonApiMutation((client, title: string) =>
  client.albums.id(this.id()).update({ title }),
)

save(title: string) {
  this.rename.mutate(title).then(() => this.albums.reload(), () => {})
}
```

`isPending()`, `error()`, `jsonApiError()`, `value()` and `reset()` track the latest call. Nothing
is cached between resources, so reload the reads a write affects.

## TanStack Query

For a shared cache, the `@haddowg/json-api-angular/query` entry point runs the client on
[TanStack Query](https://tanstack.com/query/latest/docs/framework/angular/overview) with the
`type:id` normalised cache from [`@haddowg/json-api-query`](../query): a write updates every cached
read of the resources it returns, with no refetch. It needs Angular 20.1 or later (TanStack's own
floor; the root entry above still works on 20.0) and two more packages, which are optional peer
dependencies of this one. `@tanstack/angular-query` is ES modules only, so a CommonJS `require` of
the entry needs Node.js 20.19 or later, the floor this package declares:

```bash
npm install @tanstack/angular-query @haddowg/json-api-query
```

Build the `QueryClient` with a `JsonApiMutationCache`, which runs every write's cache upkeep, and
install the generated `resourceMap` with `provideJsonApiQuery`:

```ts
import { JsonApiMutationCache } from '@haddowg/json-api-query'
import { provideJsonApiQuery } from '@haddowg/json-api-angular/query'
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query'
import { createClient, resourceMap } from './api/music.gen'

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withInterceptors([authInterceptor])),
    provideJsonApiClient(createClient, { baseUrl: '/api/v5' }),
    provideTanStackQuery(() => new QueryClient({ mutationCache: new JsonApiMutationCache() })),
    provideJsonApiQuery(resourceMap),
  ],
}
```

Then pass the client's bound factories to TanStack's own `injectQuery`, `injectInfiniteQuery` and
`injectMutation`. They are typed by the `Register` above, and the `jsonApiError` pipe narrows an
`error()` to its `JsonApiError`:

```ts
import {
  injectJsonApiReads,
  injectJsonApiWrites,
  JsonApiErrorPipe,
} from '@haddowg/json-api-angular/query'
import { injectMutation, injectQuery } from '@tanstack/angular-query'

@Component({
  imports: [JsonApiErrorPipe],
  template: `
    <h1>{{ album.data()?.title }}</h1>
    @if (rename.error() | jsonApiError; as error) {
      <p>{{ error.byPath()['title']?.[0]?.detail }}</p>
    }
  `,
})
export class AlbumPage {
  private readonly reads = injectJsonApiReads()
  private readonly writes = injectJsonApiWrites()
  readonly id = input.required<string>()

  readonly album = injectQuery(() => this.reads.albums.get(this.id(), { include: ['artist'] }))
  readonly rename = injectMutation(() => ({
    ...this.writes.albums.id(this.id()).update({ optimistic: true }),
    onSuccess: () => this.toast.show('Saved'), // the cache upkeep runs regardless
  }))
}
```

A second server shares the `QueryClient` in a scope of its own:
`provideJsonApiQuery(adminMap, { client: ADMIN_API, scope: 'admin' })`, then
`injectJsonApiReads(ADMIN_API)`. `provideJsonApiQuery` fails at startup if `provideTanStackQuery`
is missing or its `QueryClient` has no `JsonApiMutationCache`.

See the [Angular guide](https://haddowg.github.io/json-api-ts/angular/) for the details.

## License

MIT
