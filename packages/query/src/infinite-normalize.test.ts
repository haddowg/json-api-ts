import {
  type ApiDescriptor,
  createClient,
  isMaterialised,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { type InfiniteData, InfiniteQueryObserver, QueryClient } from '@tanstack/query-core'
import { describe, expect, it } from 'vitest'
import { installNormalization } from './install'
import { openDraft } from './draft'
import { applyOptimisticPatch, isMaterialisedData } from './normalize'
import { getQueryOptions, infiniteListQueryOptions, infiniteRelatedQueryOptions } from './read'

const BASE = 'https://music.example'

const descriptor = {
  albums: {
    attributes: { title: 'string' },
    relations: {
      artist: { cardinality: 'one', types: ['artists'], pivot: false },
      tracks: { cardinality: 'many', types: ['tracks'], pivot: false },
    },
    paths: {
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
    },
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
  tracks: {
    attributes: { title: 'string' },
    relations: {},
    paths: { fetchOne: '/tracks/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

/**
 * A catalog of four albums served two to a page, whose titles a test can rename between reads, as
 * the server's data changing would.
 */
function setup() {
  const titles = new Map([
    ['1', 'One'],
    ['2', 'Two'],
    ['3', 'Three'],
    ['4', 'Four'],
  ])
  const album = (id: string) => ({ type: 'albums', id, attributes: { title: titles.get(id) } })
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    const url = new URL(req.url)
    let body: unknown
    if (url.pathname === '/albums') {
      const number = Number(url.searchParams.get('page[number]') ?? '1')
      const ids = number === 1 ? ['1', '2'] : ['3', '4']
      body = {
        data: ids.map(album),
        links: number === 1 ? { next: `${BASE}/albums?page%5Bnumber%5D=2` } : {},
      }
    } else if (url.pathname === '/albums/1/tracks') {
      body = { data: [{ type: 'tracks', id: 't1', attributes: { title: 'T' } }] }
    } else {
      body = { data: album(url.pathname.split('/').at(-1) ?? '') }
    }
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }
  const client = createClient(descriptor, { baseUrl: BASE, transport })
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  installNormalization(queryClient, descriptor)
  return {
    client,
    queryClient,
    rename: (id: string, title: string) => {
      titles.set(id, title)
    },
  }
}

type Pages = InfiniteData<readonly { id: string; title: string }[]>

/** Read the page after the last one an infinite query holds, as `fetchNextPage` does. */
async function nextPage(queryClient: QueryClient, options: object) {
  const observer = new InfiniteQueryObserver(queryClient, options as never)
  await observer.fetchNextPage()
  observer.destroy()
}

/** An infinite album list with both its pages read. */
async function twoPages() {
  const context = setup()
  const options = infiniteListQueryOptions(context.client, 'albums')
  await context.queryClient.fetchInfiniteQuery(options)
  await nextPage(context.queryClient, options)
  const read = () => context.queryClient.getQueryData(options.queryKey) as unknown as Pages
  expect(read().pages).toHaveLength(2)
  return { ...context, options, read }
}

const titlesOf = (data: Pages) => data.pages.map((page) => page.map((album) => album.title))

describe('normalisation of infinite queries', () => {
  it("patches a resource on any page, republishing only that page's root", async () => {
    const { client, queryClient, rename, read } = await twoPages()
    const before = read()

    rename('3', 'Three (Remastered)')
    await queryClient.fetchQuery(getQueryOptions(client, 'albums', '3'))

    const after = read()
    expect(titlesOf(after)).toEqual([
      ['One', 'Two'],
      ['Three (Remastered)', 'Four'],
    ])
    expect(after).not.toBe(before)
    expect(after.pageParams).toBe(before.pageParams)
    expect(after.pages[0]).toBe(before.pages[0])
    expect(after.pages[1]).not.toBe(before.pages[1])
    // The republished page still carries its accessors, and the query still reads as materialised.
    expect(isMaterialised(after.pages[1])).toBe(false)
    expect((after.pages[1] as unknown as { $page: { kind: string } }).$page.kind).toBe('page')
    expect(isMaterialisedData(after)).toBe(true)
  })

  it('notifies an infinite observer of the patch', async () => {
    const { client, queryClient, rename, options } = await twoPages()
    const observer = new InfiniteQueryObserver(queryClient, {
      ...options,
      notifyOnChangeProps: ['data'],
    })
    const seen: string[] = []
    const unsubscribe = observer.subscribe((result) => {
      seen.push((result.data as Pages | undefined)?.pages[0]?.[0]?.title ?? '')
    })

    rename('1', 'One (Live)')
    await queryClient.fetchQuery(getQueryOptions(client, 'albums', '1'))

    expect(seen.at(-1)).toBe('One (Live)')
    unsubscribe()
  })

  it('patches other cached reads from a page it fetches', async () => {
    const { client, queryClient, rename } = setup()
    const options = infiniteListQueryOptions(client, 'albums')
    const get = getQueryOptions(client, 'albums', '3')
    await queryClient.fetchQuery(get)
    await queryClient.fetchInfiniteQuery(options)

    rename('3', 'Three (Deluxe)')
    await nextPage(queryClient, options)

    expect(queryClient.getQueryData(get.queryKey)?.title).toBe('Three (Deluxe)')
  })

  it("doesn't let an earlier page's older copy overwrite a fresher one when the next page arrives", async () => {
    const { client, queryClient, rename } = setup()
    const options = infiniteListQueryOptions(client, 'albums')
    await queryClient.fetchInfiniteQuery(options)

    rename('1', 'One (Fresh)')
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(get)
    await nextPage(queryClient, options)
    expect((queryClient.getQueryData(options.queryKey) as unknown as Pages).pages).toHaveLength(2)

    // The first page's own response still says "One", but the read of album 1 since is newer.
    expect(queryClient.getQueryData(get.queryKey)?.title).toBe('One (Fresh)')
    const data = queryClient.getQueryData(options.queryKey) as unknown as Pages
    expect(data.pages[0]?.[0]?.title).toBe('One (Fresh)')
  })

  it('applies an optimistic attribute patch to infinite pages and rolls it back', async () => {
    const { queryClient, read } = await twoPages()
    const before = read()

    const snapshot = applyOptimisticPatch(
      queryClient,
      'albums',
      '4',
      { title: 'Four?' },
      descriptor,
    )
    const patched = read()
    expect(titlesOf(patched)).toEqual([
      ['One', 'Two'],
      ['Three', 'Four?'],
    ])
    expect(patched.pages[0]).toBe(before.pages[0])
    expect(patched.pages[1]).not.toBe(before.pages[1])

    snapshot.restore()
    const restored = read()
    expect(titlesOf(restored)).toEqual([
      ['One', 'Two'],
      ['Three', 'Four'],
    ])
    expect(restored).not.toBe(patched)
    expect(restored.pages[0]).toBe(before.pages[0])
    expect(isMaterialisedData(restored)).toBe(true)
  })

  it('reaches infinite pages on an optimistic membership edit, and leaves them alone on a to-one one', async () => {
    const { client, queryClient } = setup()
    const related = infiniteRelatedQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchInfiniteQuery(related)
    const before = queryClient.getQueryData(related.queryKey)
    const ids = () =>
      (
        queryClient.getQueryData(related.queryKey) as unknown as InfiniteData<{ id: string }[]>
      ).pages.map((page) => page.map((track) => track.id))

    // The complete, unfiltered related read takes the added track on its last page.
    const membership = openDraft(queryClient, descriptor)
    membership.attach('albums', '1', 'tracks', [{ type: 'tracks', id: 't2', title: 'T2' }])
    expect(ids()).toEqual([['t1', 't2']])
    membership.rollback()
    expect(ids()).toEqual([['t1']])

    // `tracks` is a to-many, so linking it as a to-one changes nothing.
    const toOne = openDraft(queryClient, descriptor)
    toOne.link('albums', '1', 'tracks' as never, { type: 'tracks', id: 't2' })
    expect(ids()).toEqual([['t1']])
    toOne.rollback()
    expect(ids()).toEqual([['t1']])
    expect(isMaterialisedData(queryClient.getQueryData(related.queryKey))).toBe(true)
    expect(before).toBeDefined()
  })
})
