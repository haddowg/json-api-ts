import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import {
  type InfiniteData,
  InfiniteQueryObserver,
  MutationObserver,
  QueryClient,
} from '@tanstack/query-core'
import { describe, expect, it, vi } from 'vitest'
import { nextStamp, stampResult } from './freshness'
import { installNormalization } from './install'
import { atomicMutationOptions, updateMutationOptions } from './mutate'
import { JsonApiMutationCache } from './mutation-cache'
import { normalize } from './normalize'
import { getQueryOptions, infiniteListQueryOptions, listQueryOptions } from './read'
import { withScope } from './scope'

const BASE = 'https://music.example'

const descriptor = {
  albums: {
    attributes: { title: 'string', year: 'number' },
    relations: {},
    paths: {
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      update: '/albums/{id}',
    },
    paginator: 'page',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

type Album = { id: string; title: string; year?: number }

const album = (id: string, title: string, year?: number) => ({
  type: 'albums',
  id,
  attributes: year === undefined ? { title } : { title, year },
})

/** A request the test answers when it chooses, so it controls the order responses arrive in. */
interface Pending {
  req: TransportRequest
  reply(body: unknown, status?: number): void
}

/**
 * A client whose transport holds every request until the test replies to it, and a QueryClient as
 * an app builds one. Reads stay fresh, so nothing refetches behind the test's back.
 */
function setup(scope?: string) {
  const pending: Pending[] = []
  const transport = (req: TransportRequest) =>
    new Promise<TransportResponse>((resolve) => {
      pending.push({
        req,
        reply: (body, status = 200) => resolve({ status, headers: {}, body: JSON.stringify(body) }),
      })
    })
  const client = createClient(descriptor, {
    baseUrl: BASE,
    transport,
    atomic: { path: '/operations' },
  })
  const queryClient = new QueryClient({
    mutationCache: new JsonApiMutationCache(),
    defaultOptions: { queries: { staleTime: Infinity } },
  })
  installNormalization(queryClient, descriptor, scope === undefined ? {} : { scope })
  /** The `n`th request (from 0), once the client has sent it. */
  const request = async (n: number): Promise<Pending> => {
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(n))
    return pending[n] as Pending
  }
  return { client, queryClient, request }
}

/** Let the settled responses' cache updates run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('newer data wins when responses race', () => {
  it('keeps the later read’s values everywhere when the earlier read resolves last', async () => {
    const { client, queryClient, request } = setup()
    const list = listQueryOptions(client, 'albums')
    const one = getQueryOptions(client, 'albums', '1')

    // A (the list) starts first, B (the album) second. B answers first, A last, with older data.
    const a = queryClient.fetchQuery(list)
    const b = queryClient.fetchQuery(one)
    ;(await request(1)).reply({ data: album('1', 'New', 2001) })
    await b
    ;(await request(0)).reply({ data: [album('1', 'Old', 1999), album('2', 'Other')] })
    await a

    const listed = queryClient.getQueryData(list.queryKey) as unknown as Album[]
    const single = queryClient.getQueryData(one.queryKey) as unknown as Album
    expect(single).toMatchObject({ title: 'New', year: 2001 })
    // The list's own copy takes B's values too, and keeps what B didn't carry.
    expect(listed[0]).toMatchObject({ title: 'New', year: 2001 })
    expect(listed[1]).toMatchObject({ title: 'Other' })
  })

  it('lets the later read win when it also resolves last', async () => {
    const { client, queryClient, request } = setup()
    const list = listQueryOptions(client, 'albums')
    const one = getQueryOptions(client, 'albums', '1')

    const a = queryClient.fetchQuery(list)
    const b = queryClient.fetchQuery(one)
    ;(await request(0)).reply({ data: [album('1', 'Old')] })
    await a
    ;(await request(1)).reply({ data: album('1', 'New') })
    await b

    expect((queryClient.getQueryData(list.queryKey) as unknown as Album[])[0]?.title).toBe('New')
  })

  it('updates the attributes a newer sparse read did not carry', async () => {
    const { client, queryClient, request } = setup()
    const list = listQueryOptions(client, 'albums')
    const sparse = getQueryOptions(client, 'albums', '1', { fields: { albums: ['title'] } })
    const full = getQueryOptions(client, 'albums', '1')

    // A cached full copy, then an older full read and a newer sparse one racing.
    const seeded = queryClient.fetchQuery(full)
    ;(await request(0)).reply({ data: album('1', 'First', 1990) })
    await seeded
    const a = queryClient.fetchQuery(list)
    const b = queryClient.fetchQuery(sparse)
    ;(await request(2)).reply({ data: { type: 'albums', id: '1', attributes: { title: 'New' } } })
    await b
    ;(await request(1)).reply({ data: [album('1', 'Old', 2000)] })
    await a

    // The title comes from the newer sparse read; the year, which it didn't carry, from the
    // older full one, which is still newer than the first read.
    expect(queryClient.getQueryData(full.queryKey)).toMatchObject({ title: 'New', year: 2000 })
    expect((queryClient.getQueryData(list.queryKey) as unknown as Album[])[0]).toMatchObject({
      title: 'New',
      year: 2000,
    })
  })

  it('does not let a write’s result overwrite a read started after the write', async () => {
    const { client, queryClient, request } = setup()
    const one = getQueryOptions(client, 'albums', '1')
    const seeded = queryClient.fetchQuery(one)
    ;(await request(0)).reply({ data: album('1', 'Original') })
    await seeded

    // The write starts, then a refetch; the refetch answers first, the write last.
    const update = updateMutationOptions(queryClient, client, descriptor, 'albums', '1')
    const written = queryClient
      .getMutationCache()
      .build(queryClient, update as never)
      .execute({ title: 'Written' })
    await request(1)
    const refetch = queryClient.refetchQueries({ queryKey: one.queryKey })
    ;(await request(2)).reply({ data: album('1', 'Read after') })
    await refetch
    ;(await request(1)).reply({ data: album('1', 'Written') })
    await written

    expect(queryClient.getQueryData(one.queryKey)).toMatchObject({ title: 'Read after' })
  })

  it('lets a write’s result overwrite reads started before it', async () => {
    const { client, queryClient, request } = setup()
    const one = getQueryOptions(client, 'albums', '1')
    const seeded = queryClient.fetchQuery(one)
    ;(await request(0)).reply({ data: album('1', 'Original') })
    await seeded

    const update = updateMutationOptions(queryClient, client, descriptor, 'albums', '1')
    const written = queryClient
      .getMutationCache()
      .build(queryClient, update as never)
      .execute({ title: 'Written' })
    ;(await request(1)).reply({ data: album('1', 'Written') })
    await written

    expect(queryClient.getQueryData(one.queryKey)).toMatchObject({ title: 'Written' })
  })

  it('applies data as old as what the cache holds', async () => {
    const { client, queryClient, request } = setup()
    const one = getQueryOptions(client, 'albums', '1')
    const seeded = queryClient.fetchQuery(one)
    ;(await request(0)).reply({ data: album('1', 'First') })
    await seeded

    // Two results stamped alike: the one normalised later applies.
    const stamp = nextStamp()
    const read = async (title: string) => {
      const pending = client.albums.get('1')
      const reply = await request(title === 'Second' ? 1 : 2)
      reply.reply({ data: album('1', title) })
      const result = await pending
      stampResult(result, stamp)
      return result
    }
    normalize(queryClient, await read('Second'), descriptor)
    expect(queryClient.getQueryData(one.queryKey)).toMatchObject({ title: 'Second' })
    normalize(queryClient, await read('Third'), descriptor)
    expect(queryClient.getQueryData(one.queryKey)).toMatchObject({ title: 'Third' })
  })

  it('treats hydrated data as older than any read made here', async () => {
    const { client, queryClient, request } = setup()
    const one = getQueryOptions(client, 'albums', '1')
    const list = listQueryOptions(client, 'albums')

    // A materialised value no read here stamped, fetched before the read below started.
    const restoring = client.albums.get('1')
    ;(await request(0)).reply({ data: album('1', 'Hydrated') })
    const restored = await restoring

    // The read starts, then the value arrives in the cache as a hydrated query would.
    const reading = queryClient.fetchQuery(list)
    await request(1)
    queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: one.queryKey, initialData: restored })
    expect(queryClient.getQueryData(one.queryKey)).toMatchObject({ title: 'Hydrated' })

    ;(await request(1)).reply({ data: [album('1', 'Fresh')] })
    await reading
    expect(queryClient.getQueryData(one.queryKey)).toMatchObject({ title: 'Fresh' })

    // Normalising the hydrated value again doesn't bring its old values back.
    normalize(queryClient, restored, descriptor)
    expect(queryClient.getQueryData(one.queryKey)).toMatchObject({ title: 'Fresh' })
    expect((queryClient.getQueryData(list.queryKey) as unknown as Album[])[0]?.title).toBe('Fresh')
  })

  it('keeps an optimistic rollback precise when a newer read lands during the write', async () => {
    const { client, queryClient, request } = setup()
    const one = getQueryOptions(client, 'albums', '1')
    const list = listQueryOptions(client, 'albums')
    const seeded = queryClient.fetchQuery(one)
    ;(await request(0)).reply({ data: album('1', 'Original', 2000) })
    await seeded

    const update = updateMutationOptions(queryClient, client, descriptor, 'albums', '1', {
      optimistic: true,
    })
    const written = queryClient
      .getMutationCache()
      .build(queryClient, update as never)
      .execute({ title: 'Predicted', year: 2024 })
    expect(queryClient.getQueryData(one.queryKey)).toMatchObject({ title: 'Predicted' })
    await request(1)

    // A read started after the write lands while it is pending, then the write fails.
    const reading = queryClient.fetchQuery(list)
    ;(await request(2)).reply({ data: [album('1', 'Server', 2023)] })
    await reading
    ;(await request(1)).reply({ errors: [{ status: '422', code: 'NO' }] }, 422)
    await expect(written).rejects.toBeDefined()

    // The read replaced the prediction, so the rollback leaves the read's values in place.
    expect(queryClient.getQueryData(one.queryKey)).toMatchObject({ title: 'Server', year: 2023 })
  })
})

describe('every client result competes by when its request started', () => {
  it('lets a factory read win over an older request in a query the app built', async () => {
    const { client, queryClient, request } = setup()
    const own = { queryKey: ['mine', 'album', '1'], queryFn: () => client.albums.get('1') }
    const one = getQueryOptions(client, 'albums', '1')

    // The app's query starts first, the factory read second; the app's answers last, older.
    const a = queryClient.fetchQuery(own)
    const b = queryClient.fetchQuery(one)
    ;(await request(1)).reply({ data: album('1', 'New') })
    await b
    ;(await request(0)).reply({ data: album('1', 'Old') })
    await a

    expect(queryClient.getQueryData(one.queryKey)).toMatchObject({ title: 'New' })
    expect(queryClient.getQueryData(own.queryKey)).toMatchObject({ title: 'New' })
  })

  it('lets a newer request in a query the app built win over an older factory read', async () => {
    const { client, queryClient, request } = setup()
    const own = { queryKey: ['mine', 'album', '1'], queryFn: () => client.albums.get('1') }
    const list = listQueryOptions(client, 'albums')

    const a = queryClient.fetchQuery(list)
    const b = queryClient.fetchQuery(own)
    ;(await request(1)).reply({ data: album('1', 'New') })
    await b
    ;(await request(0)).reply({ data: [album('1', 'Old')] })
    await a

    expect((queryClient.getQueryData(list.queryKey) as unknown as Album[])[0]?.title).toBe('New')
  })

  it('judges a $next() page by when its request started', async () => {
    const { client, queryClient, request } = setup()
    const one = getQueryOptions(client, 'albums', '1')
    const reading = client.albums.list()
    ;(await request(0)).reply({
      data: [album('2', 'Two')],
      links: { next: `${BASE}/albums?page%5Bnumber%5D=2` },
    })
    const first = await reading
    const own = { queryKey: ['mine', 'page', 2], queryFn: () => first.$next() }

    // The page's request starts before the factory read, and answers after it.
    const a = queryClient.fetchQuery(own)
    const b = queryClient.fetchQuery(one)
    ;(await request(2)).reply({ data: album('1', 'New') })
    await b
    ;(await request(1)).reply({ data: [album('1', 'Old')] })
    await a

    expect(queryClient.getQueryData(one.queryKey)).toMatchObject({ title: 'New' })
    expect((queryClient.getQueryData(own.queryKey) as unknown as Album[])[0]?.title).toBe('New')
  })

  it('judges an atomic batch’s results by when the batch started', async () => {
    const { client, queryClient, request } = setup()
    const one = getQueryOptions(client, 'albums', '1')
    const seeded = queryClient.fetchQuery(one)
    ;(await request(0)).reply({ data: album('1', 'Original') })
    await seeded

    // The batch starts, then a refetch; the refetch answers first, the batch last.
    const batch = new MutationObserver(
      queryClient,
      atomicMutationOptions(queryClient, client, descriptor) as never,
    )
    const written = batch.mutate(((tx: { update(input: unknown): unknown }) => {
      tx.update({ type: 'albums', id: '1', title: 'Batched' })
    }) as never)
    await request(1)
    const refetch = queryClient.refetchQueries({ queryKey: one.queryKey })
    ;(await request(2)).reply({ data: album('1', 'Read after') })
    await refetch
    ;(await request(1)).reply({ 'atomic:results': [{ data: album('1', 'Batched') }] })
    await written

    expect(queryClient.getQueryData(one.queryKey)).toMatchObject({ title: 'Read after' })
  })

  it('lets an atomic batch’s results overwrite reads started before it', async () => {
    const { client, queryClient, request } = setup()
    const one = getQueryOptions(client, 'albums', '1')
    const seeded = queryClient.fetchQuery(one)
    ;(await request(0)).reply({ data: album('1', 'Original') })
    await seeded

    const batch = new MutationObserver(
      queryClient,
      atomicMutationOptions(queryClient, client, descriptor) as never,
    )
    const written = batch.mutate(((tx: { update(input: unknown): unknown }) => {
      tx.update({ type: 'albums', id: '1', title: 'Batched' })
    }) as never)
    ;(await request(1)).reply({ 'atomic:results': [{ data: album('1', 'Batched') }] })
    await written

    expect(queryClient.getQueryData(one.queryKey)).toMatchObject({ title: 'Batched' })
  })

  it('counts data the app writes with setQueryData as current when written', async () => {
    const { client, queryClient, request } = setup()
    const one = getQueryOptions(client, 'albums', '1')
    const list = listQueryOptions(client, 'albums')

    // A result whose request started before the list read's, written by the app after it landed.
    const fetching = client.albums.get('1')
    const reading = queryClient.fetchQuery(list)
    ;(await request(1)).reply({ data: [album('1', 'Listed')] })
    await reading
    ;(await request(0)).reply({ data: album('1', 'Written') })
    queryClient.setQueryData(one.queryKey, (await fetching) as never)

    expect(queryClient.getQueryData(one.queryKey)).toMatchObject({ title: 'Written' })
    expect((queryClient.getQueryData(list.queryKey) as unknown as Album[])[0]?.title).toBe(
      'Written',
    )
  })
  it('patches a copy the app wrote with setQueryData from a later atomic batch', async () => {
    const { client, queryClient, request } = setup()
    const list = listQueryOptions(client, 'albums')
    const reading = queryClient.fetchQuery(list)
    ;(await request(0)).reply({ data: [album('1', 'Listed')] })
    await reading

    // The app writes a list holding a resource no cached query held before.
    const fetching = client.albums.list()
    ;(await request(1)).reply({ data: [album('1', 'Listed'), album('2', 'Two')] })
    queryClient.setQueryData(list.queryKey, (await fetching) as never)

    const batch = new MutationObserver(
      queryClient,
      atomicMutationOptions(queryClient, client, descriptor) as never,
    )
    const written = batch.mutate(((tx: { update(input: unknown): unknown }) => {
      tx.update({ type: 'albums', id: '2', title: 'Batched' })
    }) as never)
    ;(await request(2)).reply({ 'atomic:results': [{ data: album('2', 'Batched') }] })
    await written

    const rows = queryClient.getQueryData(list.queryKey) as unknown as Album[]
    expect(rows.map((row) => row.title)).toEqual(['Listed', 'Batched'])
  })
})

describe('newer data wins across infinite pages', () => {
  type Pages = InfiniteData<readonly Album[]>

  it('keeps a newer read’s values on a page that resolves later', async () => {
    const { client, queryClient, request } = setup()
    const pages = infiniteListQueryOptions(client, 'albums')
    const one = getQueryOptions(client, 'albums', '1')

    const a = queryClient.fetchInfiniteQuery(pages)
    const b = queryClient.fetchQuery(one)
    ;(await request(1)).reply({ data: album('1', 'New') })
    await b
    ;(await request(0)).reply({
      data: [album('1', 'Old'), album('2', 'Two')],
      links: { next: `${BASE}/albums?page%5Bnumber%5D=2` },
    })
    await a

    const read = () => queryClient.getQueryData(pages.queryKey) as unknown as Pages
    expect(read().pages[0]?.[0]?.title).toBe('New')

    // A newer read of the album, then the next page: indexing the first page again (its `$raw`
    // still says `Old`) doesn't bring the old title back anywhere.
    const c = queryClient.refetchQueries({ queryKey: one.queryKey })
    ;(await request(2)).reply({ data: album('1', 'Newer') })
    await c
    const observer = new InfiniteQueryObserver(queryClient, pages as never)
    const next = observer.fetchNextPage()
    ;(await request(3)).reply({ data: [album('3', 'Three')] })
    await next
    observer.destroy()

    expect(read().pages).toHaveLength(2)
    expect(read().pages[0]?.[0]?.title).toBe('Newer')
    expect(queryClient.getQueryData(one.queryKey)).toMatchObject({ title: 'Newer' })
  })

  it('lets a newer page win over an older read', async () => {
    const { client, queryClient, request } = setup()
    const pages = infiniteListQueryOptions(client, 'albums')
    const one = getQueryOptions(client, 'albums', '1')

    const b = queryClient.fetchQuery(one)
    const a = queryClient.fetchInfiniteQuery(pages)
    ;(await request(1)).reply({ data: [album('1', 'Page')] })
    await a
    ;(await request(0)).reply({ data: album('1', 'Older read') })
    await b

    expect(queryClient.getQueryData(one.queryKey)).toMatchObject({ title: 'Page' })
    const read = queryClient.getQueryData(pages.queryKey) as unknown as Pages
    expect(read.pages[0]?.[0]?.title).toBe('Page')
  })
})

describe('newer data wins within a scope', () => {
  it('compares stamps only among the queries of one scope', async () => {
    const { client, queryClient, request } = setup('a')
    installNormalization(queryClient, descriptor, { scope: 'b' })
    const inA = withScope('a', getQueryOptions(client, 'albums', '1'))
    const listInA = withScope('a', listQueryOptions(client, 'albums'))
    const inB = withScope('b', getQueryOptions(client, 'albums', '1'))

    // Scope a's list starts first, b's read second and answers first: b's newer data doesn't
    // block a's list from patching a's own copy.
    const seeded = queryClient.fetchQuery(inA)
    ;(await request(0)).reply({ data: album('1', 'A original') })
    await seeded
    const a = queryClient.fetchQuery(listInA)
    const b = queryClient.fetchQuery(inB)
    ;(await request(2)).reply({ data: album('1', 'B') })
    await b
    ;(await request(1)).reply({ data: [album('1', 'A list')] })
    await a
    await settle()

    expect(queryClient.getQueryData(inA.queryKey)).toMatchObject({ title: 'A list' })
    expect(queryClient.getQueryData(inB.queryKey)).toMatchObject({ title: 'B' })
  })
})
