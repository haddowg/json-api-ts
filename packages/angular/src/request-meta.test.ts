import { provideHttpClient } from '@angular/common/http'
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing'
import { TestBed } from '@angular/core/testing'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { jsonApiMutation } from './mutation'
import { provideJsonApiClient } from './provide'
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

describe('typed request and resource meta in the Angular bindings', () => {
  it('sends a create’s meta and its $meta, and types the resource’s meta', async () => {
    const create = TestBed.runInInjectionContext(() =>
      jsonApiMutation((client, title: string) =>
        client.albums.create(
          { title, $meta: { source: 'web' } },
          { meta: { idempotencyKey: `k-${title}` } },
        ),
      ),
    )
    const done = create.mutate('Blue')
    await settle()
    const request = backend.expectOne(`${BASE}/albums`)
    expect(JSON.parse(request.request.body as string)).toEqual({
      data: { type: 'albums', attributes: { title: 'Blue' }, meta: { source: 'web' } },
      meta: { idempotencyKey: 'k-Blue' },
    })
    request.flush(
      JSON.stringify({
        data: { type: 'albums', id: '1', attributes: { title: 'Blue' }, meta: { playCount: 9 } },
      }),
    )
    expect((await done).$meta?.playCount).toBe(9)
    expectTypeOf<
      NonNullable<NonNullable<ReturnType<typeof create.value>>['$meta']>['playCount']
    >().toEqualTypeOf<number | undefined>()
  })
})
