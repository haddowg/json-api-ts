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

See the [Angular guide](https://haddowg.github.io/json-api-ts/angular/) for the details.

## License

MIT
