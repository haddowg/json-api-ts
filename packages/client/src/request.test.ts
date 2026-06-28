import { describe, expect, it, vi } from 'vitest'
import { JsonApiError } from './errors'
import { execute, type JsonApiContext, serializeQuery } from './request'
import type { JsonApiTransport, TransportRequest, TransportResponse } from './transport'
import { ATOMIC_EXT, JSON_API_MEDIA_TYPE, mediaType } from './types'

const ok = (body: unknown, status = 200): TransportResponse => ({
  status,
  headers: {},
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

/** A transport that captures the (single) request it was handed and cans a response. */
const recording = (
  response: TransportResponse,
): { transport: JsonApiTransport; sent: () => TransportRequest } => {
  let captured: TransportRequest | undefined
  return {
    sent: () => {
      if (!captured) {
        throw new Error('transport was not called')
      }
      return captured
    },
    transport: async (req) => {
      captured = req
      return response
    },
  }
}

const ctx = (
  overrides: Partial<JsonApiContext> & { transport: JsonApiTransport },
): JsonApiContext => ({
  baseUrl: 'https://api.example',
  ...overrides,
})

describe('serializeQuery', () => {
  it('serialises filter, joining array values with commas', () => {
    expect(
      serializeQuery({ filter: { title: 'OK Computer', status: ['released', 'draft'] } }),
    ).toBe('filter[title]=OK%20Computer&filter[status]=released%2Cdraft')
  })

  it('serialises sort as a string or comma-joined array', () => {
    expect(serializeQuery({ sort: 'title' })).toBe('sort=title')
    expect(serializeQuery({ sort: ['-releasedAt', 'title'] })).toBe('sort=-releasedAt%2Ctitle')
  })

  it('serialises include comma-joined', () => {
    expect(serializeQuery({ include: ['artist', 'tracks'] })).toBe('include=artist%2Ctracks')
  })

  it('serialises sparse fieldsets per type', () => {
    expect(serializeQuery({ fields: { albums: ['title', 'releasedAt'], artists: ['name'] } })).toBe(
      'fields[albums]=title%2CreleasedAt&fields[artists]=name',
    )
  })

  it('emits an explicitly-empty fieldset (id-only) as `fields[type]=`', () => {
    // `fields[type]=` selects NO members (id-only) — the narrowed return type. Unlike an empty
    // filter/page value, it must NOT be skipped, or the server returns the full resource.
    expect(serializeQuery({ fields: { albums: [] } })).toBe('fields[albums]=')
    expect(serializeQuery({ fields: { albums: [], artists: ['name'] } })).toBe(
      'fields[albums]=&fields[artists]=name',
    )
  })

  it('serialises page params with literal bracketed keys', () => {
    expect(serializeQuery({ page: { number: 2, size: 10 } })).toBe('page[number]=2&page[size]=10')
  })

  it('serialises withCount comma-joined (skipping an empty list)', () => {
    expect(serializeQuery({ withCount: ['_self_', 'tracks'] })).toBe('withCount=_self_%2Ctracks')
    expect(serializeQuery({ withCount: [] })).toBe('')
  })

  it('serialises cursor page params (cursor/size) literally', () => {
    expect(serializeQuery({ page: { cursor: 'abc123', size: 20 } })).toBe(
      'page[cursor]=abc123&page[size]=20',
    )
  })

  it('keeps bracketed keys literal and only encodes values', () => {
    expect(serializeQuery({ filter: { 'releaseInfo.label': 'A&B' } })).toBe(
      'filter[releaseInfo.label]=A%26B',
    )
  })

  it('skips empty, undefined and null values', () => {
    expect(serializeQuery({ filter: { a: '', b: undefined, c: null, d: 'keep' } })).toBe(
      'filter[d]=keep',
    )
    expect(serializeQuery({})).toBe('')
  })

  it('serialises a combined query deterministically (family order)', () => {
    expect(
      serializeQuery({
        page: { number: 1 },
        filter: { title: 'x' },
        sort: 'title',
        include: ['artist'],
        fields: { albums: ['title'] },
      }),
    ).toBe('filter[title]=x&sort=title&include=artist&fields[albums]=title&page[number]=1')
  })
})

describe('mediaType', () => {
  it('returns the bare JSON:API media type with no params', () => {
    expect(mediaType()).toBe(JSON_API_MEDIA_TYPE)
    expect(mediaType({})).toBe(JSON_API_MEDIA_TYPE)
    // Empty lists are omitted (no dangling `; ext=""`).
    expect(mediaType({ ext: [], profiles: [] })).toBe(JSON_API_MEDIA_TYPE)
  })

  it('composes a single ext parameter', () => {
    expect(mediaType({ ext: [ATOMIC_EXT] })).toBe(`application/vnd.api+json; ext="${ATOMIC_EXT}"`)
  })

  it('composes a single profile parameter', () => {
    expect(mediaType({ profiles: ['https://example/countable/'] })).toBe(
      'application/vnd.api+json; profile="https://example/countable/"',
    )
  })

  it('composes ext and profile together, ext first', () => {
    expect(mediaType({ ext: [ATOMIC_EXT], profiles: ['https://example/countable/'] })).toBe(
      `application/vnd.api+json; ext="${ATOMIC_EXT}"; profile="https://example/countable/"`,
    )
  })

  it('space-joins multiple ext and multiple profile URIs', () => {
    expect(
      mediaType({
        ext: ['https://example/ext/a', 'https://example/ext/b'],
        profiles: ['https://example/p1', 'https://example/p2'],
      }),
    ).toBe(
      'application/vnd.api+json; ext="https://example/ext/a https://example/ext/b"; profile="https://example/p1 https://example/p2"',
    )
  })
})

describe('execute', () => {
  it('returns the parsed document on 2xx', async () => {
    const { transport, sent } = recording(ok({ data: { type: 'albums', id: '1' } }))
    const doc = await execute(ctx({ transport }), { method: 'GET', path: '/albums/1' })

    expect(doc).toEqual({ data: { type: 'albums', id: '1' } })
    expect(sent().url).toBe('https://api.example/albums/1')
  })

  it('appends a serialised query to the URL', async () => {
    const { transport, sent } = recording(ok({ data: [] }))
    await execute(ctx({ transport }), {
      method: 'GET',
      path: '/albums',
      query: { include: ['artist'], page: { number: 2 } },
    })

    expect(sent().url).toBe('https://api.example/albums?include=artist&page[number]=2')
  })

  it('returns undefined for an empty / 204 body', async () => {
    const { transport } = recording({ status: 204, headers: {}, body: '' })
    const doc = await execute(ctx({ transport }), { method: 'DELETE', path: '/albums/1' })
    expect(doc).toBeUndefined()
  })

  it('throws a JsonApiError carrying the parsed errors on non-2xx', async () => {
    const errors = [{ status: '422', source: { pointer: '/data/attributes/title' } }]
    const { transport } = recording(ok({ errors }, 422))

    await expect(
      execute(ctx({ transport }), { method: 'POST', path: '/albums', body: { data: {} } }),
    ).rejects.toMatchObject({ status: 422, errors })

    await expect(
      execute(ctx({ transport }), { method: 'POST', path: '/albums', body: { data: {} } }),
    ).rejects.toBeInstanceOf(JsonApiError)
  })

  it('throws with an empty error list for a non-JSON error body', async () => {
    const { transport } = recording({ status: 500, headers: {}, body: '<html>oops</html>' })
    await expect(
      execute(ctx({ transport }), { method: 'GET', path: '/albums' }),
    ).rejects.toMatchObject({ status: 500, errors: [] })
  })

  it('applies content-negotiation headers and JSON-stringifies a body', async () => {
    const { transport, sent } = recording(ok({ data: { type: 'albums', id: '1' } }, 201))
    await execute(ctx({ transport }), {
      method: 'POST',
      path: '/albums',
      body: { data: { type: 'albums', attributes: { title: 'x' } } },
    })

    expect(sent().headers['Accept']).toBe(JSON_API_MEDIA_TYPE)
    expect(sent().headers['Content-Type']).toBe(JSON_API_MEDIA_TYPE)
    expect(sent().body).toBe('{"data":{"type":"albums","attributes":{"title":"x"}}}')
  })

  it('sets no Content-Type when there is no body', async () => {
    const { transport, sent } = recording(ok({ data: [] }))
    await execute(ctx({ transport }), { method: 'GET', path: '/albums' })

    expect(sent().body).toBeUndefined()
    expect(sent().headers['Content-Type']).toBeUndefined()
  })

  it('negotiates a profile into Accept on a bodyless read', async () => {
    const { transport, sent } = recording(ok({ data: [] }))
    await execute(ctx({ transport }), {
      method: 'GET',
      path: '/albums',
      profiles: ['https://example/countable/'],
    })

    expect(sent().headers['Accept']).toBe(
      'application/vnd.api+json; profile="https://example/countable/"',
    )
    // No body -> no Content-Type.
    expect(sent().headers['Content-Type']).toBeUndefined()
  })

  it('negotiates ext + profile into BOTH Accept and Content-Type when a body is present', async () => {
    const { transport, sent } = recording(ok({ data: { type: 'albums', id: '1' } }, 200))
    await execute(ctx({ transport }), {
      method: 'POST',
      path: '/operations',
      body: { 'atomic:operations': [] },
      ext: [ATOMIC_EXT],
      profiles: ['https://example/countable/'],
    })

    const expected = `application/vnd.api+json; ext="${ATOMIC_EXT}"; profile="https://example/countable/"`
    expect(sent().headers['Accept']).toBe(expected)
    expect(sent().headers['Content-Type']).toBe(expected)
  })

  it('lets an explicit accept/contentType override win over the negotiated value', async () => {
    const { transport, sent } = recording(ok({ data: { type: 'albums', id: '1' } }, 200))
    await execute(ctx({ transport }), {
      method: 'POST',
      path: '/albums',
      body: 'raw-bytes',
      raw: true,
      // ext/profiles are present but the explicit overrides win for their respective headers.
      ext: [ATOMIC_EXT],
      contentType: 'application/octet-stream',
      accept: JSON_API_MEDIA_TYPE,
    })

    expect(sent().headers['Content-Type']).toBe('application/octet-stream')
    expect(sent().headers['Accept']).toBe(JSON_API_MEDIA_TYPE)
  })

  it('merges async per-request headers (e.g. bearer auth), preserving casing', async () => {
    const { transport, sent } = recording(ok({ data: [] }))
    const headers = vi.fn(async () => ({ Authorization: 'Bearer t0ken' }))
    await execute(ctx({ transport, headers }), { method: 'GET', path: '/albums' })

    expect(headers).toHaveBeenCalledOnce()
    expect(sent().headers['Authorization']).toBe('Bearer t0ken')
    expect(sent().headers['Accept']).toBe(JSON_API_MEDIA_TYPE)
  })

  it('accepts the tuple-array and Headers forms of HeadersInit', async () => {
    const tuples = recording(ok({ data: [] }))
    await execute(ctx({ transport: tuples.transport, headers: () => [['X-Tenant', 'acme']] }), {
      method: 'GET',
      path: '/albums',
    })
    expect(tuples.sent().headers['X-Tenant']).toBe('acme')

    const native = recording(ok({ data: [] }))
    await execute(
      ctx({ transport: native.transport, headers: () => new Headers({ 'X-Trace': '7' }) }),
      {
        method: 'GET',
        path: '/albums',
      },
    )
    expect(native.sent().headers['x-trace']).toBe('7')
  })

  it('uses an absolute-URL path verbatim, bypassing baseUrl', async () => {
    const { transport, sent } = recording(ok({ data: [] }))
    await execute(ctx({ transport }), {
      method: 'GET',
      path: 'https://other.example/albums?page%5Bnumber%5D=2',
    })

    expect(sent().url).toBe('https://other.example/albums?page%5Bnumber%5D=2')
  })

  it('appends a query onto an absolute URL that already has a query string', async () => {
    const { transport, sent } = recording(ok({ data: [] }))
    await execute(ctx({ transport }), {
      method: 'GET',
      path: 'https://other.example/albums?page[number]=2',
      query: { sort: 'title' },
    })

    expect(sent().url).toBe('https://other.example/albums?page[number]=2&sort=title')
  })
})
