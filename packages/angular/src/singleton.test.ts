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

const inboxDocument = (unread: number, seenUpTo: string | null = null): string =>
  JSON.stringify({ data: { type: 'inboxes', id: '42', attributes: { unread, seenUpTo } } })

describe('a singleton in the Angular bindings', () => {
  it('reads it with no id and updates it with the id it read', async () => {
    const inbox = TestBed.runInInjectionContext(() =>
      jsonApiResource({
        loader: ({ client, abortSignal }) => client.inboxes.get({ signal: abortSignal }),
      }),
    )
    const markSeen = TestBed.runInInjectionContext(() =>
      jsonApiMutation((client, input: { id: string; seenUpTo: string }) =>
        client.inboxes.update(input),
      ),
    )

    await settle()
    backend.expectOne(`${BASE}/inbox`).flush(inboxDocument(5))
    await settle()
    expect(inbox.value()?.id).toBe('42')
    expect(inbox.value()?.unread).toBe(5)

    const done = markSeen.mutate({ id: inbox.value()!.id, seenUpTo: '2026-11-16T09:30:00+00:00' })
    await settle()
    const req = backend.expectOne(`${BASE}/inbox`)
    expect(req.request.method).toBe('PATCH')
    expect(JSON.parse(req.request.body as string)).toEqual({
      data: { type: 'inboxes', id: '42', attributes: { seenUpTo: '2026-11-16T09:30:00+00:00' } },
    })
    req.flush(inboxDocument(0, '2026-11-16T09:30:00+00:00'))
    expect((await done).unread).toBe(0)
    expectTypeOf<NonNullable<ReturnType<typeof inbox.value>>['unread']>().toEqualTypeOf<number>()
  })
})
