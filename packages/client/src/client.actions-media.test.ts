import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import { JsonApiError } from './errors'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'

// Actions shaped like core's contract-10 witness (report, cover, import), plus `upload` and
// `annotate`, which list several request media types.
const descriptor = {
  articles: {
    attributes: { title: 'string' },
    relations: {},
    paths: { fetchMany: '/articles', fetchOne: '/articles/{id}', delete: '/articles/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    actions: {
      report: {
        scope: 'collection',
        path: '/articles/-actions/report',
        input: 'none',
        output: 'meta',
        method: 'GET',
        rawOutput: [
          { mediaType: 'text/csv', kind: 'text' },
          { mediaType: 'application/pdf', kind: 'binary' },
          { mediaType: 'application/json', kind: 'json' },
        ],
      },
      cover: {
        scope: 'resource',
        path: '/articles/{id}/-actions/cover',
        input: 'none',
        output: 'none',
        method: 'GET',
        rawOutput: [{ mediaType: 'image/png', kind: 'binary' }],
      },
      publish: {
        scope: 'resource',
        path: '/articles/{id}/-actions/publish',
        input: 'none',
        output: 'meta',
      },
      import: {
        scope: 'collection',
        path: '/articles/-actions/import',
        input: 'raw',
        output: 'none',
        contentType: 'application/octet-stream',
      },
      upload: {
        scope: 'collection',
        path: '/articles/-actions/upload',
        input: 'raw',
        output: 'none',
        contentType: 'text/csv',
        inputMedia: [
          { mediaType: 'text/csv', kind: 'text' },
          { mediaType: 'image/*', kind: 'binary' },
          { mediaType: 'multipart/form-data', kind: 'multipart' },
          { mediaType: 'application/json', kind: 'json' },
        ],
      },
      annotate: {
        scope: 'resource',
        path: '/articles/{id}/-actions/annotate',
        input: 'document',
        output: 'meta',
        inputType: 'articles',
        inputMedia: [
          { mediaType: 'application/vnd.api+json', kind: 'document' },
          { mediaType: 'text/plain', kind: 'text' },
        ],
      },
    },
  },
} as const satisfies ApiDescriptor

interface Summary {
  total: number
}

interface ActionTypes {
  articles: {
    report: { responses: { 'application/json': Summary } }
    upload: { requests: { 'application/json': { rows: string[] } } }
  }
}

type Attributes = { articles: { title: string } }
type WriteAttributes = { articles: { create: { title?: string }; update: { title?: string } } }

function recorder(reply: (req: TransportRequest) => TransportResponse) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    return reply(req)
  }
  return { requests, transport }
}

const ok = (body: string, extra: Partial<TransportResponse> = {}): TransportResponse => ({
  status: 200,
  headers: {},
  body,
  ...extra,
})

const client = (transport: (req: TransportRequest) => Promise<TransportResponse>) =>
  createClient<typeof descriptor, Attributes, WriteAttributes, ActionTypes>(descriptor, {
    baseUrl: BASE,
    transport,
  })

describe('POST content type', () => {
  it('sends the JSON:API Content-Type on a bodyless POST', async () => {
    const { requests, transport } = recorder(() => ok(JSON.stringify({ meta: { ok: true } })))
    await client(transport).articles.id('1').actions.publish()
    expect(requests[0]!.method).toBe('POST')
    expect(requests[0]!.body).toBeUndefined()
    expect(requests[0]!.headers['Content-Type']).toBe('application/vnd.api+json')
  })

  it('sends no Content-Type on a bodyless DELETE', async () => {
    const { requests, transport } = recorder(() => ({ status: 204, headers: {}, body: '' }))
    await client(transport).articles.id('1').delete()
    expect(requests[0]!.headers['Content-Type']).toBeUndefined()
  })

  it('sends no Content-Type on a bodyless GET action', async () => {
    const { requests, transport } = recorder(() => ok('{"meta":{}}'))
    await client(transport).articles.actions.report()
    expect(requests[0]!.headers['Content-Type']).toBeUndefined()
  })
})

describe('raw action responses', () => {
  it('asks for JSON:API by default when the action declares a document or meta response', async () => {
    const { requests, transport } = recorder(() => ok(JSON.stringify({ meta: { total: 2 } })))
    const meta = await client(transport).articles.actions.report()
    expect(requests[0]!.headers['Accept']).toBe('application/vnd.api+json')
    expect(meta).toEqual({ total: 2 })
    expectTypeOf(meta).toEqualTypeOf<Record<string, unknown>>()
  })

  it('returns a text media type as a string', async () => {
    const { requests, transport } = recorder(() => ok('id,title\n1,Hello\n'))
    const csv = await client(transport).articles.actions.report({ accept: 'text/csv' })
    expect(requests[0]!.headers['Accept']).toBe('text/csv')
    expect(requests[0]!.responseType).toBeUndefined()
    expect(csv).toBe('id,title\n1,Hello\n')
    expectTypeOf(csv).toEqualTypeOf<string>()
  })

  it('returns a JSON-like media type parsed, typed from the generated map', async () => {
    const { transport } = recorder(() => ok('{"total":3}'))
    const summary = await client(transport).articles.actions.report({ accept: 'application/json' })
    expect(summary).toEqual({ total: 3 })
    expectTypeOf(summary).toEqualTypeOf<Summary>()
  })

  it('returns a binary media type as a Blob by default and an ArrayBuffer on request', async () => {
    const blob = new Blob(['%PDF'], { type: 'application/pdf' })
    const { requests, transport } = recorder((req) =>
      ok('', {
        binary: req.responseType === 'arraybuffer' ? new TextEncoder().encode('%PDF').buffer : blob,
      }),
    )
    const api = client(transport)

    const pdf = await api.articles.actions.report({ accept: 'application/pdf' })
    expect(requests[0]!.responseType).toBe('blob')
    expect(pdf).toBe(blob)
    expectTypeOf(pdf).toEqualTypeOf<Blob>()

    const buffer = await api.articles.actions.report({
      accept: 'application/pdf',
      responseType: 'arrayBuffer',
    })
    expect(requests[1]!.responseType).toBe('arraybuffer')
    expect(buffer).toBeInstanceOf(ArrayBuffer)
    expectTypeOf(buffer).toEqualTypeOf<ArrayBuffer>()
  })

  it('asks for the first raw media type of an action that answers in no JSON:API document', async () => {
    const png = new Blob(['png'], { type: 'image/png' })
    const { requests, transport } = recorder(() => ok('', { binary: png }))
    const image = await client(transport).articles.id('7').actions.cover()
    expect(requests[0]!.method).toBe('GET')
    expect(requests[0]!.url).toBe(`${BASE}/articles/7/-actions/cover`)
    expect(requests[0]!.headers['Accept']).toBe('image/png')
    expect(image).toBe(png)
    expectTypeOf(image).toEqualTypeOf<Blob>()
  })

  it('still throws a JsonApiError parsed from the JSON:API error document', async () => {
    const { transport } = recorder(() => ({
      status: 406,
      headers: {},
      body: JSON.stringify({ errors: [{ status: '406', code: 'MEDIA_TYPE_UNACCEPTABLE' }] }),
    }))
    const error = await client(transport)
      .articles.actions.report({ accept: 'application/pdf' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JsonApiError)
    expect((error as JsonApiError).status).toBe(406)
  })

  it('refuses a media type the action does not declare', async () => {
    const { transport } = recorder(() => ok(''))
    const api = client(transport)
    await expect(
      // @ts-expect-error -- `text/html` is not a declared response media type.
      api.articles.actions.report({ accept: 'text/html' }),
    ).rejects.toThrow('does not answer in "text/html"')
  })

  it('reports a transport that cannot read binary', async () => {
    const { transport } = recorder(() => ok('not binary'))
    await expect(client(transport).articles.id('1').actions.cover()).rejects.toThrow(
      'no binary body',
    )
  })

  it('does not offer JSON:API on an action that answers only in raw media types', () => {
    type Cover = ReturnType<ReturnType<typeof client>['articles']['id']>['actions']['cover']
    expectTypeOf<NonNullable<Parameters<Cover>[0]>['accept']>().toEqualTypeOf<
      'image/png' | undefined
    >()
  })
})

describe('request media types', () => {
  it('sends a single raw media type as declared, with a binary body as is', async () => {
    const { requests, transport } = recorder(() => ({ status: 204, headers: {}, body: '' }))
    const bytes = new Uint8Array([1, 2, 3])
    await client(transport).articles.actions.import(bytes)
    expect(requests[0]!.headers['Content-Type']).toBe('application/octet-stream')
    expect(requests[0]!.rawBody).toBe(bytes)
    expect(requests[0]!.body).toBeUndefined()
  })

  it('sends the first listed media type when none is picked', async () => {
    const { requests, transport } = recorder(() => ({ status: 204, headers: {}, body: '' }))
    await client(transport).articles.actions.upload('id,title\n')
    expect(requests[0]!.headers['Content-Type']).toBe('text/csv')
    expect(requests[0]!.body).toBe('id,title\n')
  })

  it('sends the picked media type, matched through a declared wildcard', async () => {
    const { requests, transport } = recorder(() => ({ status: 204, headers: {}, body: '' }))
    const image = new Blob(['png'], { type: 'image/png' })
    await client(transport).articles.actions.upload(image, { contentType: 'image/png' })
    expect(requests[0]!.headers['Content-Type']).toBe('image/png')
    expect(requests[0]!.rawBody).toBe(image)
  })

  it('serialises a JSON-like media type', async () => {
    const { requests, transport } = recorder(() => ({ status: 204, headers: {}, body: '' }))
    await client(transport).articles.actions.upload(
      { rows: ['a'] },
      { contentType: 'application/json' },
    )
    expect(requests[0]!.headers['Content-Type']).toBe('application/json')
    expect(requests[0]!.body).toBe('{"rows":["a"]}')
  })

  it('leaves a multipart Content-Type to the transport so it carries the boundary', async () => {
    const { requests, transport } = recorder(() => ({ status: 204, headers: {}, body: '' }))
    const form = new FormData()
    form.append('file', new Blob(['x']), 'x.csv')
    await client(transport).articles.actions.upload(form, { contentType: 'multipart/form-data' })
    expect(requests[0]!.headers['Content-Type']).toBeUndefined()
    expect(requests[0]!.rawBody).toBe(form)
  })

  it('sends JSON:API by default when it is listed, building the document from flat input', async () => {
    const { requests, transport } = recorder(() => ok('{"meta":{}}'))
    const api = client(transport)
    await api.articles.id('1').actions.annotate({ title: 'Hello' })
    expect(requests[0]!.headers['Content-Type']).toBe('application/vnd.api+json')
    expect(JSON.parse(requests[0]!.body!)).toEqual({
      data: { type: 'articles', attributes: { title: 'Hello' } },
    })

    await api.articles.id('1').actions.annotate('a note', { contentType: 'text/plain' })
    expect(requests[1]!.headers['Content-Type']).toBe('text/plain')
    expect(requests[1]!.body).toBe('a note')
  })

  it('types the body by the picked media type', () => {
    type Upload = ReturnType<typeof client>['articles']['actions']['upload']
    const call = null as unknown as Upload
    // oxlint-disable-next-line no-constant-condition -- type-level probes only, never run
    if (false as boolean) {
      void call('csv')
      void call(new Blob([]), { contentType: 'image/webp' })
      void call(new FormData(), { contentType: 'multipart/form-data' })
      void call({ rows: [] }, { contentType: 'application/json' })
      // @ts-expect-error -- a CSV body is a string.
      void call(new Blob([]))
      // @ts-expect-error -- `application/xml` is not a declared request media type.
      void call('x', { contentType: 'application/xml' })
      // @ts-expect-error -- the JSON body follows the generated type.
      void call({ rows: 1 }, { contentType: 'application/json' })
    }
  })

  it('refuses a media type the action does not list', async () => {
    const { transport } = recorder(() => ok(''))
    await expect(
      client(transport).articles.actions.upload('x', {
        contentType: 'application/xml' as 'text/csv',
      }),
    ).rejects.toThrow('does not accept "application/xml"')
  })
})
