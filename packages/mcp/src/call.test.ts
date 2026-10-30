import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import { fakeTransport, fixture, modelOf, source } from './test-fixtures'
import type { McpCallToolResult } from './types'

const album = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'albums',
  id,
  attributes: { title: `Album ${id}`, explicit: false },
  relationships: {
    artist: {
      data: { type: 'artists', id: '7' },
      links: { related: `https://music.example/albums/${id}/artist` },
    },
    tracks: {
      data: [
        { type: 'tracks', id: '1' },
        { type: 'tracks', id: '2' },
      ],
    },
  },
  links: { self: `https://music.example/albums/${id}`, store: 'https://store.example.com' },
  ...extra,
})

async function session(
  handler: Parameters<typeof fakeTransport>[0],
  hooks = {},
  includeDepth: number | null = 1,
) {
  const { transport, requests } = fakeTransport(handler)
  const mcp = createJsonApiMcp({ ...fixture('music-catalog', { includeDepth }), transport, hooks })
  return { requests, tools: await mcp.forRequest({ context: undefined }) }
}

const nulls = (names: string[]) => Object.fromEntries(names.map((n) => [n, null]))

const json = (result: McpCallToolResult): unknown =>
  JSON.parse((result.content[0] as { text: string }).text)

describe('list tools', () => {
  it('sends filters, sort and the page size, and flattens the collection', async () => {
    const { requests, tools } = await session(() => ({
      json: {
        data: [album('1')],
        links: {
          self: 'https://music.example/albums',
          next: { href: 'https://music.example/albums?page%5Bnumber%5D=2&page%5Bsize%5D=5' },
          describedby: 'https://music.example/docs.json',
        },
        meta: { page: { currentPage: 1, perPage: 5 } },
      },
    }))
    const result = await tools.callTool('albums_list', {
      ...nulls(['include', 'fields', 'pageLink']),
      filter: {
        title: 'Abbey',
        rating: { min: 3, max: null },
        releasedAt: { min: null, max: null },
        ...nulls(['tracks', 'artist.name', 'q']),
      },
      sort: ['-releasedAt'],
      pageSize: 5,
    })
    expect(decodeURIComponent(requests[0]!.url)).toBe(
      'https://music.example/albums?filter[title]=Abbey&filter[rating][min]=3&sort=-releasedAt&page[size]=5',
    )
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({
      data: [
        {
          id: '1',
          type: 'albums',
          title: 'Album 1',
          explicit: false,
          artist: '7',
          tracks: ['1', '2'],
          links: { store: { href: 'https://store.example.com' } },
        },
      ],
      links: { next: 'https://music.example/albums?page%5Bnumber%5D=2&page%5Bsize%5D=5' },
      meta: { page: { currentPage: 1, perPage: 5 } },
    })
    expect(json(result)).toEqual(result.structuredContent)
  })

  it('caps the page size at the maximum and defaults it small', async () => {
    const { requests, tools } = await session(() => ({ json: { data: [] } }))
    await tools.callTool('albums_list', { pageSize: 500 })
    await tools.callTool('albums_list', {})
    expect(decodeURIComponent(requests[0]!.url)).toBe('https://music.example/albums?page[size]=50')
    expect(decodeURIComponent(requests[1]!.url)).toBe('https://music.example/albums?page[size]=10')
  })

  it('maps the page size to an offset strategy limit', async () => {
    const { transport, requests } = fakeTransport(() => ({ json: { data: [] } }))
    const { document, descriptor } = source('music-catalog')
    const mcp = createJsonApiMcp({
      ...modelOf(document, {
        ...descriptor,
        albums: { ...descriptor['albums']!, paginator: 'offset' },
      }),
      transport,
    })
    await (await mcp.forRequest({ context: undefined })).callTool('albums_list', { pageSize: 3 })
    expect(decodeURIComponent(requests[0]!.url)).toBe('https://music.example/albums?page[limit]=3')
  })

  it('follows a pageLink to its own endpoint and ignores the other arguments', async () => {
    const { requests, tools } = await session(() => ({ json: { data: [album('2')] } }))
    const link = 'https://music.example/albums?page%5Bnumber%5D=2&page%5Bsize%5D=5'
    const result = await tools.callTool('albums_list', {
      pageLink: link,
      pageSize: 50,
      sort: ['title'],
    })
    expect(requests[0]!.url).toBe(link)
    expect(result.structuredContent).toMatchObject({ data: [{ id: '2' }] })
  })

  it('follows a pageLink for a related collection with any parent id', async () => {
    const { requests, tools } = await session(() => ({ json: { data: [] } }))
    const result = await tools.callTool('albums_tracks_list', {
      id: '1',
      pageLink: '/albums/9/tracks?page[number]=3',
    })
    expect(result.isError).toBeUndefined()
    expect(requests[0]!.url).toBe('https://music.example/albums/9/tracks?page[number]=3')
  })

  it.each([
    ['another origin', 'https://evil.example/albums?page[number]=2'],
    ['another endpoint', 'https://music.example/artists?page[number]=2'],
    ['a sub-path', 'https://music.example/albums/1?page[number]=2'],
    ['another scheme', 'javascript:alert(1)'],
    ['not a string', 42],
  ])('refuses a pageLink to %s without sending a request', async (_, link) => {
    const { requests, tools } = await session(() => ({ json: { data: [] } }))
    const result = await tools.callTool('albums_list', { pageLink: link })
    expect(result.isError).toBe(true)
    expect(json(result)).toMatchObject({ error: expect.stringContaining('pageLink') })
    expect(requests).toHaveLength(0)
  })
})

describe('reads', () => {
  it('flattens an included relation in place of its id, and cuts a cycle back to an id', async () => {
    const { requests, tools } = await session(
      () => ({
        json: {
          data: album('1'),
          included: [
            {
              type: 'artists',
              id: '7',
              attributes: { name: 'The Beatles' },
              relationships: {
                albums: {
                  data: [
                    { type: 'albums', id: '1' },
                    { type: 'albums', id: '2' },
                  ],
                },
              },
            },
          ],
        },
      }),
      {},
      null,
    )
    const result = await tools.callTool('albums_get', {
      id: '1',
      include: ['artist', 'artist.albums'],
      fields: { albums: ['title', 'artist'], artists: null, tracks: null, playlists: null },
    })
    expect(decodeURIComponent(requests[0]!.url)).toBe(
      'https://music.example/albums/1?include=artist,artist.albums&fields[albums]=title,artist',
    )
    expect(result.structuredContent).toEqual({
      data: {
        id: '1',
        type: 'albums',
        title: 'Album 1',
        explicit: false,
        artist: { id: '7', type: 'artists', name: 'The Beatles', albums: ['1', '2'] },
        tracks: ['1', '2'],
        links: { store: { href: 'https://store.example.com' } },
      },
    })
  })

  it('nests included resources only as deep as the include depth, and ids below it', async () => {
    const { tools } = await session(() => ({
      json: {
        data: album('1'),
        included: [
          {
            type: 'artists',
            id: '7',
            attributes: { name: 'The Beatles' },
            relationships: { albums: { data: [{ type: 'albums', id: '2' }] } },
          },
          { type: 'albums', id: '2', attributes: { title: 'Album 2' } },
        ],
      },
    }))
    const result = await tools.callTool('albums_get', {
      id: '1',
      include: ['artist'],
      fields: null,
    })
    expect(result.structuredContent).toEqual({
      data: {
        id: '1',
        type: 'albums',
        title: 'Album 1',
        explicit: false,
        artist: { id: '7', type: 'artists', name: 'The Beatles', albums: ['2'] },
        tracks: ['1', '2'],
        links: { store: { href: 'https://store.example.com' } },
      },
    })
  })

  it('refuses an include deeper than the include depth without calling the API', async () => {
    const { requests, tools } = await session(() => ({ json: { data: album('1') } }))
    const result = await tools.callTool('albums_get', {
      id: '1',
      include: ['artist', 'artist.albums'],
      fields: null,
    })
    expect(result.isError).toBe(true)
    expect(json(result)).toEqual({
      error: 'include can\'t name "artist.albums"; this tool includes only artist, tracks',
    })
    expect(requests).toHaveLength(0)
  })

  it('takes a deeper include at a higher include depth', async () => {
    const { requests, tools } = await session(() => ({ json: { data: album('1') } }), {}, 2)
    const result = await tools.callTool('albums_get', {
      id: '1',
      include: ['artist.albums'],
      fields: null,
    })
    expect(result.isError).toBeUndefined()
    expect(decodeURIComponent(requests[0]!.url)).toBe(
      'https://music.example/albums/1?include=artist.albums',
    )
  })

  it('wraps a to-one related read, null when nothing is related', async () => {
    const { tools } = await session(() => ({ json: { data: null } }))
    const result = await tools.callTool('albums_artist_get', { id: '1' })
    expect(result.structuredContent).toEqual({ data: null })
  })

  it('reads a polymorphic relation as type and id', async () => {
    const { transport } = fakeTransport(() => ({
      json: {
        data: {
          type: 'articles',
          id: '1',
          attributes: { title: 'A' },
          relationships: {
            attachments: {
              data: [
                { type: 'images', id: '3' },
                { type: 'videos', id: '4' },
              ],
            },
          },
        },
      },
    }))
    const mcp = createJsonApiMcp({ ...fixture('contract-witness'), transport })
    const result = await (
      await mcp.forRequest({ context: undefined })
    ).callTool('articles_get', { id: '1' })
    expect(result.structuredContent!['data']).toMatchObject({
      attachments: [
        { type: 'images', id: '3' },
        { type: 'videos', id: '4' },
      ],
    })
  })
})

describe('writes', () => {
  it('builds a create document from flat arguments, dropping the nulls that mean "not given"', async () => {
    const { requests, tools } = await session(() => ({ status: 201, json: { data: album('9') } }))
    const result = await tools.callTool('albums_create', {
      title: 'Help!',
      artist: '7',
      tracks: ['1'],
      releaseInfo: { label: 'Parlophone', catalogueNumber: null },
      ...nulls(['releasedAt', 'explicit', 'status', 'availableFrom', 'availableUntil']),
    })
    expect(requests[0]!.method).toBe('POST')
    expect(JSON.parse(requests[0]!.body!)).toEqual({
      data: {
        type: 'albums',
        attributes: { title: 'Help!', releaseInfo: { label: 'Parlophone' } },
        relationships: {
          artist: { data: { type: 'artists', id: '7' } },
          tracks: { data: [{ type: 'tracks', id: '1' }] },
        },
      },
    })
    expect(result.structuredContent).toMatchObject({ data: { id: '9', type: 'albums' } })
  })

  it('clears the fields an update names in clear', async () => {
    const { requests, tools } = await session(() => ({ json: { data: album('1') } }))
    await tools.callTool('albums_update', {
      id: '1',
      title: 'Renamed',
      availableFrom: null,
      clear: ['availableUntil', 'artist'],
    })
    expect(requests[0]!.method).toBe('PATCH')
    expect(JSON.parse(requests[0]!.body!)).toEqual({
      data: {
        type: 'albums',
        id: '1',
        attributes: { title: 'Renamed', availableUntil: null },
        relationships: { artist: { data: null } },
      },
    })
  })

  it('refuses to clear a field that is not nullable', async () => {
    const { requests, tools } = await session(() => ({ json: { data: album('1') } }))
    const result = await tools.callTool('albums_update', { id: '1', clear: ['title'] })
    expect(result.isError).toBe(true)
    expect(requests).toHaveLength(0)
  })

  it('deletes', async () => {
    const { requests, tools } = await session(() => ({ status: 204 }))
    const result = await tools.callTool('albums_delete', { id: '1' })
    expect(requests[0]!.method).toBe('DELETE')
    expect(result.structuredContent).toEqual({ data: null })
    expect(json(result)).toEqual({ data: null })
  })
})

describe('actions', () => {
  it('sends a flat document action', async () => {
    const { requests, tools } = await session(() => ({ json: { data: album('1') } }))
    await tools.callTool('albums_reissue', { id: '1', title: 'Remaster' })
    expect(requests[0]!.url).toBe('https://music.example/albums/1/-actions/reissue')
    expect(JSON.parse(requests[0]!.body!)).toEqual({
      data: { type: 'albums', attributes: { title: 'Remaster' } },
    })
  })

  it('returns a meta-only result as structured content', async () => {
    const { tools } = await session(() => ({ json: { meta: { albums: { total: 15 } } } }))
    const result = await tools.callTool('albums_summary', {})
    expect(result.structuredContent).toEqual({ meta: { albums: { total: 15 } } })
  })

  it('sends a JSON body in the media type it picked', async () => {
    const { requests, tools } = await session(() => ({
      json: { meta: { read: 'application/json' } },
    }))
    await tools.callTool('albums_import', { body: [{ title: 'Rubber Soul', releasedOn: null }] })
    expect(requests[0]!.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(requests[0]!.body!)).toEqual([{ title: 'Rubber Soul' }])
  })

  it('asks a GET action for JSON:API and returns its meta', async () => {
    const { requests, tools } = await session(() => ({ json: { meta: { count: 3 } } }))
    const result = await tools.callTool('albums_export', {})
    expect(requests[0]!.method).toBe('GET')
    expect(requests[0]!.headers['Accept']).toBe('application/vnd.api+json')
    expect(result.structuredContent).toEqual({ meta: { count: 3 } })
  })
})

describe('errors', () => {
  it('turns an error document into a tool error with each code, detail, source and argument', async () => {
    const { tools } = await session(() => ({
      status: 422,
      json: {
        errors: [
          {
            status: '422',
            code: 'VALUE_TOO_SHORT',
            detail: 'The title is too short.',
            source: { pointer: '/data/attributes/title' },
          },
        ],
      },
    }))
    const result = await tools.callTool('albums_create', { title: '' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(json(result)).toEqual({
      error: 'JSON:API request failed with status 422',
      status: 422,
      errors: [
        {
          status: '422',
          code: 'VALUE_TOO_SHORT',
          detail: 'The title is too short.',
          source: { pointer: '/data/attributes/title' },
          path: 'title',
        },
      ],
    })
  })

  it('reports a missing id and an unknown tool as tool errors', async () => {
    const { requests, tools } = await session(() => ({ json: { data: album('1') } }))
    expect((await tools.callTool('albums_get', {})).isError).toBe(true)
    expect(json(await tools.callTool('nope', {}))).toEqual({ error: 'Unknown tool "nope"' })
    expect(requests).toHaveLength(0)
  })

  it('reports a transport failure as a tool error', async () => {
    const { tools } = await session(() => {
      throw new Error('connection refused')
    })
    expect(json(await tools.callTool('albums_get', { id: '1' }))).toEqual({
      error: 'connection refused',
    })
  })
})

describe('multi-method actions', () => {
  it('sends each tool over its own method', async () => {
    const { transport, requests } = fakeTransport(() => ({ json: { meta: { rows: 2 } } }))
    const mcp = createJsonApiMcp({ ...fixture('contract-witness'), transport })
    const exports = await mcp.forRequest({ context: undefined })
    await exports.callTool('articles_export_get', {})
    await exports.callTool('articles_export_post', {})
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'GET /articles/-actions/export',
      'POST /articles/-actions/export',
    ])
  })
})

describe('withCount', () => {
  it('counts the collection under the Countable profile when asked', async () => {
    const { transport, requests } = fakeTransport(() => ({
      json: { data: [], meta: { page: { total: 42 } } },
    }))
    const mcp = createJsonApiMcp({ ...fixture('contract-witness'), transport })
    const tools = await mcp.forRequest({ context: undefined })
    const counted = await tools.callTool('articles_list', { withCount: true })
    await tools.callTool('articles_list', { withCount: null })
    expect(decodeURIComponent(requests[0]!.url)).toContain('withCount=_self_')
    expect(requests[0]!.headers['Accept']).toContain(
      'profile="https://haddowg.github.io/json-api/profiles/countable/"',
    )
    expect(counted.structuredContent).toMatchObject({ meta: { page: { total: 42 } } })
    expect(requests[1]!.url).not.toContain('withCount')
    expect(requests[1]!.headers['Accept']).toBe('application/vnd.api+json')
  })

  it('negotiates the profile when a pageLink carries withCount', async () => {
    const { transport, requests } = fakeTransport(() => ({ json: { data: [] } }))
    const mcp = createJsonApiMcp({ ...fixture('contract-witness'), transport })
    const tools = await mcp.forRequest({ context: undefined })
    await tools.callTool('articles_list', {
      pageLink: 'https://api.example.com/articles?page[number]=2&withCount=_self_',
    })
    expect(requests[0]!.headers['Accept']).toContain('countable')
  })
})
