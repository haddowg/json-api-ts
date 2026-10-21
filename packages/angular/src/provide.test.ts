import { type HttpInterceptorFn, provideHttpClient, withInterceptors } from '@angular/common/http'
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing'
import { InjectionToken, Injector } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import {
  createJsonApiClientToken,
  injectJsonApiClient,
  type JsonApiClientOf,
  provideJsonApiClient,
} from './provide'
import {
  albumDocument,
  BASE,
  createAdminClient,
  createMusicClient,
  type MusicClient,
} from './test-api'

describe('provideJsonApiClient', () => {
  it('provides one client that sends through HttpClient and its interceptors', async () => {
    const seen: string[] = []
    const interceptor: HttpInterceptorFn = (req, next) => {
      seen.push(req.url)
      return next(req.clone({ setHeaders: { 'X-Tenant': 'acme' } }))
    }
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([interceptor])),
        provideHttpClientTesting(),
        provideJsonApiClient(createMusicClient, { baseUrl: BASE }),
      ],
    })
    const client = TestBed.runInInjectionContext(() => injectJsonApiClient<MusicClient>())
    const backend = TestBed.inject(HttpTestingController)

    const pending = client.albums.get('1')
    await Promise.resolve()
    const req = backend.expectOne(`${BASE}/albums/1`)
    expect(req.request.headers.get('X-Tenant')).toBe('acme')
    expect(req.request.headers.get('Accept')).toBe('application/vnd.api+json')
    req.flush(albumDocument('1', 'OK Computer'))

    const album = await pending
    expect(album.title).toBe('OK Computer')
    expect(seen).toEqual([`${BASE}/albums/1`])
    backend.verify()
  })

  it('keeps the headers() option and lets an explicit transport override HttpClient', async () => {
    const transport = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: albumDocument('1', 'x'),
    }))
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideJsonApiClient(createMusicClient, {
          baseUrl: BASE,
          transport,
          headers: () => ({ 'X-CSRF-Token': 'abc' }),
        }),
      ],
    })
    const client = TestBed.runInInjectionContext(() => injectJsonApiClient<MusicClient>())

    await client.albums.get('1')

    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.objectContaining({ 'X-CSRF-Token': 'abc' }) }),
    )
    TestBed.inject(HttpTestingController).verify()
  })

  it('resolves options from a factory run in an injection context', () => {
    const API_URL = new InjectionToken<string>('API_URL')
    const create = vi.fn(createMusicClient)
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        { provide: API_URL, useValue: 'https://api.example/v5' },
        provideJsonApiClient(create, () => ({ baseUrl: TestBed.inject(API_URL) })),
      ],
    })

    TestBed.runInInjectionContext(() => injectJsonApiClient())

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://api.example/v5' }),
    )
  })

  it('provides two clients side by side under their own tokens', async () => {
    const ADMIN = createJsonApiClientToken<JsonApiClientOf<typeof createAdminClient>>('admin')
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideJsonApiClient(createMusicClient, { baseUrl: BASE }),
        provideJsonApiClient(createAdminClient, { baseUrl: `${BASE}/admin` }, ADMIN),
      ],
    })
    const [main, admin] = TestBed.runInInjectionContext(() => [
      injectJsonApiClient<MusicClient>(),
      injectJsonApiClient(ADMIN),
    ])
    const backend = TestBed.inject(HttpTestingController)

    expect(main).not.toBe(admin)
    const a = main.albums.get('1')
    const b = admin.albums.get('2')
    await Promise.resolve()
    backend.expectOne(`${BASE}/albums/1`).flush(albumDocument('1', 'main'))
    backend.expectOne(`${BASE}/admin/albums/2`).flush(albumDocument('2', 'admin'))

    expect((await a).title).toBe('main')
    expect((await b).title).toBe('admin')
    backend.verify()
  })

  it('injects with an explicit injector outside an injection context', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideJsonApiClient(createMusicClient, { baseUrl: BASE })],
    })

    const client = injectJsonApiClient<MusicClient>(undefined, {
      injector: TestBed.inject(Injector),
    })

    expect(client.albums).toBeDefined()
    expect(() => injectJsonApiClient()).toThrow(/injection context/)
  })
})
