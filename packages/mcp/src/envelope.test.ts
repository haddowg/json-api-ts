import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema } from './openapi'
import { fakeTransport, fixture, modelOf, source } from './test-fixtures'
import type { McpCallToolResult, McpTool } from './types'

const download = {
  href: 'https://storage.example.com/img-1.png?signature=abc',
  title: 'Original',
  type: 'image/png',
  meta: { method: 'GET', expiresAt: '2030-01-01T00:00:00+00:00', headers: null },
  describedby: 'https://api.example.com/docs.json',
}

const image = (id: string, links: Record<string, unknown> = {}) => ({
  type: 'images',
  id,
  attributes: { width: 640 },
  links: { self: `https://api.example.com/images/${id}`, ...links },
})

async function call(
  name: string,
  args: Record<string, unknown>,
  body: unknown,
  status = 200,
  model = fixture('contract-witness').model,
): Promise<McpCallToolResult> {
  const { transport } = fakeTransport(() =>
    body === undefined ? { status } : { status, json: body },
  )
  const session = await createJsonApiMcp({ model, transport }).forRequest({ context: {} })
  return session.callTool(name, args)
}

const tool = (name: string, model = fixture('contract-witness').model): McpTool =>
  createJsonApiMcp({ model }).tools.find((t) => t.name === name)!

const props = (schema: JsonSchema) => schema['properties'] as Record<string, JsonSchema>

const nullArgs = (name: string, model = fixture('contract-witness').model) =>
  Object.fromEntries(
    Object.keys(props(tool(name, model).inputSchema)).map((key) => [key, null]),
  ) as Record<string, unknown>

describe('named links on a resource', () => {
  it('keeps the declared and action links, each as href, type, title and meta', async () => {
    const result = await call(
      'images_get',
      { id: 'img-1' },
      {
        data: image('img-1', {
          download,
          thumbnail: 'https://cdn.example.com/img-1-small.png',
          related: 'https://api.example.com/elsewhere',
        }),
      },
    )
    expect(result.structuredContent).toEqual({
      data: {
        id: 'img-1',
        type: 'images',
        width: 640,
        links: {
          download: {
            href: download.href,
            type: 'image/png',
            title: 'Original',
            meta: download.meta,
          },
          thumbnail: { href: 'https://cdn.example.com/img-1-small.png' },
        },
      },
    })
  })

  it('leaves out a link the response lacks, and the links member when it has none', async () => {
    const one = await call(
      'images_get',
      { id: 'img-1' },
      { data: image('img-1', { thumbnail: null, download }) },
    )
    expect(Object.keys((one.structuredContent!['data'] as { links: object }).links)).toEqual([
      'download',
    ])
    const none = await call('images_get', { id: 'img-1' }, { data: image('img-1') })
    expect(none.structuredContent!['data']).not.toHaveProperty('links')
  })

  it('keeps an action link and the links of each resource in a collection', async () => {
    const article = {
      type: 'articles',
      id: 'art-1',
      attributes: { title: 'Hi' },
      links: {
        self: 'https://api.example.com/articles/art-1',
        publish: { href: 'https://api.example.com/articles/art-1/-actions/publish' },
      },
    }
    const result = await call(
      'articles_list',
      { ...nullArgs('articles_list'), pageSize: null },
      { data: [article] },
    )
    expect(result.structuredContent!['data']).toEqual([
      {
        id: 'art-1',
        type: 'articles',
        title: 'Hi',
        links: { publish: { href: 'https://api.example.com/articles/art-1/-actions/publish' } },
      },
    ])
  })

  it('keeps the links of an included resource', async () => {
    const preview = {
      href: 'https://cdn.example.com/1.mp3',
      type: 'audio/mpeg',
      meta: { format: 'mp3', expiresAt: null },
    }
    const result = await call(
      'albums_get',
      { id: '1', include: ['tracks'], fields: null },
      {
        data: {
          type: 'albums',
          id: '1',
          attributes: { title: 'Help!' },
          relationships: { tracks: { data: [{ type: 'tracks', id: '5' }] } },
        },
        included: [
          { type: 'tracks', id: '5', attributes: { title: 'Yesterday' }, links: { preview } },
        ],
      },
      200,
      fixture('music-catalog').model,
    )
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined()
    const data = result.structuredContent!['data'] as { tracks: { links: object }[] }
    expect(data.tracks[0]!.links).toEqual({ preview })
  })

  it('types each named link from the document, meta members included', () => {
    const defs = tool('images_get').outputSchema!['$defs'] as Record<string, JsonSchema>
    const links = props(props(defs['images']!)['links']!)
    expect(links['download']).toEqual({
      type: 'object',
      description: 'Where to fetch the original file.',
      properties: {
        href: { type: 'string', format: 'uri-reference' },
        type: { type: 'string', const: 'image/png' },
        title: { type: 'string', const: 'Original' },
        meta: {
          type: 'object',
          properties: {
            method: { type: 'string', description: 'The HTTP method to use.', enum: ['GET'] },
            expiresAt: {
              type: 'string',
              format: 'date-time',
              description: 'When the URL stops working.',
            },
            headers: { type: ['object', 'null'], additionalProperties: {} },
          },
          required: ['method', 'expiresAt'],
        },
      },
      required: ['href', 'title', 'type', 'meta'],
    })
    expect(links['thumbnail']).toMatchObject({
      type: 'object',
      properties: { href: { type: 'string' }, title: { type: 'string' }, meta: { type: 'object' } },
      required: ['href'],
    })
    const articles = (tool('articles_get').outputSchema!['$defs'] as Record<string, JsonSchema>)[
      'articles'
    ]!
    expect(props(props(articles)['links']!)['publish']).toEqual({
      type: 'object',
      description: 'Present while the article is a draft.',
      properties: { href: { type: 'string', format: 'uri-reference' }, meta: { type: 'object' } },
      required: ['href'],
    })
  })

  it('records the link names in the model', () => {
    expect(fixture('contract-witness').model.resourceLinks).toEqual({
      articles: ['publish', 'download'],
      images: ['download', 'thumbnail'],
    })
  })

  it('refuses a type that names links and has a field called links', () => {
    const { document, descriptor } = source('contract-witness')
    const images = descriptor['images']!
    expect(() =>
      modelOf(document, {
        ...descriptor,
        images: { ...images, attributes: { ...images.attributes, links: 'string' } },
      }),
    ).toThrow(
      /"images" type names links \(download, thumbnail\) and also has a field called "links"/,
    )
  })
})

describe('the envelope', () => {
  it('keeps the document meta of a single resource', async () => {
    const result = await call(
      'images_get',
      { id: 'img-1' },
      { data: image('img-1'), meta: { cached: true } },
    )
    expect(result.structuredContent).toEqual({
      data: { id: 'img-1', type: 'images', width: 640 },
      meta: { cached: true },
    })
  })

  it('returns a delete as null data, keeping any meta the API sends', async () => {
    const plain = await call('articles_delete', { id: 'art-1' }, undefined, 204)
    expect(plain.structuredContent).toEqual({ data: null })
    const withMeta = await call('articles_delete', { id: 'art-1' }, { meta: { purged: 3 } })
    expect(withMeta.structuredContent).toEqual({ data: null, meta: { purged: 3 } })
  })

  it('keeps the meta of a to-one related read with nothing related', async () => {
    const result = await call(
      'articles_author_get',
      { ...nullArgs('articles_author_get'), id: 'art-1' },
      { data: null, meta: { reason: 'anonymous' } },
    )
    expect(result.structuredContent).toEqual({ data: null, meta: { reason: 'anonymous' } })
  })

  it('mirrors the structured content in the text', async () => {
    const result = await call('images_get', { id: 'img-1' }, { data: image('img-1', { download }) })
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
      result.structuredContent,
    )
  })
})

/** A 1.2 model: format 3, no resource links. */
const legacy = () => {
  const { model } = fixture('music-catalog')
  const { resourceLinks: _links, ...rest } = model
  return { ...rest, format: 3 as const }
}

describe('models before format 4', () => {
  const album = {
    type: 'albums',
    id: '1',
    attributes: { title: 'Help!' },
    links: { store: 'https://store.example.com' },
  }

  it('get the results their output schemas describe', async () => {
    const model = legacy()
    expect(
      (await call('albums_get', { id: '1' }, { data: album }, 200, model)).structuredContent,
    ).toEqual({ item: { id: '1', type: 'albums', title: 'Help!' } })
    expect(
      (await call('albums_list', {}, { data: [album], meta: { n: 1 } }, 200, model))
        .structuredContent,
    ).toEqual({ items: [{ id: '1', type: 'albums', title: 'Help!' }], links: {}, meta: { n: 1 } })
    expect(
      (await call('albums_create', { title: 'Help!' }, { data: album }, 201, model))
        .structuredContent,
    ).toEqual({ id: '1', type: 'albums', title: 'Help!' })
    expect(await call('albums_delete', { id: '1' }, undefined, 204, model)).toEqual({
      content: [{ type: 'text', text: 'Deleted albums 1.' }],
    })
    expect(
      (await call('albums_summary', {}, { meta: { total: 2 } }, 200, model)).structuredContent,
    ).toEqual({ total: 2 })
  })
})

describe('every result matches its output schema', () => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false })
  const witness = fixture('contract-witness').model
  const catalog = fixture('music-catalog').model
  const article = {
    type: 'articles',
    id: 'art-1',
    attributes: { title: 'Hello' },
    links: { publish: { href: 'https://api.example.com/articles/art-1/-actions/publish' } },
  }
  const album = {
    type: 'albums',
    id: '1',
    attributes: { title: 'Help!' },
    relationships: { artist: { data: { type: 'artists', id: '7' } } },
    links: {
      store: 'https://store.example.com',
      reissue: { href: 'https://music.example/albums/1/-actions/reissue' },
    },
  }
  const location = {
    links: { location: { href: 'https://storage.example.com/1.csv', type: 'text/csv' } },
  }
  const cases: [string, typeof witness, Record<string, unknown>, unknown, number][] = [
    ['images_get', witness, { id: 'img-1' }, { data: image('img-1', { download }) }, 200],
    ['images_list', witness, {}, { data: [image('img-1')], meta: { page: {} } }, 200],
    ['articles_get', witness, { id: 'art-1' }, { data: article, meta: { x: 1 } }, 200],
    ['articles_delete', witness, { id: 'art-1' }, undefined, 204],
    ['articles_author_get', witness, { id: 'art-1' }, { data: null }, 200],
    ['articles_download', witness, { id: 'art-1' }, location, 200],
    ['albums_create', catalog, { title: 'Help!' }, { data: album }, 201],
    ['albums_update', catalog, { id: '1', title: 'Help!' }, { data: album }, 200],
    ['albums_summary', catalog, {}, { meta: { albums: { total: 15 } } }, 200],
    ['albums_download', catalog, { id: '1' }, location, 200],
    ['albums_reissue', catalog, { id: '1' }, { data: album }, 200],
  ]
  it.each(cases)('%s', async (name, model, args, body, status) => {
    const result = await call(name, { ...nullArgs(name, model), ...args }, body, status, model)
    expect(result.isError).toBeUndefined()
    const validate = ajv.compile(tool(name, model).outputSchema!)
    expect(validate(result.structuredContent), JSON.stringify(validate.errors)).toBe(true)
  })
})
