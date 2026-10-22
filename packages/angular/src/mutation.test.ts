import { provideHttpClient } from '@angular/common/http'
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing'
import { TestBed } from '@angular/core/testing'
import { JsonApiError } from '@haddowg/json-api-client'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { jsonApiMutation } from './mutation'
import { createJsonApiClientToken, provideJsonApiClient } from './provide'
import {
  type AdminErrorCode,
  albumDocument,
  BASE,
  createAdminClient,
  createMusicClient,
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

const renameAlbum = () =>
  TestBed.runInInjectionContext(() =>
    jsonApiMutation((client, input: { id: string; title: string }) =>
      client.albums.id(input.id).update({ title: input.title }),
    ),
  )

describe('jsonApiMutation', () => {
  it('starts idle', () => {
    const rename = renameAlbum()

    expect(rename.isPending()).toBe(false)
    expect(rename.value()).toBeUndefined()
    expect(rename.error()).toBeUndefined()
  })

  it('is pending while the write is in flight, then holds the result', async () => {
    const rename = renameAlbum()

    const done = rename.mutate({ id: '1', title: 'Kid A' })
    expect(rename.isPending()).toBe(true)
    await settle()
    const req = backend.expectOne(`${BASE}/albums/1`)
    expect(req.request.method).toBe('PATCH')
    expect(JSON.parse(req.request.body as string)).toEqual({
      data: { type: 'albums', id: '1', attributes: { title: 'Kid A' } },
    })
    req.flush(albumDocument('1', 'Kid A'))

    const result = await done
    expect(result.title).toBe('Kid A')
    expect(rename.isPending()).toBe(false)
    expect(rename.value()?.title).toBe('Kid A')
    expect(rename.error()).toBeUndefined()
    expectTypeOf(rename.mutate).parameter(0).toEqualTypeOf<{ id: string; title: string }>()
    expectTypeOf<NonNullable<ReturnType<typeof rename.value>>['title']>().toEqualTypeOf<string>()
  })

  it('rejects and exposes a JsonApiError with flat paths on failure', async () => {
    const rename = renameAlbum()

    const done = rename.mutate({ id: '1', title: '' })
    await settle()
    backend.expectOne(`${BASE}/albums/1`).flush(
      JSON.stringify({
        errors: [
          {
            status: '422',
            detail: 'This value should not be blank.',
            source: { pointer: '/data/attributes/title' },
          },
        ],
      }),
      { status: 422, statusText: 'Unprocessable Content' },
    )

    await expect(done).rejects.toBeInstanceOf(JsonApiError)
    expect(rename.isPending()).toBe(false)
    expect(rename.value()).toBeUndefined()
    expect(rename.error()).toBeInstanceOf(JsonApiError)
    expect(rename.jsonApiError()?.isUnprocessable()).toBe(true)
    expect(Object.keys(rename.jsonApiError()?.byPath() ?? {})).toEqual(['title'])
  })

  it('clears the previous error when a new call starts', async () => {
    const rename = renameAlbum()
    const failed = rename.mutate({ id: '1', title: '' })
    await settle()
    backend.expectOne(`${BASE}/albums/1`).flush('', { status: 500, statusText: 'Server Error' })
    await failed.catch(() => undefined)
    expect(rename.error()).toBeDefined()

    const retried = rename.mutate({ id: '1', title: 'ok' })
    expect(rename.error()).toBeUndefined()
    await settle()
    backend.expectOne(`${BASE}/albums/1`).flush(albumDocument('1', 'ok'))
    await retried

    expect(rename.value()?.title).toBe('ok')
  })

  it('reset() clears state and ignores a call still in flight', async () => {
    const rename = renameAlbum()

    const done = rename.mutate({ id: '1', title: 'late' })
    rename.reset()
    expect(rename.isPending()).toBe(false)
    await settle()
    backend.expectOne(`${BASE}/albums/1`).flush(albumDocument('1', 'late'))
    await done

    expect(rename.value()).toBeUndefined()
    expect(rename.isPending()).toBe(false)
  })

  it('keeps the latest call when calls overlap', async () => {
    const rename = renameAlbum()

    const first = rename.mutate({ id: '1', title: 'first' })
    const second = rename.mutate({ id: '2', title: 'second' })
    await settle()
    const [one, two] = backend.match(() => true)
    two!.flush(albumDocument('2', 'second'))
    await second
    expect(rename.isPending()).toBe(true)
    one!.flush(albumDocument('1', 'first'))
    await first

    expect(rename.isPending()).toBe(false)
    expect(rename.value()?.title).toBe('second')
  })

  it('writes with a client provided under its own token', async () => {
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
    const remove = TestBed.runInInjectionContext(() =>
      jsonApiMutation((client, id: string) => client.albums.id(id).delete(), { client: ADMIN }),
    )
    expectTypeOf(remove.jsonApiError).returns.toEqualTypeOf<
      JsonApiError<AdminErrorCode> | undefined
    >()

    const done = remove.mutate('1')
    await settle()
    const req = backend.expectOne(`${BASE}/admin/albums/1`)
    expect(req.request.method).toBe('DELETE')
    req.flush(null, { status: 204, statusText: 'No Content' })

    await expect(done).resolves.toBeUndefined()
    expect(remove.isPending()).toBe(false)
  })
})
