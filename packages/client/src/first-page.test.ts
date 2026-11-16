import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import { loadAll } from './load-all'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://music.example'
const COUNTABLE = 'https://example.test/profiles/countable/'

const descriptor = {
  albums: {
    attributes: { title: 'string' },
    relations: {
      tracks: {
        cardinality: 'many',
        types: ['tracks'],
        countable: { tokens: ['_self_'], profile: COUNTABLE },
      },
    },
    paths: {
      fetchOne: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
      fetchRelationship: '/albums/{id}/relationships/{rel}',
    },
    paginator: 'none',
    clientId: 'forbidden',
    includable: ['tracks'],
    resourceCountable: { fetchOne: { tokens: ['tracks'], profile: COUNTABLE } },
  },
  tracks: {
    attributes: { title: 'string' },
    relations: {},
    paths: { fetchMany: '/tracks', fetchOne: '/tracks/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

interface Attributes {
  albums: { title: string }
  tracks: { title: string }
}

const track = (id: string) => ({ type: 'tracks', id, attributes: { title: `Track ${id}` } })
const ref = (id: string) => ({ type: 'tracks', id })
const page = (n: number) => `page[number]=${n}&page[size]=2`

/** The album with the first page of its tracks rendered, as core does for a counted include. */
const album = (included: boolean) => ({
  data: {
    type: 'albums',
    id: '1',
    attributes: { title: 'OK Computer' },
    relationships: {
      tracks: {
        links: {
          self: `${BASE}/albums/1/relationships/tracks`,
          related: `${BASE}/albums/1/tracks`,
          first: `${BASE}/albums/1/relationships/tracks?${page(1)}&withCount=_self_`,
          next: `${BASE}/albums/1/relationships/tracks?${page(2)}&withCount=_self_`,
          last: `${BASE}/albums/1/relationships/tracks?${page(2)}&withCount=_self_`,
        },
        meta: { total: 3 },
        data: [ref('1'), ref('2')],
      },
    },
  },
  ...(included ? { included: [track('1'), track('2')] } : {}),
})

function session(first: unknown) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    const url = decodeURI(req.url)
    const body = url.includes('/albums/1/tracks?')
      ? { data: [track('3')], links: { prev: `${BASE}/albums/1/tracks?${page(1)}` } }
      : url.includes('/relationships/tracks?')
        ? { data: [ref('3')] }
        : first
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }
  const client = createClient<typeof descriptor, Attributes>(descriptor, {
    baseUrl: BASE,
    transport,
  })
  return { client, requests }
}

describe('a to-many that renders its first page', () => {
  it('carries its page links and counted total, and is not the whole set', async () => {
    const { client } = session(album(true))
    const read = await client.albums.get('1', { include: ['tracks'] })
    expect(read.tracks.map((t) => t.title)).toEqual(['Track 1', 'Track 2'])
    expect(read.tracks.$count).toBe(3)
    expect(read.tracks.$page.links).toEqual({
      first: `${BASE}/albums/1/relationships/tracks?${page(1)}&withCount=_self_`,
      next: `${BASE}/albums/1/relationships/tracks?${page(2)}&withCount=_self_`,
      last: `${BASE}/albums/1/relationships/tracks?${page(2)}&withCount=_self_`,
    })
    expectTypeOf(read.tracks.$count).toEqualTypeOf<number | undefined>()
    expectTypeOf(read.tracks.$page.links.next).toEqualTypeOf<string | undefined>()
  })

  it('reads an included page from the related endpoint, keeping the page query', async () => {
    const { client, requests } = session(album(true))
    const read = await client.albums.get('1', { include: ['tracks'] })
    const next = await read.tracks.$next()
    expect(decodeURI(requests[1]!.url)).toBe(`${BASE}/albums/1/tracks?${page(2)}&withCount=_self_`)
    expect(next?.map((t) => t.title)).toEqual(['Track 3'])
  })

  it('reads a page of identifiers as linkage', async () => {
    const { client, requests } = session(album(false))
    const read = await client.albums.get('1')
    const tracks = read.tracks as unknown as { $next(): Promise<unknown[] | undefined> }
    const next = await tracks.$next()
    expect(decodeURI(requests[1]!.url)).toBe(
      `${BASE}/albums/1/relationships/tracks?${page(2)}&withCount=_self_`,
    )
    expect(next).toEqual([{ type: 'tracks', id: '3' }])
  })

  it('walks every page with loadAll', async () => {
    const { client } = session(album(true))
    const read = await client.albums.get('1', { include: ['tracks'] })
    const all = await loadAll(read.tracks)
    expect(all.map((t) => t.title)).toEqual(['Track 1', 'Track 2', 'Track 3'])
  })

  it('stops loadAll at maxPages', async () => {
    const { client, requests } = session(album(true))
    const read = await client.albums.get('1', { include: ['tracks'] })
    expect(await loadAll(read.tracks, { maxPages: 1 })).toHaveLength(2)
    expect(requests).toHaveLength(1)
  })
})
