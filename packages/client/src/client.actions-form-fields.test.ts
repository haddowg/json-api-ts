import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'

// `register` lists a multipart and a URL-encoded body beside CSV; `attach` takes only a multipart
// body; `raw` takes a multipart body whose schema lists no properties.
const descriptor = {
  articles: {
    attributes: { title: 'string' },
    relations: {},
    paths: { fetchMany: '/articles', fetchOne: '/articles/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    actions: {
      register: {
        scope: 'collection',
        path: '/articles/-actions/register',
        input: 'raw',
        output: 'none',
        contentType: 'text/csv',
        inputMedia: [
          { mediaType: 'text/csv', kind: 'text' },
          { mediaType: 'multipart/form-data', kind: 'multipart' },
          { mediaType: 'application/x-www-form-urlencoded', kind: 'form' },
        ],
      },
      attach: {
        scope: 'resource',
        path: '/articles/{id}/-actions/attach',
        input: 'raw',
        output: 'none',
        contentType: 'multipart/form-data',
      },
      raw: {
        scope: 'collection',
        path: '/articles/-actions/raw',
        input: 'raw',
        output: 'none',
        contentType: 'multipart/form-data',
      },
    },
  },
} as const satisfies ApiDescriptor

interface ActionTypes {
  articles: {
    register: {
      requests: {
        'multipart/form-data': { title: string; cover?: Blob | File; tags?: string[] }
        'application/x-www-form-urlencoded': { title: string; draft?: boolean; count?: number }
      }
    }
    attach: { requests: { 'multipart/form-data': { file: Blob | File; note?: string } } }
  }
}

type Attributes = { articles: { title: string } }
type WriteAttributes = { articles: { create: { title?: string }; update: { title?: string } } }

function recorder() {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    return { status: 204, headers: {}, body: '' }
  }
  const api = createClient<typeof descriptor, Attributes, WriteAttributes, ActionTypes>(
    descriptor,
    { baseUrl: BASE, transport },
  )
  return { requests, api }
}

describe('typed form fields', () => {
  it('builds a multipart body from fields, files named and arrays bracketed', async () => {
    const { requests, api } = recorder()
    const cover = new File(['png'], 'cover.png', { type: 'image/png' })
    await api.articles.actions.register(
      { title: 'Hello', cover, tags: ['a', 'b'] },
      { contentType: 'multipart/form-data' },
    )
    const body = requests[0]!.rawBody
    expect(body).toBeInstanceOf(FormData)
    const form = body as FormData
    expect(form.get('title')).toBe('Hello')
    expect((form.get('cover') as File).name).toBe('cover.png')
    expect(form.getAll('tags[]')).toEqual(['a', 'b'])
    expect(form.has('tags')).toBe(false)
    // The transport writes the boundary, so the client sets no Content-Type.
    expect(requests[0]!.headers['Content-Type']).toBeUndefined()
  })

  it('names a bare Blob after its field and skips null and undefined fields', async () => {
    const { requests, api } = recorder()
    const fields = { file: new Blob(['x']), note: undefined } as unknown as { file: Blob }
    await api.articles.id('1').actions.attach(fields)
    const form = requests[0]!.rawBody as FormData
    expect((form.get('file') as File).name).toBe('file')
    expect(form.has('note')).toBe(false)
  })

  it('builds a URL-encoded body from fields, booleans as words', async () => {
    const { requests, api } = recorder()
    await api.articles.actions.register(
      { title: 'Hi there', draft: false, count: 3 },
      { contentType: 'application/x-www-form-urlencoded' },
    )
    const body = requests[0]!.rawBody
    expect(body).toBeInstanceOf(URLSearchParams)
    expect(String(body)).toBe('title=Hi+there&draft=false&count=3')
    expect(requests[0]!.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
  })

  it('still sends a ready FormData as it is', async () => {
    const { requests, api } = recorder()
    const form = new FormData()
    form.append('title', 'Raw')
    await api.articles.actions.register(form, { contentType: 'multipart/form-data' })
    expect(requests[0]!.rawBody).toBe(form)
  })

  it('types the fields from the generated map, keeping FormData', () => {
    const { api } = recorder()
    // oxlint-disable-next-line no-constant-condition -- type-level probes only, never run
    if (false as boolean) {
      void api.articles.actions.register({ title: 'x' }, { contentType: 'multipart/form-data' })
      void api.articles.actions.register(new FormData(), { contentType: 'multipart/form-data' })
      void api.articles.actions.register(new URLSearchParams(), {
        contentType: 'application/x-www-form-urlencoded',
      })
      void api.articles.id('1').actions.attach({ file: new Blob([]) })
      void api.articles.id('1').actions.attach(new FormData())
      // @ts-expect-error -- `title` is required.
      void api.articles.actions.register({ tags: [] }, { contentType: 'multipart/form-data' })
      const multipart = { contentType: 'multipart/form-data' } as const
      void api.articles.actions.register({ title: 'x', cover: new Blob([]) }, multipart)
      // @ts-expect-error -- `cover` is a file, not a number.
      void api.articles.actions.register({ title: 'x', cover: 1 }, multipart)
      // @ts-expect-error -- `file` is required.
      void api.articles.id('1').actions.attach({ note: 'x' })
    }
    expectTypeOf(api.articles.actions.raw).parameter(0).toBeUnknown()
  })
})
