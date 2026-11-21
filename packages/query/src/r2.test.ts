import { describe, expect, it } from 'vitest'
import { descriptor, harness, ids, type Row, tick } from './lifecycle-harness.test-support'
import { createMutationApi } from './mutate'
import { getQueryOptions, listQueryOptions, relationshipQueryOptions } from './read'

const bound = (h: ReturnType<typeof harness>) =>
  createMutationApi(h.queryClient, h.client, descriptor)

/** Refetch a read now, as a refocus or a newly mounted component would. */
const refetch = (h: ReturnType<typeof harness>, options: { queryKey: readonly unknown[] }) =>
  h.queryClient.fetchQuery({ ...options, staleTime: 0 } as never)

describe('a read landing while an optimistic write is pending (A7 R2)', () => {
  it('keeps showing the prediction, and a failed write rolls back to the newest server value', async () => {
    const h = harness()
    const get = getQueryOptions(h.client, 'albums', '1')
    const list = listQueryOptions(h.client, 'albums')
    await h.queryClient.fetchQuery(get)
    await h.queryClient.fetchQuery(list)
    h.fail('PATCH /albums/1')
    const write = h.hold('PATCH /albums/1')
    const pending = h.run(bound(h).albums.id('1').update({ optimistic: true }), {
      title: 'Predicted',
    })

    // Someone else renames the album; both reads land while the write is pending.
    h.albums['1']!.title = 'Renamed elsewhere'
    await refetch(h, get)
    await refetch(h, list)
    expect((h.data(get) as Row)['title']).toBe('Predicted')
    expect((h.data(list) as Row[])[0]!['title']).toBe('Predicted')
    expect((h.data(get) as Row).$optimistic).toBe('pending')

    write.release()
    await expect(pending).rejects.toBeDefined()
    expect((h.data(get) as Row)['title']).toBe('Renamed elsewhere')
    expect((h.data(list) as Row[])[0]!['title']).toBe('Renamed elsewhere')
    expect((h.data(get) as Row).$optimistic).toBeUndefined()
  })

  it('a read that matches the prediction is kept by the rollback', async () => {
    const h = harness()
    const get = getQueryOptions(h.client, 'albums', '1')
    await h.queryClient.fetchQuery(get)
    h.fail('PATCH /albums/1')
    const write = h.hold('PATCH /albums/1')
    const pending = h.run(bound(h).albums.id('1').update({ optimistic: true }), { title: 'Same' })
    h.albums['1']!.title = 'Same'
    await refetch(h, get)
    write.release()
    await expect(pending).rejects.toBeDefined()
    expect((h.data(get) as Row)['title']).toBe('Same')
  })

  it("on success the write's response wins over a read that landed meanwhile", async () => {
    const h = harness()
    const get = getQueryOptions(h.client, 'albums', '1')
    await h.queryClient.fetchQuery(get)
    const write = h.hold('PATCH /albums/1')
    const pending = h.run(bound(h).albums.id('1').update({ optimistic: true }), {
      title: 'Mine',
    })
    await tick()
    // A read started after the write, answered before the server applied it.
    h.albums['1']!.title = 'Stale'
    await refetch(h, get)
    expect((h.data(get) as Row)['title']).toBe('Mine')
    write.release()
    await pending
    expect((h.data(get) as Row)['title']).toBe('Mine')
  })

  it('keeps an edited relation slot in a read that replaces the query’s data, and rolls it back there', async () => {
    const h = harness()
    const linkage = relationshipQueryOptions(h.client, 'albums', '1', 'tracks')
    await h.queryClient.fetchQuery(linkage)
    h.fail('POST /albums/1/relationships/tracks')
    const write = h.hold('POST /albums/1/relationships/tracks')
    const pending = h.run(bound(h).albums.id('1').rel('tracks').add({ optimistic: true }), [
      { type: 'tracks', id: 't3' },
    ])
    await tick()
    expect(ids(h.data(linkage))).toEqual(['t1', 't2', 't3'])

    await refetch(h, linkage)
    expect(ids(h.data(linkage))).toEqual(['t1', 't2', 't3'])

    write.release()
    await expect(pending).rejects.toBeDefined()
    expect(ids(h.data(linkage))).toEqual(['t1', 't2'])
  })

  it('a query first read while the write is pending shows the prediction too', async () => {
    const h = harness()
    const get = getQueryOptions(h.client, 'albums', '1')
    await h.queryClient.fetchQuery(get)
    const write = h.hold('PATCH /albums/1')
    const pending = h.run(bound(h).albums.id('1').update({ optimistic: true }), {
      title: 'Predicted',
    })
    const list = listQueryOptions(h.client, 'albums')
    await h.queryClient.fetchQuery(list)
    expect((h.data(list) as Row[])[0]!['title']).toBe('Predicted')
    write.release()
    await pending
  })
})
