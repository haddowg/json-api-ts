import { HttpClient, HttpErrorResponse, provideHttpClient } from '@angular/common/http'
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing'
import { TestBed } from '@angular/core/testing'
import type { JsonApiTransport } from '@haddowg/json-api-client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { httpClientTransport } from './transport'

const URL = 'https://music.example/albums'

describe('httpClientTransport', () => {
  let transport: JsonApiTransport
  let backend: HttpTestingController

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    })
    transport = httpClientTransport(TestBed.inject(HttpClient))
    backend = TestBed.inject(HttpTestingController)
  })

  afterEach(() => {
    backend.verify()
  })

  it('sends method, url, headers and body through HttpClient', async () => {
    const pending = transport({
      method: 'POST',
      url: URL,
      headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json' },
      body: '{"data":{"type":"albums"}}',
    })

    const req = backend.expectOne(URL)
    expect(req.request.method).toBe('POST')
    expect(req.request.headers.get('Accept')).toBe('application/vnd.api+json')
    expect(req.request.headers.get('Content-Type')).toBe('application/vnd.api+json')
    expect(req.request.body).toBe('{"data":{"type":"albums"}}')
    expect(req.request.responseType).toBe('text')
    req.flush('{"data":{"type":"albums","id":"1"}}', {
      status: 201,
      statusText: 'Created',
      headers: { Location: `${URL}/1`, 'Content-Type': 'application/vnd.api+json' },
    })

    await expect(pending).resolves.toEqual({
      status: 201,
      headers: { location: `${URL}/1`, 'content-type': 'application/vnd.api+json' },
      body: '{"data":{"type":"albums","id":"1"}}',
    })
  })

  it('resolves an empty body for a 204', async () => {
    const pending = transport({ method: 'DELETE', url: `${URL}/1`, headers: {} })

    backend.expectOne(`${URL}/1`).flush(null, { status: 204, statusText: 'No Content' })

    await expect(pending).resolves.toEqual({ status: 204, headers: {}, body: '' })
  })

  it('resolves a 4xx with its status, headers and body instead of rejecting', async () => {
    const body = '{"errors":[{"status":"404","title":"Not Found"}]}'
    const pending = transport({ method: 'GET', url: `${URL}/9`, headers: {} })

    backend.expectOne(`${URL}/9`).flush(body, {
      status: 404,
      statusText: 'Not Found',
      headers: { 'Content-Type': 'application/vnd.api+json' },
    })

    await expect(pending).resolves.toEqual({
      status: 404,
      headers: { 'content-type': 'application/vnd.api+json' },
      body,
    })
  })

  it('resolves a 5xx, including one with no body', async () => {
    const pending = transport({ method: 'GET', url: URL, headers: {} })

    backend.expectOne(URL).flush(null, { status: 503, statusText: 'Service Unavailable' })

    await expect(pending).resolves.toEqual({ status: 503, headers: {}, body: '' })
  })

  it('rejects a network failure (status 0) with the HttpErrorResponse', async () => {
    const pending = transport({ method: 'GET', url: URL, headers: {} })

    backend.expectOne(URL).error(new ProgressEvent('error'))

    const error = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpErrorResponse)
    expect((error as HttpErrorResponse).status).toBe(0)
  })

  it('joins a repeated response header into one value', async () => {
    const pending = transport({ method: 'GET', url: URL, headers: {} })

    backend.expectOne(URL).flush('', { headers: { Vary: ['Accept', 'Origin'] } })

    await expect(pending).resolves.toMatchObject({ headers: { vary: 'Accept, Origin' } })
  })

  it('cancels the request and rejects with the reason when the signal aborts', async () => {
    const controller = new AbortController()
    const pending = transport({ method: 'GET', url: URL, headers: {}, signal: controller.signal })
    const req = backend.expectOne(URL)

    controller.abort()

    expect(req.cancelled).toBe(true)
    const error = await pending.catch((e: unknown) => e)
    expect((error as DOMException).name).toBe('AbortError')
  })

  it('rejects without sending when the signal has already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const error = await transport({
      method: 'GET',
      url: URL,
      headers: {},
      signal: controller.signal,
    }).catch((e: unknown) => e)

    expect((error as DOMException).name).toBe('AbortError')
    backend.expectNone(URL)
  })
})
