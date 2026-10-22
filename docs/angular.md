# Angular

`@haddowg/json-api-angular` binds a generated client to Angular. The client goes into dependency injection, sends every request through Angular's `HttpClient` so your interceptors run, and reads become signals through Angular's `resource()`. Writes get a small signal-based handle. The typing is the client's own: `include` hydrates relations and sparse `fields` narrow the result, in components and in templates.

```bash
npm install @haddowg/json-api-angular @haddowg/json-api-client
```

`@angular/core` and `@angular/common` are peer dependencies. The package supports Angular 20, 21 and 22, the versions whose `resource()` takes a `params` function.

## Set up

Provide `HttpClient` and the client together. `createClient` is the bound factory from your generated module; the options are the client's own, without `transport`:

```ts
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http'
import type { ApplicationConfig } from '@angular/core'
import { provideJsonApiClient } from '@haddowg/json-api-angular'
import { createClient } from './api/music.gen'

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    provideJsonApiClient(createClient, {
      baseUrl: '/api/v5',
      headers: () => ({ 'X-CSRF-Token': readCsrfCookie() }),
    }),
  ],
}
```

The options can also be a function. It runs in an injection context, so it can read other providers:

```ts
provideJsonApiClient(createClient, () => ({ baseUrl: inject(API_URL) }))
```

Then declare the client's type once, so every helper is typed without naming it again:

```ts
import type { JsonApiClientOf } from '@haddowg/json-api-angular'
import type { createClient } from './api/music.gen'

declare module '@haddowg/json-api-angular' {
  interface Register {
    client: JsonApiClientOf<typeof createClient>
  }
}
```

`injectJsonApiClient()` returns the client wherever you need it directly, in a service or an NgRx effect.

## The HttpClient transport

`provideJsonApiClient` builds the client with `httpClientTransport(inject(HttpClient))`. You can also use it directly with `createClient({ baseUrl, transport: httpClientTransport(http) })`. It implements the same [transport contract](reads.md#cancelling-a-read) as `fetchTransport`:

- Requests go through `http.request(method, url, { body, headers, observe: 'response', responseType: 'text' })`. Every interceptor in the chain sees them: auth, tenant host rewriting, credentials, a progress bar.
- A non-2xx response **resolves** with its status, headers and body. The client then throws its usual typed `JsonApiError`, so error handling is the same as with `fetch`.
- Only a request that got no response at all (status 0: a network failure, CORS, a blocked request) rejects, with Angular's `HttpErrorResponse`.
- Response headers are copied into a plain record with lowercase names.
- Aborting the request's signal unsubscribes, which cancels the HTTP request.

Set `transport` in the options only to opt out of `HttpClient`.

## Reading with `jsonApiResource`

`jsonApiResource()` is a thin wrapper over Angular's `resource()`. `params` computes the read's inputs from signals. The loader gets the client, the params and an abort signal, and returns the client call's promise:

```ts
@Component({
  selector: 'app-albums',
  template: `
    <input (input)="search.set($any($event.target).value)" />
    @if (albums.hasValue()) {
      @for (album of albums.value(); track album.id) {
        <li>{{ album.title }} by {{ album.artist?.name }}</li>
      }
    }
    @if (albums.isLoading()) {
      <p>Loading…</p>
    }
  `,
})
export class Albums {
  readonly search = signal('')

  readonly albums = jsonApiResource({
    params: () => ({ filter: { title: this.search() } }),
    loader: ({ client, params, abortSignal }) =>
      client.albums.list({
        ...params,
        include: ['artist'],
        fields: { albums: ['title', 'artist'], artists: ['name'] },
        signal: abortSignal,
      }),
  })
}
```

The result is Angular's `ResourceRef`: `value()`, `status()`, `isLoading()`, `error()`, `hasValue()`, `reload()`, `set()` and `destroy()`. `value()` carries the read's exact type, so with `strictTemplates` a template that reads `album.status` fails to compile, because the fieldset left it out.

A few behaviours come straight from `resource()`:

- When `params` returns `undefined`, the resource stays `idle` and doesn't call the loader. Use it to wait for an id:

    ```ts
    readonly album = jsonApiResource({
      params: () => {
        const id = this.albumId()
        return id === undefined ? undefined : { id }
      },
      loader: ({ client, params, abortSignal }) =>
        client.albums.get(params.id, { include: ['artist'], signal: abortSignal }),
    })
    ```

- Leave `params` out to load once, when the resource is created.
- `reload()` runs the loader again with the same params. The status is `reloading` and the old value stays visible meanwhile.
- `value()` throws while the resource is in the `error` state. Guard it with `hasValue()`, which also narrows `value()` past `undefined` in a template.
- `defaultValue` gives `value()` something to return before the first load, and removes `undefined` from its type.

`jsonApiResource` must be called in an injection context, such as a field initialiser or a constructor. Pass `injector` to create one elsewhere.

!!! note "`resource()` is experimental before Angular 22"
    Angular marks `resource()` experimental in versions 20 and 21 and stable from 22. The bindings use it in one module, so if its options or ref change again, the fix is in that module and your code keeps the same `jsonApiResource` call.

## Cancellation

Every time `params` produces a new value, `resource()` aborts the previous load's signal. Pass that signal to the read as `signal: abortSignal` and the transport unsubscribes from `HttpClient`, which cancels the request on the wire. Typing in a search box therefore leaves one request in flight, not one per keystroke. Destroying the component, or calling `destroy()`, aborts the same way.

The `signal` option is part of the core client, so it works outside Angular too. See [cancelling a read](reads.md#cancelling-a-read).

## Errors

`error()` is typed as `JsonApiError | StructuralGuardError | Error`. Narrow it with `instanceof`:

- `JsonApiError` is a non-2xx response, with its status matchers and error objects. See [errors](errors.md).
- `StructuralGuardError` is a response that isn't a JSON:API document.
- Anything else is a transport failure, such as the `HttpErrorResponse` for a network error, or an error from your validator.

Templates can't use `instanceof`, so the resource also has `jsonApiError()`, the error when it is a `JsonApiError` and `undefined` otherwise. With a generated client it is a `JsonApiError<ErrorCode>`, typed by the client's documented [error codes](errors.md#match-on-an-error-code):

```html
@if (album.jsonApiError(); as error) {
  @if (error.isNotFound()) {
    <p>That album doesn't exist.</p>
  } @else {
    <p>Something went wrong ({{ error.status }}).</p>
  }
}
```

## Pagination

Two helpers read a materialised collection's `$page`.

`nextPage(list)` returns the `page` parameters of the collection's `next` link, or `undefined` on the last page. `prevPage(list)` does the same for `prev`. The server's links already carry the right parameters, so this works the same for every strategy. The result is typed by the collection's `$page`: counts are numbers, cursors are strings, renamed keys keep their wire names, and a read that picked a MultiPaginator arm gets its `kind` back. Keep the page in a signal that `params` reads, and set it from the helper:

```ts
// ListPageParams comes from @haddowg/json-api-client, resourceMap from your generated client.
readonly page = signal<ListPageParams<typeof resourceMap, 'albums'>>({ size: 20 })

readonly albums = jsonApiResource({
  params: () => ({ page: this.page() }),
  loader: ({ client, params, abortSignal }) =>
    client.albums.list({ ...params, signal: abortSignal }),
})

next() {
  const page = this.albums.hasValue() ? nextPage(this.albums.value()) : undefined
  if (page) this.page.set(page)
}
```

`loadAll(firstPage, { signal })` follows `next` links until the last page and returns every member in one plain array. Use it in a loader to read a whole collection, such as the options for a dropdown:

```ts
readonly genres = jsonApiResource({
  loader: ({ client, abortSignal }) =>
    loadAll(client.genres.list({ page: { size: 100 }, signal: abortSignal }), {
      signal: abortSignal,
    }),
})
```

Pass the abort signal to both calls, so a superseded load stops between pages as well as during one. `maxPages` caps the walk when a collection might be larger than you expect.

## More than one client

An app that talks to two servers provides two clients. Give the second one its own token:

```ts
import { createJsonApiClientToken, type JsonApiClientOf } from '@haddowg/json-api-angular'
import { createClient as createAdminClient } from './api/admin.gen'

export const ADMIN_API = createJsonApiClientToken<JsonApiClientOf<typeof createAdminClient>>('admin')

providers: [
  provideJsonApiClient(createClient, { baseUrl: '/api/v5' }),
  provideJsonApiClient(createAdminClient, { baseUrl: '/admin/api' }, ADMIN_API),
]
```

Then pass the token wherever you use that client: `injectJsonApiClient(ADMIN_API)`, or `client: ADMIN_API` in the options of `jsonApiResource` and `jsonApiMutation`. The token types the client, so the loader is typed for that server's resources.

## Writing with `jsonApiMutation`

`resource()` is for reads: it aborts a load when its params change, which is the wrong thing to do to a write. `jsonApiMutation()` wraps a write instead. Give it a function that takes the client and an input:

```ts
readonly rename = jsonApiMutation((client, input: { id: string; title: string }) =>
  client.albums.id(input.id).update({ title: input.title }),
)

save(id: string, title: string) {
  this.rename.mutate({ id, title }).then(
    () => this.albums.reload(),
    () => {}, // the error is on rename.error()
  )
}
```

```html
<button [disabled]="rename.isPending()">Save</button>
@if (rename.jsonApiError(); as error) {
  <p>{{ error.byPath()['title']?.[0]?.detail }}</p>
}
```

- `mutate(input)` runs the write. It resolves with the result and rejects with the error, so `await` it or attach a rejection handler.
- `isPending()` is true while a call is in flight.
- `value()` is the latest successful result, and `error()` / `jsonApiError()` the latest failure. A new call clears the error.
- `reset()` clears both. A call still in flight when you reset no longer updates the signals.

When calls overlap, the signals follow the latest one. The function can be any client write: `create`, `update`, `delete`, a relationship mutation, a [custom action](custom-actions.md) or an [atomic batch](atomic-operations.md). A `422` arrives with the client's flat error paths, so `byPath()` keys match your form fields. See [writes](writes.md).

## No shared cache

Each resource holds its own value. There is no normalised cache and no automatic invalidation, so after a write you `reload()` the resources you know it affects. That is a deliberate first step (see [ADR 0006](https://github.com/haddowg/json-api-ts/blob/main/docs/adr/0006-signal-based-angular-bindings.md)). If several screens need to share fetched resources, the [TanStack Query bindings](tanstack-query.md) have the `type:id` write-through cache.

## RxJS

The bindings are signals, but RxJS stays available at the edges. `toObservable(albums.value)` from `@angular/core/rxjs-interop` turns a resource's value into an observable, and `from(client.albums.list())` turns any client call into one, for an NgRx effect for example.

## See it in the example app

[`examples/angular-catalog`](../examples/angular-catalog) is a small standalone Angular app on the music-catalog client:

- [app.config.ts](../examples/angular-catalog/src/app/app.config.ts) provides the client and registers its type.
- [request-tracker.ts](../examples/angular-catalog/src/app/request-tracker.ts) is an interceptor that counts requests, including the ones a new filter cancels.
- [album-list.ts](../examples/angular-catalog/src/app/album-list.ts) has a filtered, paginated list, a detail resource gated on a selected id, and a rename mutation.
