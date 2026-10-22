import { provideHttpClient } from '@angular/common/http'
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing'
import { signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { JsonApiError, type Page, StructuralGuardError } from '@haddowg/json-api-client'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { loadAll, nextPage, type PageParams, prevPage } from './pagination'
import { createJsonApiClientToken, provideJsonApiClient } from './provide'
import { jsonApiResource, type JsonApiResourceError } from './resource'
import {
  album,
  albumDocument,
  albumsPage,
  BASE,
  createAdminClient,
  createMusicClient,
  type MusicClient,
  settle,
} from './test-api'

let backend: HttpTestingController

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideJsonApiClient(createMusicClient, { baseUrl: BASE }),
    ],
  })
  backend = TestBed.inject(HttpTestingController)
})

afterEach(() => {
  backend.verify()
})

/** Run the resource's effect, then let the client reach the transport. */
async function flushEffects(): Promise<void> {
  TestBed.tick()
  await settle()
}

describe('jsonApiResource', () => {
  it('stays idle while params return undefined, then loads once they are ready', async () => {
    const id = signal<string | undefined>(undefined)
    const ref = TestBed.runInInjectionContext(() =>
      jsonApiResource({
        params: () => {
          const value = id()
          return value === undefined ? undefined : { id: value }
        },
        loader: ({ client, params, abortSignal }) => {
          expectTypeOf(client).toEqualTypeOf<MusicClient>()
          expectTypeOf(params).toEqualTypeOf<{ id: string }>()
          return client.albums.get(params.id, { include: ['artist'], signal: abortSignal })
        },
      }),
    )
    type Album = NonNullable<ReturnType<typeof ref.value>>
    expectTypeOf<Album['title']>().toEqualTypeOf<string>()
    // `include: ['artist']` hydrates the relation in the value's type.
    expectTypeOf<NonNullable<Album['artist']>['name']>().toEqualTypeOf<string>()

    await flushEffects()
    expect(ref.status()).toBe('idle')
    backend.expectNone(() => true)

    id.set('1')
    await flushEffects()
    expect(ref.isLoading()).toBe(true)
    backend.expectOne(`${BASE}/albums/1?include=artist`).flush(
      JSON.stringify({
        data: {
          ...album('1', 'OK Computer'),
          relationships: { artist: { data: { type: 'artists', id: '7' } } },
        },
        included: [{ type: 'artists', id: '7', attributes: { name: 'Radiohead' } }],
      }),
    )
    await settle()

    expect(ref.status()).toBe('resolved')
    expect(ref.hasValue()).toBe(true)
    expect(ref.value()?.title).toBe('OK Computer')
    expect(ref.value()?.artist?.name).toBe('Radiohead')
    if (ref.hasValue()) {
      // hasValue() narrows value() past undefined, as a template's @if does.
      expectTypeOf(ref.value().title).toEqualTypeOf<string>()
    }
  })

  it('reloads when a param changes and aborts the superseded request', async () => {
    const title = signal('OK')
    const ref = TestBed.runInInjectionContext(() =>
      jsonApiResource({
        params: () => ({ filter: { title: title() } }),
        loader: ({ client, params, abortSignal }) =>
          client.albums.list({ ...params, signal: abortSignal }),
      }),
    )

    await flushEffects()
    const first = backend.expectOne(`${BASE}/albums?filter[title]=OK`)

    title.set('Kid')
    await flushEffects()
    expect(first.cancelled).toBe(true)
    backend.expectOne(`${BASE}/albums?filter[title]=Kid`).flush(albumsPage([album('3', 'Kid A')]))
    await settle()

    expect(ref.value()?.map((a) => a.title)).toEqual(['Kid A'])
  })

  it('reload() fetches again with the same params', async () => {
    const ref = TestBed.runInInjectionContext(() =>
      jsonApiResource({
        loader: ({ client, abortSignal }) => client.albums.get('1', { signal: abortSignal }),
      }),
    )
    await flushEffects()
    backend.expectOne(`${BASE}/albums/1`).flush(albumDocument('1', 'first'))
    await settle()

    expect(ref.reload()).toBe(true)
    await flushEffects()
    expect(ref.status()).toBe('reloading')
    backend.expectOne(`${BASE}/albums/1`).flush(albumDocument('1', 'second'))
    await settle()

    expect(ref.value()?.title).toBe('second')
  })

  it('surfaces a non-2xx response as a JsonApiError on error() and jsonApiError()', async () => {
    const ref = TestBed.runInInjectionContext(() =>
      jsonApiResource({
        loader: ({ client, abortSignal }) => client.albums.get('9', { signal: abortSignal }),
      }),
    )
    await flushEffects()
    backend
      .expectOne(`${BASE}/albums/9`)
      .flush(JSON.stringify({ errors: [{ status: '404', title: 'Not Found' }] }), {
        status: 404,
        statusText: 'Not Found',
      })
    await settle()

    expect(ref.status()).toBe('error')
    const error = ref.error()
    expect(error).toBeInstanceOf(JsonApiError)
    expect(ref.jsonApiError()?.isNotFound()).toBe(true)
    expect(ref.jsonApiError()?.errors[0]?.title).toBe('Not Found')
    expectTypeOf(ref.error).returns.toEqualTypeOf<JsonApiResourceError | undefined>()
    expectTypeOf(ref.jsonApiError).returns.toEqualTypeOf<JsonApiError | undefined>()
  })

  it('surfaces a malformed response as a StructuralGuardError', async () => {
    const ref = TestBed.runInInjectionContext(() =>
      jsonApiResource({
        loader: ({ client }) => client.albums.get('1'),
      }),
    )
    await flushEffects()
    backend.expectOne(`${BASE}/albums/1`).flush('{"data":{"title":"no type or id"}}')
    await settle()

    expect(ref.error()).toBeInstanceOf(StructuralGuardError)
    expect(ref.jsonApiError()).toBeUndefined()
  })

  it('reads with a client provided under its own token', async () => {
    const ADMIN = createJsonApiClientToken<ReturnType<typeof createAdminClient>>('admin')
    TestBed.resetTestingModule()
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideJsonApiClient(createAdminClient, { baseUrl: `${BASE}/admin` }, ADMIN),
      ],
    })
    backend = TestBed.inject(HttpTestingController)

    const ref = TestBed.runInInjectionContext(() =>
      jsonApiResource({
        client: ADMIN,
        loader: ({ client, abortSignal }) => client.albums.get('1', { signal: abortSignal }),
      }),
    )
    expectTypeOf<NonNullable<ReturnType<typeof ref.value>>['title']>().toEqualTypeOf<string>()
    await flushEffects()
    backend.expectOne(`${BASE}/admin/albums/1`).flush(albumDocument('1', 'admin'))
    await settle()

    expect(ref.value()?.title).toBe('admin')
  })

  it('keeps defaultValue while idle', async () => {
    const ref = TestBed.runInInjectionContext(() =>
      jsonApiResource({
        params: () => undefined,
        defaultValue: [],
        loader: ({ client }) => loadAll(client.albums.list()),
      }),
    )
    await flushEffects()

    expect(ref.value()).toEqual([])
    // With a defaultValue the value is never undefined.
    expectTypeOf<ReturnType<typeof ref.value>[number]['title']>().toEqualTypeOf<string>()
  })

  it('throws outside an injection context unless given an injector', () => {
    expect(() => jsonApiResource({ loader: async () => 1 })).toThrow(/injection context/)
  })
})

describe('pagination helpers', () => {
  it('nextPage() and prevPage() read the page params from the links', async () => {
    const client = TestBed.runInInjectionContext(() =>
      createMusicClient({
        baseUrl: BASE,
        transport: async () => ({
          status: 200,
          headers: {},
          body: albumsPage([album('3', 'Kid A')], {
            next: `${BASE}/albums?page[number]=3&page[size]=1&sort=title`,
            prev: `${BASE}/albums?page[number]=1&page[size]=1&sort=title`,
          }),
        }),
      }),
    )

    const page = await client.albums.list()

    expect(nextPage(page)).toEqual({ number: 3, size: 1 })
    expect(prevPage(page)).toEqual({ number: 1, size: 1 })
    expectTypeOf(nextPage(page)).toEqualTypeOf<{ number?: number; size?: number } | undefined>()
    expect(nextPage(undefined)).toBeUndefined()
  })

  it('nextPage() works the same for cursor links, and is undefined on the last page', async () => {
    const client = createMusicClient({
      baseUrl: BASE,
      transport: async () => ({
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: [{ type: 'artists', id: '1', attributes: { name: 'Radiohead' } }],
          links: { next: `${BASE}/artists?page[after]=abc%3D&page[size]=1` },
        }),
      }),
    })

    const page = await client.artists.list()

    expect(page.$page.kind).toBe('cursor')
    expect(nextPage(page)).toEqual({ after: 'abc=', size: 1 })
    expect(prevPage(page)).toBeUndefined()
  })

  it('a page signal drives the resource from page to page', async () => {
    const page = signal<PageParams>({ size: 1 })
    const ref = TestBed.runInInjectionContext(() =>
      jsonApiResource({
        params: () => ({ page: page() }),
        loader: ({ client, params, abortSignal }) =>
          client.albums.list({ ...params, signal: abortSignal }),
      }),
    )
    await flushEffects()
    backend
      .expectOne(`${BASE}/albums?page[size]=1`)
      .flush(
        albumsPage([album('1', 'one')], { next: `${BASE}/albums?page[number]=2&page[size]=1` }),
      )
    await settle()

    const next = nextPage(ref.value())
    expect(next).toBeDefined()
    page.set(next!)
    await flushEffects()
    backend
      .expectOne(`${BASE}/albums?page[number]=2&page[size]=1`)
      .flush(albumsPage([album('2', 'two')]))
    await settle()

    expect(ref.value()?.map((a) => a.title)).toEqual(['two'])
    expect(nextPage(ref.value())).toBeUndefined()
  })

  it('loadAll() follows next links to the last page inside a loader', async () => {
    const ref = TestBed.runInInjectionContext(() =>
      jsonApiResource({
        loader: ({ client, abortSignal }) =>
          loadAll(client.albums.list({ signal: abortSignal }), {
            signal: abortSignal,
          }),
      }),
    )
    await flushEffects()
    backend
      .expectOne(`${BASE}/albums`)
      .flush(albumsPage([album('1', 'one')], { next: `${BASE}/albums?page[number]=2` }))
    await settle()
    backend
      .expectOne(`${BASE}/albums?page[number]=2`)
      .flush(albumsPage([album('2', 'two')], { next: `${BASE}/albums?page[number]=3` }))
    await settle()
    backend.expectOne(`${BASE}/albums?page[number]=3`).flush(albumsPage([album('3', 'three')]))
    await settle()

    const all = ref.value()
    expect(Array.isArray(all)).toBe(true)
    expect(all?.map((a) => a.title)).toEqual(['one', 'two', 'three'])
    expectTypeOf<
      NonNullable<ReturnType<typeof ref.value>>[number]['title']
    >().toEqualTypeOf<string>()
  })

  it('loadAll() stops at maxPages', async () => {
    let calls = 0
    const client = createMusicClient({
      baseUrl: BASE,
      transport: async () => {
        calls++
        return {
          status: 200,
          headers: {},
          body: albumsPage([album(String(calls), 'x')], {
            next: `${BASE}/albums?page[number]=${calls + 1}`,
          }),
        }
      },
    })

    const all = await loadAll(client.albums.list(), { maxPages: 2 })

    expect(all.map((a) => a.id)).toEqual(['1', '2'])
    expect(calls).toBe(2)
  })

  it('nextPage() reads renamed keys and the picked menu arm from the link', () => {
    const page: Page = {
      kind: 'page',
      keys: { number: 'p', size: 'size' },
      arm: 'numbered',
      links: { next: '/albums?page%5Bkind%5D=numbered&page%5Bp%5D=2&page%5Bsize%5D=10' },
    }
    expect(nextPage({ $page: page })).toEqual({ kind: 'numbered', p: 2, size: 10 })
  })

  it("nextPage() leaves kind out on a menu's default strategy, whose links carry none", () => {
    const page: Page = {
      kind: 'page',
      keys: { number: 'number', size: 'size' },
      links: { next: '/albums?page%5Bnumber%5D=2&page%5Bsize%5D=10' },
    }
    expect(nextPage({ $page: page })).toEqual({ number: 2, size: 10 })
  })

  it('loadAll() and nextPage() follow root-relative links against a base with a path', async () => {
    const urls: string[] = []
    const client = createMusicClient({
      baseUrl: 'https://host.example/api/v5',
      transport: async (req) => {
        urls.push(req.url)
        const last = req.url.includes('page%5Bnumber%5D=2')
        return {
          status: 200,
          headers: {},
          body: albumsPage(
            [album(last ? '2' : '1', 'x')],
            last ? {} : { next: '/api/v5/albums?page%5Bnumber%5D=2&page%5Bsize%5D=1' },
          ),
        }
      },
    })

    expect(nextPage(await client.albums.list())).toEqual({ number: 2, size: 1 })
    urls.length = 0
    const all = await loadAll(client.albums.list())

    expect(all.map((a) => a.id)).toEqual(['1', '2'])
    expect(urls).toEqual([
      'https://host.example/api/v5/albums',
      'https://host.example/api/v5/albums?page%5Bnumber%5D=2&page%5Bsize%5D=1',
    ])
  })

  it('loadAll() aborts mid-walk when the signal fires', async () => {
    const controller = new AbortController()
    const ref = TestBed.runInInjectionContext(() =>
      jsonApiResource({
        params: () => ({}),
        loader: ({ client, abortSignal }) => {
          abortSignal.addEventListener('abort', () => controller.abort())
          return loadAll(client.albums.list({ signal: abortSignal }), {
            signal: abortSignal,
          })
        },
      }),
    )
    await flushEffects()
    backend
      .expectOne(`${BASE}/albums`)
      .flush(albumsPage([album('1', 'one')], { next: `${BASE}/albums?page[number]=2` }))
    await settle()
    const second = backend.expectOne(`${BASE}/albums?page[number]=2`)

    ref.destroy()

    expect(controller.signal.aborted).toBe(true)
    expect(second.cancelled).toBe(true)
  })
})
