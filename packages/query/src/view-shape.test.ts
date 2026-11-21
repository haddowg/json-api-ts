import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { InfiniteQueryObserver, QueryClient, skipToken } from '@tanstack/query-core'
import { describe, expect, it } from 'vitest'
import { installNormalization } from './install'
import { infiniteKeyFor, keyFor } from './keys'
import { JsonApiMutationCache } from './mutation-cache'
import {
  createQueryApi,
  getQueryOptions,
  infiniteListQueryOptions,
  infiniteRelatedQueryOptions,
  listQueryOptions,
  relatedQueryOptions,
  relationshipQueryOptions,
} from './read'
import { withScope } from './scope'
import {
  describeQuery,
  fits,
  IDENTIFIERS,
  isComplete,
  isUnfilteredUnsorted,
  type QueryDescription,
  type ResourcesShape,
  slotShape,
  viewShape,
} from './view-shape'

const BASE = 'https://music.example'

const descriptor = {
  albums: {
    attributes: { title: 'string', year: 'integer', credits: 'object' },
    relations: {
      artist: { cardinality: 'one', types: ['artists'] },
      tracks: { cardinality: 'many', types: ['tracks'] },
      drafts: { cardinality: 'many', types: ['tracks'], writeOnly: true },
    },
    paths: {
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
      fetchRelationship: '/albums/{id}/relationships/{rel}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    nestedFieldsets: { credits: '(?:producer|engineer)' },
  },
  tracks: {
    attributes: { title: 'string', duration: 'integer' },
    relations: { artist: { cardinality: 'one', types: ['artists'] } },
    paths: { fetchMany: '/tracks', fetchOne: '/tracks/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
  artists: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchOne: '/artists/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
  playlists: {
    attributes: { name: 'string' },
    relations: {
      items: { cardinality: 'many', types: ['tracks', 'albums'], polymorphic: true },
    },
    paths: {
      fetchOne: '/playlists/{id}',
      fetchRelated: '/playlists/{id}/{rel}',
      fetchRelationship: '/playlists/{id}/relationships/{rel}',
    },
    paginator: 'page',
    clientId: 'forbidden',
  },
  inboxes: {
    attributes: { unread: 'integer' },
    relations: { messages: { cardinality: 'many', types: ['messages'] } },
    paths: {
      fetchOne: '/inbox',
      fetchRelated: '/inbox/{rel}',
      fetchRelationship: '/inbox/relationships/{rel}',
    },
    paginator: 'none',
    clientId: 'forbidden',
    singleton: true,
  },
  messages: {
    attributes: { body: 'string' },
    relations: {},
    paths: {},
    paginator: 'page',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

/** A client whose transport answers each request with `respond(url)`. */
function setup(respond: (url: URL) => unknown = () => ({ data: [] })) {
  const transport = async (req: TransportRequest): Promise<TransportResponse> => ({
    status: 200,
    headers: {},
    body: JSON.stringify(respond(new URL(req.url))),
  })
  const client = createClient(descriptor, { baseUrl: BASE, transport })
  const queryClient = new QueryClient({
    mutationCache: new JsonApiMutationCache(),
    defaultOptions: { queries: { staleTime: Infinity } },
  })
  installNormalization(queryClient, descriptor)
  return { client, queryClient }
}

const describeKey = (key: readonly unknown[]) => describeQuery(key, descriptor)

describe('describeQuery', () => {
  const { client } = setup()
  const api = createQueryApi(client)

  it('decodes a list key with every param family', () => {
    const options = listQueryOptions(client, 'albums', {
      filter: { title: 'x' },
      sort: '-year',
      page: { number: 2 },
      include: ['tracks', 'tracks.artist'],
      fields: { albums: ['title', 'credits.producer'], tracks: ['title'] },
      withCount: ['tracks'],
      relatedQuery: { tracks: { sort: 'title' } },
    } as never)
    expect(describeKey(options.queryKey)).toEqual({
      type: 'albums',
      operation: 'fetchMany',
      params: {
        filter: { title: 'x' },
        sort: '-year',
        page: { number: 2 },
        include: ['tracks', 'tracks.artist'],
        fields: { albums: ['title', 'credits.producer'], tracks: ['title'] },
        withCount: ['tracks'],
        relatedQuery: { tracks: { sort: 'title' } },
      },
      infinite: false,
      skipped: false,
      types: ['albums'],
      collection: true,
    } satisfies QueryDescription)
    expect(describeKey(listQueryOptions(client, 'albums').queryKey)).toMatchObject({
      operation: 'fetchMany',
      params: {},
    })
  })

  it('decodes a single read, with and without params', () => {
    expect(describeKey(getQueryOptions(client, 'albums', '1').queryKey)).toEqual({
      type: 'albums',
      operation: 'fetchOne',
      id: '1',
      params: {},
      infinite: false,
      skipped: false,
      types: ['albums'],
      collection: false,
    })
    expect(
      describeKey(
        getQueryOptions(client, 'albums', '1', { include: ['artist'] } as never).queryKey,
      ),
    ).toMatchObject({ id: '1', params: { include: ['artist'] } })
  })

  it("decodes a related read as its relation's target types, and a relationship read", () => {
    expect(
      describeKey(relatedQueryOptions(client, 'albums', '1', 'tracks' as never).queryKey),
    ).toMatchObject({
      type: 'albums',
      operation: 'fetchRelated',
      id: '1',
      rel: 'tracks',
      types: ['tracks'],
      collection: true,
    })
    expect(
      describeKey(relationshipQueryOptions(client, 'albums', '1', 'artist' as never).queryKey),
    ).toMatchObject({
      operation: 'fetchRelationship',
      rel: 'artist',
      types: ['artists'],
      collection: false,
    })
    // A polymorphic relation: a set of types.
    expect(
      describeKey(relatedQueryOptions(client, 'playlists', 'p1', 'items' as never).queryKey),
    ).toMatchObject({ types: ['tracks', 'albums'], collection: true })
  })

  it("decodes a singleton's reads, which carry no id", () => {
    const inbox = (api as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)
      .inboxes!
    const get = inbox['get']!({ include: ['messages'] }) as { queryKey: readonly unknown[] }
    expect(describeKey(get.queryKey)).toEqual({
      type: 'inboxes',
      operation: 'fetchOne',
      params: { include: ['messages'] },
      infinite: false,
      skipped: false,
      types: ['inboxes'],
      collection: false,
    })
    const related = relatedQueryOptions(client, 'inboxes', undefined as never, 'messages' as never)
    expect(describeKey(related.queryKey)).toEqual({
      type: 'inboxes',
      operation: 'fetchRelated',
      rel: 'messages',
      params: {},
      infinite: false,
      skipped: false,
      types: ['messages'],
      collection: true,
    })
    expect(
      describeKey(keyFor({ type: 'inboxes', operation: 'fetchRelationship', rel: 'messages' })),
    ).toMatchObject({ operation: 'fetchRelationship', rel: 'messages' })
  })

  it('decodes infinite reads', () => {
    expect(
      describeKey(infiniteListQueryOptions(client, 'albums', { sort: 'title' } as never).queryKey),
    ).toMatchObject({ operation: 'fetchMany', infinite: true, params: { sort: 'title' } })
    expect(
      describeKey(infiniteRelatedQueryOptions(client, 'albums', '1', 'tracks' as never).queryKey),
    ).toMatchObject({ operation: 'fetchRelated', id: '1', rel: 'tracks', infinite: true })
    // Only lists and related reads are ever infinite.
    expect(
      describeKey(infiniteKeyFor({ type: 'albums', operation: 'fetchOne', id: '1' })),
    ).toBeUndefined()
  })

  it('decodes skipped reads, plain and infinite', () => {
    expect(describeKey(listQueryOptions(client, 'albums', skipToken).queryKey)).toEqual({
      type: 'albums',
      operation: 'fetchMany',
      params: {},
      infinite: false,
      skipped: true,
      types: ['albums'],
      collection: true,
    })
    expect(describeKey(getQueryOptions(client, 'albums', skipToken).queryKey)).toMatchObject({
      operation: 'fetchOne',
      skipped: true,
    })
    const related = relatedQueryOptions(client, 'albums', skipToken, 'tracks' as never)
    expect(describeKey(related.queryKey)).toMatchObject({
      operation: 'fetchRelated',
      rel: 'tracks',
      skipped: true,
    })
    expect(describeKey(related.queryKey)).not.toHaveProperty('id')
    expect(
      describeKey(
        infiniteRelatedQueryOptions(client, 'albums', skipToken, 'tracks' as never).queryKey,
      ),
    ).toMatchObject({ rel: 'tracks', skipped: true, infinite: true })
    // A key hashed and rebuilt (as `hydrate` does) holds an equal skip segment, not the same one.
    const rebuilt = JSON.parse(JSON.stringify(related.queryKey)) as readonly unknown[]
    expect(describeKey(rebuilt)).toMatchObject({ rel: 'tracks', skipped: true })
    // An id spelt like the skip segment's member is an id.
    expect(describeKey(getQueryOptions(client, 'albums', '$skip').queryKey)).toMatchObject({
      id: '$skip',
      skipped: false,
    })
  })

  it('decodes scoped keys, keeping the scope', () => {
    const scoped = withScope('admin', getQueryOptions(client, 'albums', '1'))
    expect(describeKey(scoped.queryKey)).toMatchObject({ scope: 'admin', id: '1' })
    const reads = createQueryApi(client, { scope: 'admin' })
    const list = (reads as unknown as Record<string, Record<string, (q?: unknown) => unknown>>)
      .albums!['list']!({ sort: 'title' }) as { queryKey: readonly unknown[] }
    expect(describeKey(list.queryKey)).toMatchObject({ scope: 'admin', params: { sort: 'title' } })
    expect(
      describeKey(withScope('admin', infiniteListQueryOptions(client, 'albums')).queryKey),
    ).toMatchObject({ scope: 'admin', infinite: true })
  })

  it("answers undefined for a key that isn't the binding's", () => {
    expect(describeKey(['todos'])).toBeUndefined()
    expect(describeKey(['unknown', 'fetchMany'])).toBeUndefined()
    expect(describeKey(['albums', 'create'])).toBeUndefined()
    expect(describeKey(['albums', 'fetchOne'])).toBeUndefined()
    expect(describeKey(['albums', 'fetchOne', '1', 'extra'])).toBeUndefined()
    expect(describeKey(['albums', 'fetchRelated', '1', 'nope'])).toBeUndefined()
    // A write-only relation has no read.
    expect(describeKey(['albums', 'fetchRelated', '1', 'drafts'])).toBeUndefined()
    expect(describeKey(['albums', 'fetchMany', { sort: 'title' }, { more: 1 }])).toBeUndefined()
  })

  it('takes a Query as well as a key', () => {
    const { queryClient } = setup()
    const query = queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: ['albums', 'fetchOne', '7'] })
    expect(describeQuery(query, descriptor)).toMatchObject({ id: '7' })
  })
})

/** A view shape from a key, through its description. */
const shapeOf = (key: readonly unknown[]) => viewShape(describeKey(key)!, descriptor)

const asResources = (shape: unknown) => {
  const resources = shape as ResourcesShape
  expect(resources.kind).toBe('resources')
  return resources
}

describe('viewShape', () => {
  it('promises identifiers for a relationship read', () => {
    expect(shapeOf(['albums', 'fetchRelationship', '1', 'tracks'])).toBe(IDENTIFIERS)
  })

  it("promises every declared attribute of the view's type when no fieldset is given", () => {
    const shape = asResources(shapeOf(['albums', 'fetchOne', '1']))
    expect([...shape.types]).toEqual(['albums'])
    expect([...shape.attributes.get('albums')!]).toEqual(['title', 'year', 'credits'])
    expect(shape.relations.size).toBe(0)
    // Every readable relation renders, unincluded: as identifiers. A write-only one never does.
    expect(slotShape(shape, 'albums', 'tracks')).toBe(IDENTIFIERS)
    expect(slotShape(shape, 'albums', 'drafts')).toBeUndefined()
    expect(slotShape(IDENTIFIERS, 'albums', 'tracks')).toBeUndefined()
  })

  it('narrows to the fieldset, counting a key-selected attribute as selected', () => {
    const shape = asResources(
      shapeOf(
        keyFor(
          { type: 'albums', operation: 'fetchMany' },
          { fields: { albums: ['title', 'credits.producer'] } },
        ),
      ),
    )
    expect([...shape.attributes.get('albums')!]).toEqual(['title', 'credits'])
    // A relation the fieldset leaves out isn't rendered.
    expect(slotShape(shape, 'albums', 'artist')).toBeUndefined()
  })

  it('hydrates included paths below, nested, each narrowed by its own type’s fieldset', () => {
    const shape = asResources(
      shapeOf(
        keyFor(
          { type: 'albums', operation: 'fetchOne', id: '1' },
          {
            include: ['tracks', 'tracks.artist', 'artist'],
            fields: { tracks: ['title', 'artist'] },
          },
        ),
      ),
    )
    const tracks = asResources(shape.relations.get('tracks'))
    expect([...tracks.types]).toEqual(['tracks'])
    expect([...tracks.attributes.get('tracks')!]).toEqual(['title'])
    const artist = asResources(tracks.relations.get('artist'))
    expect([...artist.attributes.get('artists')!]).toEqual(['name'])
    expect(asResources(shape.relations.get('artist')).types.has('artists')).toBe(true)
    expect(slotShape(shape, 'albums', 'tracks')).toBe(tracks)
  })

  it('reaches a nested path without its parent listed alone', () => {
    const shape = asResources(
      shapeOf(
        keyFor({ type: 'albums', operation: 'fetchOne', id: '1' }, { include: ['tracks.artist'] }),
      ),
    )
    expect(asResources(shape.relations.get('tracks')).relations.has('artist')).toBe(true)
  })

  it('describes a related read by its target types, polymorphic ones per type', () => {
    const shape = asResources(
      shapeOf(
        keyFor(
          { type: 'playlists', operation: 'fetchRelated', id: 'p1', rel: 'items' },
          { fields: { albums: ['title'] }, include: ['artist'] },
        ),
      ),
    )
    expect([...shape.types]).toEqual(['tracks', 'albums'])
    expect([...shape.attributes.get('tracks')!]).toEqual(['title', 'duration'])
    expect([...shape.attributes.get('albums')!]).toEqual(['title'])
    // `artist` renders on tracks, but albums' fieldset leaves it out.
    expect(shape.rendered.get('tracks')!.has('artist')).toBe(true)
    expect(shape.rendered.get('albums')!.has('artist')).toBe(false)
    expect(shape.relations.has('artist')).toBe(true)
  })
})

/** What the transport of a client built by {@link replying} answers with. */
let reply: (url: URL) => unknown = () => ({ data: [] })

/** A client answering with whatever {@link reply} says at the time. */
const replying = () => setup((url) => reply(url))

/**
 * A materialised read, fetched through a fresh QueryClient. The options must come from a
 * {@link replying} client, which answers with `respond`.
 */
async function fetched(respond: (url: URL) => unknown, options: { queryKey: readonly unknown[] }) {
  reply = respond
  const { queryClient } = setup()
  await queryClient.fetchQuery(options as never)
  return queryClient.getQueryData(options.queryKey as never) as unknown
}

const album = {
  type: 'albums',
  id: '1',
  attributes: { title: 'Blue', year: 1971, credits: { producer: 'J' } },
  relationships: {
    artist: { data: { type: 'artists', id: 'a1' } },
    tracks: { data: [{ type: 'tracks', id: 't1' }] },
  },
}
const track = {
  type: 'tracks',
  id: 't1',
  attributes: { title: 'All I Want', duration: 200 },
  relationships: { artist: { data: { type: 'artists', id: 'a1' } } },
}
const artist = { type: 'artists', id: 'a1', attributes: { name: 'Joni' } }

describe('fits', () => {
  const { client } = replying()

  it("accepts every view's own data at its own shape", async () => {
    const full = getQueryOptions(client, 'albums', '1', {
      include: ['tracks', 'tracks.artist', 'artist'],
    } as never)
    const data = await fetched(() => ({ data: album, included: [track, artist] }), full)
    expect(fits(data, shapeOf(full.queryKey), descriptor)).toBe(true)
    // Its included tracks fit the related read's shape too.
    const related = shapeOf(
      keyFor({ type: 'albums', operation: 'fetchRelated', id: '1', rel: 'tracks' }),
    )
    expect(fits((data as { tracks: unknown[] }).tracks[0], related, descriptor)).toBe(true)
  })

  it('rejects a sparse copy where the view selects a missing attribute', async () => {
    const sparse = getQueryOptions(client, 'albums', '1', {
      fields: { albums: ['title'] },
    } as never)
    const data = await fetched(
      () => ({ data: { type: 'albums', id: '1', attributes: { title: 'Blue' } } }),
      sparse,
    )
    expect(fits(data, shapeOf(sparse.queryKey), descriptor)).toBe(true)
    expect(fits(data, shapeOf(['albums', 'fetchOne', '1']), descriptor)).toBe(false)
  })

  it('takes a key-selected attribute as present when the member holds it, whole or in part', () => {
    const shape = shapeOf(
      keyFor(
        { type: 'albums', operation: 'fetchOne', id: '1' },
        { fields: { albums: ['credits.producer'] } },
      ),
    )
    expect(fits({ type: 'albums', id: '1', credits: { producer: 'J' } }, shape, descriptor)).toBe(
      true,
    )
    expect(fits({ type: 'albums', id: '1', credits: {} }, shape, descriptor)).toBe(true)
    expect(fits({ type: 'albums', id: '1', title: 'Blue' }, shape, descriptor)).toBe(false)
  })

  it('rejects a member of the wrong type', () => {
    const shape = shapeOf(
      keyFor({ type: 'albums', operation: 'fetchRelated', id: '1', rel: 'tracks' }),
    )
    expect(fits({ type: 'albums', id: 't1', title: 'x', duration: 1 }, shape, descriptor)).toBe(
      false,
    )
    expect(fits({ type: 'tracks', id: 't1', title: 'x', duration: 1 }, shape, descriptor)).toBe(
      true,
    )
  })

  it('rejects a member missing a nested include, or holding identifiers there', async () => {
    const shape = shapeOf(
      keyFor(
        { type: 'albums', operation: 'fetchOne', id: '1' },
        { include: ['tracks', 'tracks.artist'] },
      ),
    )
    // Fetched without the nested artist: each track's artist is an identifier.
    const shallow = getQueryOptions(client, 'albums', '1', { include: ['tracks'] } as never)
    const data = await fetched(() => ({ data: album, included: [track] }), shallow)
    expect(fits(data, shapeOf(shallow.queryKey), descriptor)).toBe(true)
    expect(fits(data, shape, descriptor)).toBe(false)
    // No tracks slot at all.
    expect(
      fits({ type: 'albums', id: '1', title: 'B', year: 1, credits: {} }, shape, descriptor),
    ).toBe(false)
    // An empty to-many and a null to-one both fit.
    expect(
      fits(
        { type: 'albums', id: '1', title: 'B', year: 1, credits: {}, tracks: [] },
        shape,
        descriptor,
      ),
    ).toBe(true)
    const withArtist = shapeOf(
      keyFor({ type: 'albums', operation: 'fetchOne', id: '1' }, { include: ['artist'] }),
    )
    expect(
      fits(
        { type: 'albums', id: '1', title: 'B', year: 1, credits: {}, artist: null },
        withArtist,
        descriptor,
      ),
    ).toBe(true)
    expect(
      fits(
        {
          type: 'albums',
          id: '1',
          title: 'B',
          year: 1,
          credits: {},
          artist: { type: 'artists', id: 'a1' },
        },
        withArtist,
        descriptor,
      ),
    ).toBe(false)
  })

  it('rejects an identifier for a resources slot, even of an attribute-less fieldset', async () => {
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks' as never)
    const data = (await fetched(
      () => ({ data: [{ type: 'tracks', id: 't1' }] }),
      linkage,
    )) as unknown[]
    const resources = shapeOf(
      keyFor(
        { type: 'albums', operation: 'fetchRelated', id: '1', rel: 'tracks' },
        { fields: { tracks: [] } },
      ),
    )
    expect(fits(data[0], resources, descriptor)).toBe(false)
    expect(fits({ type: 'tracks', id: 't1' }, resources, descriptor)).toBe(false)
  })

  it('accepts anything with type and id in an identifiers slot', () => {
    expect(fits({ type: 'tracks', id: 't1' }, IDENTIFIERS, descriptor)).toBe(true)
    expect(fits({ type: 'anything', id: 'x', extra: 1 }, IDENTIFIERS, descriptor)).toBe(true)
    expect(fits({ type: 'tracks' }, IDENTIFIERS, descriptor)).toBe(false)
    expect(fits(null, IDENTIFIERS, descriptor)).toBe(false)
  })

  it('checks a polymorphic member against its own type', () => {
    const shape = shapeOf(
      keyFor(
        { type: 'playlists', operation: 'fetchRelated', id: 'p1', rel: 'items' },
        { fields: { albums: ['title'] }, include: ['artist'] },
      ),
    )
    // An album needs only its title, and doesn't render artist.
    expect(fits({ type: 'albums', id: '1', title: 'B' }, shape, descriptor)).toBe(true)
    // A track needs both attributes and its included artist.
    expect(fits({ type: 'tracks', id: 't1', title: 'T', duration: 1 }, shape, descriptor)).toBe(
      false,
    )
    expect(
      fits(
        {
          type: 'tracks',
          id: 't1',
          title: 'T',
          duration: 1,
          artist: { type: 'artists', id: 'a', name: 'N' },
        },
        shape,
        descriptor,
      ),
    ).toBe(true)
  })
})

/** A page of albums answered with a `next` link while `more`. */
const albumsPage = (more: boolean) => ({
  data: [{ type: 'albums', id: '1', attributes: { title: 'B', year: 1, credits: {} } }],
  links: more ? { next: `${BASE}/albums?page%5Bnumber%5D=2` } : {},
})

describe('isComplete', () => {
  const { client } = replying()

  it('is complete for a collection with no next link, and not for a windowed one', async () => {
    const list = listQueryOptions(client, 'albums')
    expect(isComplete(await fetched(() => albumsPage(false), list))).toBe(true)
    expect(isComplete(await fetched(() => albumsPage(true), list))).toBe(false)
  })

  it('judges an included to-many by its own page links', async () => {
    const options = getQueryOptions(client, 'albums', '1', { include: ['tracks'] } as never)
    const windowed = {
      ...album,
      relationships: {
        tracks: {
          data: [{ type: 'tracks', id: 't1' }],
          links: { next: `${BASE}/albums/1/relationships/tracks?page%5Bnumber%5D=2` },
        },
      },
    }
    const whole = (await fetched(() => ({ data: album, included: [track] }), options)) as {
      tracks: unknown
    }
    const partial = (await fetched(() => ({ data: windowed, included: [track] }), options)) as {
      tracks: unknown
    }
    expect(isComplete(whole.tracks)).toBe(true)
    expect(isComplete(partial.tracks)).toBe(false)
  })

  it('reads the last loaded page of an infinite query', async () => {
    const { client: paged, queryClient } = setup((url) =>
      albumsPage(url.searchParams.get('page[number]') !== '2'),
    )
    const infinite = infiniteListQueryOptions(paged, 'albums')
    await queryClient.fetchInfiniteQuery(infinite as never)
    expect(isComplete(queryClient.getQueryData(infinite.queryKey as never))).toBe(false)
    const observer = new InfiniteQueryObserver(queryClient, infinite as never)
    await observer.fetchNextPage()
    observer.destroy()
    const both = queryClient.getQueryData(infinite.queryKey as never) as { pages: unknown[] }
    expect(both.pages).toHaveLength(2)
    expect(isComplete(both)).toBe(true)
    expect(isComplete({ pages: [], pageParams: [] })).toBe(false)
  })

  it('is not complete for anything that says nothing of its paging', () => {
    expect(isComplete([])).toBe(false)
    expect(isComplete({ type: 'albums', id: '1' })).toBe(false)
    expect(isComplete(undefined)).toBe(false)
  })
})

describe('isUnfilteredUnsorted', () => {
  const description = (params: object) =>
    describeKey(keyFor({ type: 'albums', operation: 'fetchMany' }, params))!

  it('holds for a view with no filter and no explicit sort', () => {
    expect(isUnfilteredUnsorted(description({}))).toBe(true)
    expect(isUnfilteredUnsorted(description({ page: { number: 1 }, include: ['tracks'] }))).toBe(
      true,
    )
    expect(isUnfilteredUnsorted(description({ filter: { title: 'x' } }))).toBe(false)
    expect(isUnfilteredUnsorted(description({ sort: '-year' }))).toBe(false)
    expect(isUnfilteredUnsorted(description({ sort: ['title'] }))).toBe(false)
  })

  it("asks of a relation's slot through the view's relatedQuery", () => {
    const view = description({ include: ['tracks'], relatedQuery: { tracks: { sort: 'title' } } })
    expect(isUnfilteredUnsorted(view, 'tracks')).toBe(false)
    expect(isUnfilteredUnsorted(view, 'artist')).toBe(true)
    expect(
      isUnfilteredUnsorted(
        description({ relatedQuery: { tracks: { filter: { a: 1 } } } }),
        'tracks',
      ),
    ).toBe(false)
  })
})
