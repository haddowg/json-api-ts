import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTransport } from './transport'

describe('fetchTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('passes the request signal to fetch', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()

    await fetchTransport({
      method: 'GET',
      url: 'https://music.example/albums',
      headers: {},
      signal: controller.signal,
    })

    expect(fetch).toHaveBeenCalledWith('https://music.example/albums', {
      method: 'GET',
      headers: {},
      signal: controller.signal,
    })
  })

  it('omits the signal from the fetch init when none is given', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetch)

    await fetchTransport({ method: 'GET', url: 'https://music.example/albums', headers: {} })

    expect(fetch).toHaveBeenCalledWith('https://music.example/albums', {
      method: 'GET',
      headers: {},
    })
  })

  it('sends a raw body as is', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    const bytes = new Uint8Array([1, 2])

    await fetchTransport({
      method: 'POST',
      url: 'https://music.example/albums/-actions/import',
      headers: {},
      rawBody: bytes,
    })

    expect(fetch).toHaveBeenCalledWith('https://music.example/albums/-actions/import', {
      method: 'POST',
      headers: {},
      body: bytes,
    })
  })

  it('reads a successful response as binary when asked', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([7, 8]), { status: 200 }))
    const req = { method: 'GET', url: 'https://music.example/cover', headers: {} }

    const blob = await fetchTransport({ ...req, responseType: 'blob' })
    expect(blob.body).toBe('')
    expect(blob.binary).toBeInstanceOf(Blob)

    const buffer = await fetchTransport({ ...req, responseType: 'arraybuffer' })
    expect(new Uint8Array(buffer.binary as ArrayBuffer)).toEqual(new Uint8Array([7, 8]))
  })

  it('reads an error response as text even when binary was asked for', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"errors":[]}', { status: 406 }))

    const res = await fetchTransport({
      method: 'GET',
      url: 'https://music.example/cover',
      headers: {},
      responseType: 'blob',
    })

    expect(res.binary).toBeUndefined()
    expect(res.body).toBe('{"errors":[]}')
  })
})
