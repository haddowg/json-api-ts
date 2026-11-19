import { provideHttpClient } from '@angular/common/http'
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing'
import { TestBed } from '@angular/core/testing'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
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

describe('single keys selected through fields in the Angular bindings', () => {
  it('sends the key members and types the narrowed attribute', async () => {
    const albums = TestBed.runInInjectionContext(() =>
      jsonApiResource({
        loader: ({ client, abortSignal }) =>
          client.albums.list({
            fields: { albums: ['title', 'credits.producer'] },
            signal: abortSignal,
          }),
      }),
    )

    await settle()
    const req = backend.expectOne(
      (r) =>
        decodeURIComponent(r.urlWithParams) ===
        `${BASE}/albums?fields[albums]=title,credits.producer`,
    )
    req.flush(
      JSON.stringify({
        data: [
          {
            type: 'albums',
            id: '1',
            attributes: { title: 'Kid A', credits: { producer: 'Nigel' } },
          },
        ],
      }),
      {
        headers: {
          'Content-Type':
            'application/vnd.api+json; profile="https://haddowg.github.io/json-api/profiles/field-selection/"',
        },
      },
    )
    await settle()
    const first = albums.value()![0]!
    expect(first.credits).toEqual({ producer: 'Nigel' })
    expect(first.$keySelection).toEqual({ credits: ['producer'] })
    expectTypeOf(first.credits).toEqualTypeOf<{ producer?: string } | null>()
    expectTypeOf(first).not.toHaveProperty('steps')
  })
})
