import { provideHttpClient } from '@angular/common/http'
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing'
import { TestBed } from '@angular/core/testing'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { jsonApiMutation } from './mutation'
import { provideJsonApiClient } from './provide'
import { jsonApiResource } from './resource'
import { BASE, createMusicClient, settle } from './test-api'

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

describe('typed document meta in the Angular bindings', () => {
  it('passes a read’s declared meta through the resource', async () => {
    const inbox = TestBed.runInInjectionContext(() =>
      jsonApiResource({
        loader: ({ client, abortSignal }) => client.inboxes.get({ signal: abortSignal }),
      }),
    )
    await settle()
    backend.expectOne(`${BASE}/inbox`).flush(
      JSON.stringify({
        data: { type: 'inboxes', id: '42', attributes: { unread: 5, seenUpTo: null } },
        meta: { etag: 'W/"3"' },
      }),
    )
    await settle()
    expect(inbox.value()?.$document.meta.etag).toBe('W/"3"')
    expectTypeOf<
      NonNullable<ReturnType<typeof inbox.value>>['$document']['meta']['etag']
    >().toEqualTypeOf<string>()
  })

  it('resolves a delete to the meta it declares', async () => {
    const remove = TestBed.runInInjectionContext(() =>
      jsonApiMutation((client, id: string) => client.albums.id(id).delete()),
    )
    const done = remove.mutate('1')
    await settle()
    backend.expectOne(`${BASE}/albums/1`).flush(JSON.stringify({ meta: { archived: 1 } }))
    expect(await done).toEqual({ archived: 1 })
    expect(remove.value()?.archived).toBe(1)
    expectTypeOf<NonNullable<ReturnType<typeof remove.value>>['archived']>().toEqualTypeOf<number>()
  })
})
