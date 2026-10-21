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
})
