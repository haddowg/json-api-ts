import { provideHttpClient } from '@angular/common/http'
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing'
import { effect, type EnvironmentProviders, inject, Injector, signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { JsonApiMutationCache } from '@haddowg/json-api-query'
import {
  injectInfiniteQuery,
  injectMutation,
  injectQuery,
  MutationCache,
  provideTanStackQuery,
  QueryClient,
} from '@tanstack/angular-query'
import { describe, expect, it } from 'vitest'
import { createJsonApiClientToken, provideJsonApiClient } from '../provide'
import {
  album,
  albumDocument,
  albumsPage,
  BASE,
  createAdminClient,
  createMusicClient,
  descriptor,
  settle,
} from '../test-api'
import { injectJsonApiReads, injectJsonApiWrites, provideJsonApiQuery } from './provide'

const ADMIN = createJsonApiClientToken<ReturnType<typeof createAdminClient>>('AdminApi')
const ADMIN_BASE = 'https://admin.example'

// A route resolver's body: a resolver runs in an injection context, so it can inject the
// QueryClient and the reads.
const prefetchAlbum = (id: string) =>
  inject(QueryClient).ensureQueryData(injectJsonApiReads().albums.get(id))

const jsonApiQueryClient = (): QueryClient =>
  new QueryClient({ mutationCache: new JsonApiMutationCache() })

function configure(
  providers: EnvironmentProviders[],
  queryClient: () => QueryClient = jsonApiQueryClient,
): { backend: HttpTestingController; queryClient: QueryClient } {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideJsonApiClient(createMusicClient, { baseUrl: BASE }),
      provideTanStackQuery(queryClient),
      ...providers,
    ],
  })
  return {
    backend: TestBed.inject(HttpTestingController),
    queryClient: TestBed.inject(QueryClient),
  }
}

/** Run Angular's effects and let the query's promise chain reach the transport, then the observer. */
async function flush(): Promise<void> {
  TestBed.tick()
  await settle()
  TestBed.tick()
}

describe('provideJsonApiQuery', () => {
  it('shares one @tanstack/query-core with @tanstack/angular-query', () => {
    // JsonApiMutationCache extends the query bindings' MutationCache; this one is angular-query's.
    expect(new JsonApiMutationCache()).toBeInstanceOf(MutationCache)
  })

  it('reads through injectQuery over HttpClient, typed by the bound factories', async () => {
    const { backend } = configure([provideJsonApiQuery(descriptor)])
    const query = TestBed.runInInjectionContext(() => {
      const reads = injectJsonApiReads()
      return injectQuery(() => reads.albums.get('1'))
    })
    await flush()
    backend.expectOne(`${BASE}/albums/1`).flush(albumDocument('1', 'OK Computer'))
    await flush()

    expect(query.isSuccess()).toBe(true)
    expect(query.data()?.title).toBe('OK Computer')
    backend.verify()
  })

  it('cancels the in-flight request when the key changes', async () => {
    const { backend } = configure([provideJsonApiQuery(descriptor)])
    const id = signal('1')
    const query = TestBed.runInInjectionContext(() => {
      const reads = injectJsonApiReads()
      return injectQuery(() => reads.albums.get(id()))
    })
    await flush()
    const first = backend.expectOne(`${BASE}/albums/1`)

    id.set('2')
    await flush()
    expect(first.cancelled).toBe(true)
    backend.expectOne(`${BASE}/albums/2`).flush(albumDocument('2', 'Kid A'))
    await flush()

    expect(query.data()?.title).toBe('Kid A')
    backend.verify()
  })

  it('patches a cached read from an update, and the data signal re-fires', async () => {
    const { backend } = configure([provideJsonApiQuery(descriptor)])
    const { query, rename } = TestBed.runInInjectionContext(() => {
      const reads = injectJsonApiReads()
      const writes = injectJsonApiWrites()
      return {
        query: injectQuery(() => reads.albums.get('1')),
        rename: injectMutation(() => writes.albums.id('1').update()),
      }
    })
    await flush()
    backend.expectOne(`${BASE}/albums/1`).flush(albumDocument('1', 'OK Computer'))
    await flush()

    // An effect, as a template binding would be: it records each title `data()` publishes.
    const titles: (string | undefined)[] = []
    TestBed.runInInjectionContext(() => effect(() => void titles.push(query.data()?.title)))
    TestBed.tick()

    const saved = rename.mutateAsync({ title: 'OK Computer OKNOTOK' })
    await flush()
    const patch = backend.expectOne(`${BASE}/albums/1`)
    expect(patch.request.method).toBe('PATCH')
    patch.flush(albumDocument('1', 'OK Computer OKNOTOK'))
    await saved
    await flush()

    expect(titles).toEqual(['OK Computer', 'OK Computer OKNOTOK'])
    // Patched in place: no refetch of the read.
    backend.verify()
  })

  it('pages an infinite read with fetchNextPage', async () => {
    const { backend } = configure([provideJsonApiQuery(descriptor)])
    const query = TestBed.runInInjectionContext(() => {
      const reads = injectJsonApiReads()
      return injectInfiniteQuery(() => reads.albums.infinite({ page: { size: 1 } }))
    })
    await flush()
    const next = `${BASE}/albums?page%5Bnumber%5D=2&page%5Bsize%5D=1`
    backend
      .expectOne((req) => req.urlWithParams.startsWith(`${BASE}/albums`))
      .flush(albumsPage([album('1', 'OK Computer')], { next }))
    await flush()
    expect(query.hasNextPage()).toBe(true)

    const fetched = query.fetchNextPage()
    await flush()
    const second = backend.expectOne((req) => req.urlWithParams.startsWith(`${BASE}/albums`))
    expect(decodeURIComponent(second.request.urlWithParams)).toContain('page[number]=2')
    second.flush(albumsPage([album('2', 'Kid A')]))
    await fetched
    await flush()

    expect(query.data()?.pages.map((page) => page.map((a) => a.title))).toEqual([
      ['OK Computer'],
      ['Kid A'],
    ])
    expect(query.hasNextPage()).toBe(false)
    backend.verify()
  })

  it('prefetches in a route resolver, and the component reads the cached result', async () => {
    // A stale time keeps the prefetched read fresh when the component mounts.
    const { backend } = configure(
      [provideJsonApiQuery(descriptor)],
      () =>
        new QueryClient({
          mutationCache: new JsonApiMutationCache(),
          defaultOptions: { queries: { staleTime: 30_000 } },
        }),
    )
    const resolved = TestBed.runInInjectionContext(() => prefetchAlbum('1'))
    await flush()
    backend.expectOne(`${BASE}/albums/1`).flush(albumDocument('1', 'OK Computer'))
    expect((await resolved).title).toBe('OK Computer')

    const query = TestBed.runInInjectionContext(() => {
      const reads = injectJsonApiReads()
      return injectQuery(() => reads.albums.get('1'))
    })
    await flush()
    expect(query.data()?.title).toBe('OK Computer')
    // Fresh in the cache: no second request.
    backend.verify()
  })

  it('keeps two clients in two scopes on one QueryClient apart', async () => {
    const { backend, queryClient } = configure([
      provideJsonApiClient(createAdminClient, { baseUrl: ADMIN_BASE }, ADMIN),
      provideJsonApiQuery(descriptor),
      provideJsonApiQuery(descriptor, { client: ADMIN, scope: 'admin' }),
    ])
    const { main, admin, adminRename } = TestBed.runInInjectionContext(() => {
      const reads = injectJsonApiReads()
      const adminReads = injectJsonApiReads(ADMIN)
      const adminWrites = injectJsonApiWrites(ADMIN)
      return {
        main: injectQuery(() => reads.albums.get('1')),
        admin: injectQuery(() => adminReads.albums.get('1')),
        adminRename: injectMutation(() => adminWrites.albums.id('1').update()),
      }
    })
    await flush()
    backend.expectOne(`${BASE}/albums/1`).flush(albumDocument('1', 'Main'))
    backend.expectOne(`${ADMIN_BASE}/albums/1`).flush(albumDocument('1', 'Admin'))
    await flush()
    expect(main.data()?.title).toBe('Main')
    expect(admin.data()?.title).toBe('Admin')
    expect(queryClient.getQueryCache().getAll()).toHaveLength(2)

    const saved = adminRename.mutateAsync({ title: 'Admin renamed' })
    await flush()
    backend.expectOne(`${ADMIN_BASE}/albums/1`).flush(albumDocument('1', 'Admin renamed'))
    await saved
    await flush()

    expect(admin.data()?.title).toBe('Admin renamed')
    expect(main.data()?.title).toBe('Main')
    backend.verify()
  })

  it('tears the install down with the environment injector', async () => {
    // One QueryClient outlives two test environments: without the teardown, installing a
    // different descriptor on it in the same scope would throw.
    const shared = jsonApiQueryClient()
    configure([provideJsonApiQuery(descriptor)], () => shared)
    TestBed.inject(Injector)

    TestBed.resetTestingModule()
    const other = { ...descriptor }
    const { backend } = configure([provideJsonApiQuery(other)], () => shared)
    const query = TestBed.runInInjectionContext(() => {
      const reads = injectJsonApiReads()
      return injectQuery(() => reads.albums.get('1'))
    })
    await flush()
    backend.expectOne(`${BASE}/albums/1`).flush(albumDocument('1', 'OK Computer'))
    await flush()
    expect(query.data()?.title).toBe('OK Computer')
  })

  it('fails fast without provideTanStackQuery', () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideJsonApiClient(createMusicClient, { baseUrl: BASE }),
        provideJsonApiQuery(descriptor),
      ],
    })
    expect(() => TestBed.inject(Injector)).toThrow(/found no QueryClient.*provideTanStackQuery/)
  })

  it('fails fast when the QueryClient has no JsonApiMutationCache', () => {
    configureExpectingFailure(() => new QueryClient({ mutationCache: new MutationCache() }))
    expect(() => TestBed.inject(Injector)).toThrow(/not\s+built with a JsonApiMutationCache/)
  })

  it('says which provider is missing when a client has no provideJsonApiQuery', () => {
    configure([])
    expect(() => TestBed.runInInjectionContext(() => injectJsonApiReads())).toThrow(
      /injectJsonApiReads\(\) found no provideJsonApiQuery\(\) for the default client/,
    )
    TestBed.resetTestingModule()
    configure([])
    expect(() => TestBed.runInInjectionContext(() => injectJsonApiWrites(ADMIN))).toThrow(
      /injectJsonApiWrites\(\) found no provideJsonApiQuery\(\) for InjectionToken AdminApi/,
    )
  })

  it('asserts an injection context unless given an injector', () => {
    configure([provideJsonApiQuery(descriptor)])
    expect(() => injectJsonApiReads()).toThrow(/injection context/)
    const injector = TestBed.inject(Injector)
    expect(injectJsonApiReads(undefined, { injector }).albums.get('1').queryKey).toEqual(
      TestBed.runInInjectionContext(() => injectJsonApiReads()).albums.get('1').queryKey,
    )
  })
})

function configureExpectingFailure(queryClient: () => QueryClient): void {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideJsonApiClient(createMusicClient, { baseUrl: BASE }),
      provideTanStackQuery(queryClient),
      provideJsonApiQuery(descriptor),
    ],
  })
}
