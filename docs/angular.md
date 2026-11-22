# Angular

`@haddowg/json-api-angular` binds a generated client to Angular. The client goes into dependency injection and sends every request through Angular's `HttpClient`, so your interceptors run. The typing is the client's own: `include` hydrates relations and sparse `fields` narrow the result, in components and in templates.

On top of that, pick one of two ways to read and write:

- **[TanStack Query](#tanstack-query)**, from `@haddowg/json-api-angular/query`. Reads and writes are TanStack's own `injectQuery` and `injectMutation`, over the `type:id` normalised cache of [`@haddowg/json-api-query`](tanstack-query.md): a write updates every cached read of the resources it returns, optimistically if you ask, and reads are shared between components. Choose it for most apps.
- **[The lightweight path](#the-lightweight-path)**, from the root entry. `jsonApiResource` wraps a read in Angular's `resource()` and `jsonApiMutation` wraps a write in signals. There is no cache: each read holds its own value. Choose it when an app needs neither a shared cache nor TanStack.

Both start from the same client setup.

## Set up the client

```bash
npm install @haddowg/json-api-angular @haddowg/json-api-client
```

`@angular/core` and `@angular/common` are peer dependencies. The root entry supports Angular 20, 21 and 22, the versions whose `resource()` takes a `params` function.

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

### The HttpClient transport

`provideJsonApiClient` builds the client with `httpClientTransport(inject(HttpClient))`. You can also use it directly with `createClient({ baseUrl, transport: httpClientTransport(http) })`. It implements the same [transport contract](reads.md#cancelling-a-read) as `fetchTransport`:

- Requests go through `http.request(method, url, { body, headers, observe: 'response', responseType: 'text' })`. Every interceptor in the chain sees them: auth, tenant host rewriting, credentials, a progress bar.
- A [custom action](custom-actions.md#raw-responses) with a binary response asks for a `Blob` or `ArrayBuffer` instead of text, and a binary, multipart or form request body (`rawBody`) goes to `HttpClient` as is. A failed binary request's error body is read back as text, so it still throws a typed `JsonApiError`.
- A non-2xx response **resolves** with its status, headers and body. The client then throws its usual typed `JsonApiError`, so error handling is the same as with `fetch`.
- Only a request that got no response at all (status 0: a network failure, CORS, a blocked request) rejects, with Angular's `HttpErrorResponse`.
- Response headers are copied into a plain record with lowercase names.
- Aborting the request's signal unsubscribes, which cancels the HTTP request.

Set `transport` in the options only to opt out of `HttpClient`.

## TanStack Query

The snippets in this section come from [`examples/angular-catalog`](../examples/angular-catalog), whose render test [app.spec.ts](../examples/angular-catalog/src/app/app.spec.ts) drives them through the real components, and from the package's own tests: [provide.test.ts](../packages/angular/src/query/provide.test.ts), [error.test.ts](../packages/angular/src/query/error.test.ts) and [typing.test.ts](../packages/angular/src/query/typing.test.ts).

### Install

```bash
npm install @haddowg/json-api-query @tanstack/angular-query
```

The `/query` entry needs Angular 20.1 or later and TypeScript 5.8 or later, which `@tanstack/angular-query` requires. The root entry still supports Angular 20.0.

`@tanstack/angular-query` depends on one exact version of `@tanstack/query-core`, and `@haddowg/json-api-query` takes `@tanstack/query-core` as a peer. Keep a single copy: if your package manager installs a second, add `@tanstack/query-core` at the version `@tanstack/angular-query` pins (an `overrides` or `resolutions` entry works too). With two copies, `JsonApiMutationCache` would extend a different `MutationCache` from the one the adapter's `QueryClient` works with.

`@tanstack/angular-query` is published as ES modules only. Angular's build tooling loads it either way; a CommonJS `require` of the `/query` entry needs a Node.js that can `require()` ES modules (20.19 or 22).

### Set up

Provide TanStack's `QueryClient` with `provideTanStackQuery`, built with a `JsonApiMutationCache`, and connect the client to it with `provideJsonApiQuery`, passing the generated `resourceMap`. From [app.config.ts](../examples/angular-catalog/src/app/app.config.ts):

```ts
import { provideJsonApiClient } from '@haddowg/json-api-angular'
import { provideJsonApiQuery } from '@haddowg/json-api-angular/query'
import { JsonApiMutationCache } from '@haddowg/json-api-query'
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query'
import { createClient, resourceMap } from '../generated/music-catalog.gen'

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
```

- The `JsonApiMutationCache` runs each write's cache upkeep: its optimistic change and rollback, normalising the response, and invalidating what it may have changed. See [how the upkeep runs](tanstack-query.md#how-the-upkeep-runs).
- `provideJsonApiQuery` installs the `type:id` [normalisation](tanstack-query.md#normalisation-typeid-write-through-patching) on that `QueryClient`, removed again when the environment injector is destroyed, and registers the client's bound read and write factories.
- It fails when the app starts if `provideTanStackQuery` is missing, or if the `QueryClient` wasn't built with a `JsonApiMutationCache`.

To make every write [optimistic](optimistic-updates.md#turning-it-on) unless it says otherwise, build the cache with `new JsonApiMutationCache({ optimistic: true })`.

### Reads

`injectJsonApiReads()` returns the client's bound read factories. Each returns TanStack options, typed by the read: pass them to TanStack's own `injectQuery`, and spread them to add options of your own. From [album-list.ts](../examples/angular-catalog/src/app/album-list.ts):

```ts
import { injectJsonApiReads } from '@haddowg/json-api-angular/query'
import { injectQuery, keepPreviousData, skipToken } from '@tanstack/angular-query'

export class AlbumList {
  private readonly reads = injectJsonApiReads()

  readonly search = signal('')
  readonly page = signal<AlbumsPage>(FIRST_PAGE)
  readonly selectedId = signal<string | undefined>(undefined)

  // Typing in the box changes the key, which cancels the request still in flight. The previous
  // page stays on screen until the new one arrives.
  readonly albums = injectQuery(() => ({
    ...this.reads.albums.list({
      filter: { title: this.search() },
      page: this.page(),
      sort: 'title',
      include: ['artist'],
      fields: { albums: ['title', 'releasedAt', 'artist'], artists: ['name'] },
    }),
    placeholderData: keepPreviousData,
  }))

  // Idle until an album is picked: skipToken stands where the id would go.
  readonly selected = injectQuery(() =>
    this.reads.albums.get(this.selectedId() ?? skipToken, { include: ['artist'] }),
  )
}
```

- The function passed to `injectQuery` reads signals, so the query follows them. A new key aborts the request still in flight, which the catalog's `filtering cancels the request it supersedes` test shows.
- `placeholderData: keepPreviousData` keeps the previous page on screen while the next one loads, and `isPlaceholderData()` says when that is happening.
- `skipToken` in place of the id, or of a list's whole query, keeps the read idle until its input exists. See [skipping a read](tanstack-query.md#skipping-a-read-with-skiptoken).
- `data()` carries the read's exact type, so with `strictTemplates` a template that reads a field the fieldset left out fails to compile. The [document meta](reads.md#document-meta) the server declares is typed too: the template reads `list.$meta.explicitCount`.

`nextPage(list)` and `prevPage(list)` from the root entry turn a collection's `next` and `prev` links into `page` parameters, typed by its `$page`, so a page signal drives a numbered pager:

```ts
next(): AlbumsPage | undefined {
  return nextPage(this.albums.data())
}
```

For a list that grows, `reads.<type>.infinite(query)` goes to TanStack's `injectInfiniteQuery`, and each page is the typed `Collection` that `list(query)` resolves. From [provide.test.ts](../packages/angular/src/query/provide.test.ts):

```ts
const reads = injectJsonApiReads()
const albums = injectInfiniteQuery(() => reads.albums.infinite({ page: { size: 1 } }))

albums.fetchNextPage()
albums.data()?.pages.map((page) => page.map((a) => a.title)) // [['OK Computer'], ['Kid A']]
albums.hasNextPage() // false on the last page
```

See [infinite queries](tanstack-query.md#infinite-queries). The rest is plain TanStack: `injectQueries`, `select`, `injectIsFetching`.

A [singleton](reads.md#singletons) takes no id. From [account.ts](../examples/angular-catalog/src/app/account.ts):

```ts
protected readonly account = injectQuery(() => this.reads.accounts.get())
```

### Writes

`injectJsonApiWrites()` returns the bound write factories. Spread one into TanStack's `injectMutation` and add your own callbacks beside it: the cache upkeep runs in the `JsonApiMutationCache`, so a callback you add never replaces it. From [album-list.ts](../examples/angular-catalog/src/app/album-list.ts):

```ts
private readonly writes = injectJsonApiWrites()

// The new title shows at once, in the list and the detail alike, and is rolled back if the
// server refuses it. On success the server's version patches both in place: no refetch. The
// album's id travels in the variables, so one mutation renames whichever album is picked.
readonly rename = injectMutation(() => ({
  ...this.writes.albums.update({ optimistic: true }),
  onMutate: () => this.saved.set(undefined),
  onSuccess: (album: { title: string }) => this.saved.set(`Saved as "${album.title}"`),
}))
```

```html
@for (album of list; track album.id) {
  <li [class.pending]="album.$optimistic">
    <button type="button" (click)="selectedId.set(album.id)">{{ album.title }}</button>
  </li>
}

<form (submit)="$event.preventDefault(); rename.mutate({ id: album.id, title: title.value })">
  <input #title [value]="album.title" aria-label="Title" />
  <button type="submit" [disabled]="rename.isPending()">Rename</button>
</form>
```

- `writes.<type>.update()` and `writes.<type>.delete()` take the resource's id in the variables, so one mutation serves a whole list. `writes.<type>.id(id).update()` fixes the id when the mutation is built instead.
- With `{ optimistic: true }` the change shows on every cached copy before the server answers, and a failed write rolls it back.
- `album.$optimistic` is `'pending'` on a resource a pending write touched, so a template can mark it. `$pending(rel)` lists the members a pending write is adding to a relation.
- On success the response patches every cached copy in place, so the list and the detail show the server's title without a refetch. The catalog's `renaming an album optimistically` tests show both outcomes.

Every write is a factory: `create`, `delete`, the relationship verbs, [custom actions](custom-actions.md) and [atomic batches](atomic-operations.md). [Optimistic updates](optimistic-updates.md) covers what each one predicts, where the change shows, and placing new members, and [mutation keys](tanstack-query.md#mutation-keys) covers finding pending writes with `injectMutationState`.

A singleton's update passes the id its read returned, since the request body must carry it. From [account.ts](../examples/angular-catalog/src/app/account.ts):

```ts
protected readonly rename = injectMutation(() => this.writes.accounts.update())
```

```html
<form (submit)="$event.preventDefault(); rename.mutate({ id: me.id, displayName: name.value })">
```

### Errors

A read's `error()` is typed `ReadError<ErrorCode> | null` and a write's `MutationError<ErrorCode> | null`, carrying the error codes the server documents (see [match on an error code](errors.md#match-on-an-error-code)): a `JsonApiError` for a non-2xx response, a `StructuralGuardError` for a response that isn't a JSON:API document, or any other `Error` for a transport failure.

Templates can't use `instanceof`, so the standalone `jsonApiError` pipe narrows an error to its `JsonApiError`, or `undefined`. Add `JsonApiErrorPipe` to the component's `imports`. From [album-list.ts](../examples/angular-catalog/src/app/album-list.ts):

```html
@if (albums.error() | jsonApiError; as error) {
  <p class="error">Could not load albums ({{ error.status }})</p>
}

@if (rename.error() | jsonApiError; as error) {
  <p class="error">{{ error.byPath()['title']?.[0]?.detail }}</p>
}
```

A `422` arrives with the client's flat error paths, so `byPath()` keys match your form fields. In code, `asJsonApiError(error)` does the same and keeps the error's codes. From [typing.test.ts](../packages/angular/src/query/typing.test.ts):

```ts
asJsonApiError(adminAlbum.error()) // JsonApiError<AdminErrorCode> | undefined
```

When you configure no `retry`, reads don't retry a `4xx` or a response that isn't a JSON:API document. See [typed errors and retries](tanstack-query.md#typed-errors-and-retries).

### Several servers

An app that talks to two servers provides two clients, the second under its own token, and gives each a `provideJsonApiQuery`. They share one `QueryClient`, each in its own [scope](tanstack-query.md#several-servers), so the same type on both servers never meets in the cache. From [provide.test.ts](../packages/angular/src/query/provide.test.ts):

```ts
const ADMIN = createJsonApiClientToken<ReturnType<typeof createAdminClient>>('AdminApi')

providers: [
  provideJsonApiClient(createMusicClient, { baseUrl: BASE }),
  provideJsonApiClient(createAdminClient, { baseUrl: ADMIN_BASE }, ADMIN),
  provideTanStackQuery(() => new QueryClient({ mutationCache: new JsonApiMutationCache() })),
  provideJsonApiQuery(descriptor),
  provideJsonApiQuery(descriptor, { client: ADMIN, scope: 'admin' }),
]
```

Then pass the token to the inject functions: `injectJsonApiReads(ADMIN)` and `injectJsonApiWrites(ADMIN)` read and write through the admin client, in its scope, typed by its own resources and error codes.

### Prefetching

A route resolver runs in an injection context, so it can fill the cache before the component renders: `ensureQueryData` resolves with the cached read when it is fresh and fetches it otherwise. From [provide.test.ts](../packages/angular/src/query/provide.test.ts):

```ts
const prefetchAlbum = (id: string) =>
  inject(QueryClient).ensureQueryData(injectJsonApiReads().albums.get(id))
```

Return it from a `ResolveFn`, such as `(route) => prefetchAlbum(route.paramMap.get('id')!)`. The component's `injectQuery` with the same read then renders from the cache without a second request, as long as the `staleTime` keeps it fresh. `prefetchQuery` works the same way for prefetching on hover.

### Devtools

TanStack's query devtools show the JSON:API reads by their keys. Pass `withDevtools()` from `@tanstack/angular-query-devtools` as the second argument of `provideTanStackQuery`, as the note in [app.config.ts](../examples/angular-catalog/src/app/app.config.ts) says.

### Server-side rendering

Server-side rendering isn't supported. A read's result loses its `$page`, `$self` and other `$`-accessors when TanStack transfers it from the server, so `provideJsonApiQuery` keeps the JSON:API reads out of the transferred state and they fetch again in the browser. A read that still arrives without its accessors is reset, so it refetches, with a development warning. See [server-side rendering](tanstack-query.md#server-side-rendering).

## The lightweight path

The root entry reads with Angular's `resource()` and writes with a small signal handle, with no TanStack and no shared cache. Each read holds its own value, so after a write you `reload()` the reads you know it affects.

### Reading with `jsonApiResource`

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

The result is Angular's `ResourceRef`: `value()`, `status()`, `isLoading()`, `error()`, `hasValue()`, `reload()`, `set()` and `destroy()`. `value()` carries the read's exact type, with its declared [document meta](reads.md#document-meta), so `strictTemplates` catches a field the fieldset left out. A few behaviours come straight from `resource()`:

- When `params` returns `undefined`, the resource stays `idle` and doesn't call the loader. Use it to wait for an id.
- Leave `params` out to load once, when the resource is created.
- `reload()` runs the loader again with the same params. The status is `reloading` and the old value stays visible meanwhile.
- `value()` throws while the resource is in the `error` state. Guard it with `hasValue()`, which also narrows `value()` past `undefined` in a template.

`jsonApiResource` must be called in an injection context, such as a field initialiser or a constructor. Pass `injector` to create one elsewhere.

Every time `params` produces a new value, `resource()` aborts the previous load's signal. Pass it to the read as `signal: abortSignal` and the transport cancels the request on the wire, so typing in a search box leaves one request in flight. Destroying the component aborts the same way.

!!! note "`resource()` is experimental before Angular 22"
    Angular marks `resource()` experimental in versions 20 and 21 and stable from 22. The bindings use it in one module, so if its options or ref change again, the fix is in that module and your code keeps the same `jsonApiResource` call.

### Errors on a resource

`error()` is typed as `JsonApiError | StructuralGuardError | Error`; narrow it with `instanceof`. Templates can't, so the resource also has `jsonApiError()`, the error when it is a `JsonApiError` and `undefined` otherwise, typed by the client's [error codes](errors.md#match-on-an-error-code):

```html
@if (album.jsonApiError(); as error) {
  @if (error.isNotFound()) {
    <p>That album doesn't exist.</p>
  } @else {
    <p>Something went wrong ({{ error.status }}).</p>
  }
}
```

### Pagination

`nextPage(list)` and `prevPage(list)` return the `page` parameters of a collection's `next` and `prev` links, or `undefined` at the end. Keep the page in a signal that `params` reads, and set it from the helper:

```ts
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

`loadAll(firstPage, { signal })` follows `next` links until the last page and returns every member in one array, for the options of a dropdown, say. Pass the abort signal to the read and to `loadAll`, so a superseded load stops between pages too, and `maxPages` caps the walk.

### Writing with `jsonApiMutation`

`jsonApiMutation()` wraps a write. Give it a function that takes the client and an input:

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
- `isPending()` is true while a call is in flight, `value()` is the latest successful result, and `error()` / `jsonApiError()` the latest failure. A new call clears the error, and `reset()` clears both.

When calls overlap, the signals follow the latest one. The function can be any client write, including a singleton's update, which passes the id its read returned: `client.inboxes.update({ id: this.inbox.value()!.id, seenUpTo })`. See [writes](writes.md).

### More than one client

Give the second client its own token, as in [several servers](#several-servers), and pass it as `client: ADMIN_API` in the options of `jsonApiResource` and `jsonApiMutation`, or to `injectJsonApiClient(ADMIN_API)`. The token types the client, so the loader is typed for that server's resources.

## RxJS

Both paths are signals, but RxJS stays available at the edges. `toObservable(albums.data)` from `@angular/core/rxjs-interop` turns a signal into an observable, and `from(client.albums.list())` turns any client call into one, for an NgRx effect for example.

## See it in the example app

[`examples/angular-catalog`](../examples/angular-catalog) is a small standalone Angular app on the music-catalog client and TanStack Query:

- [app.config.ts](../examples/angular-catalog/src/app/app.config.ts) provides the client, TanStack Query with a `JsonApiMutationCache`, and `provideJsonApiQuery`, and registers the client's type.
- [request-tracker.ts](../examples/angular-catalog/src/app/request-tracker.ts) is an interceptor that counts requests, including the ones a new filter cancels.
- [album-list.ts](../examples/angular-catalog/src/app/album-list.ts) has a filtered, paginated list, a detail read idle until an album is picked, and an optimistic rename.
- [account.ts](../examples/angular-catalog/src/app/account.ts) reads and renames the caller's account, a singleton.
- [app.spec.ts](../examples/angular-catalog/src/app/app.spec.ts) renders the app against an in-memory server and drives each of them.
