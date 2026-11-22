import { isAccepted } from '@haddowg/json-api-client'
import { describe, expect, it, vi } from 'vitest'
import { descriptor, harness, ids, type Row, tick } from './lifecycle-harness.test-support'
import { createMutationApi } from './mutate'
import { getQueryOptions, listQueryOptions, relationshipQueryOptions } from './read'

describe('cancel before applying (B3)', () => {
  it('cancels a slow in-flight refetch of a candidate, whose answer then never overwrites the prediction', async () => {
    const h = harness()
    const { client, queryClient } = h
    const writes = createMutationApi(queryClient, client, descriptor)
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(get)

    // A refetch is in flight, answering with the title as it stood before the write.
    const read = h.hold('GET /albums/1')
    void queryClient.refetchQueries({ queryKey: get.queryKey })
    await read.started
    const write = h.hold('PATCH /albums/1')
    const pending = h.run(writes.albums.id('1').update({ optimistic: true }), {
      title: 'Predicted',
    })

    // The change waits for the cancellation, then shows.
    expect((h.data(get) as Row)['title']).toBe('OK Computer')
    await tick()
    expect((h.data(get) as Row)['title']).toBe('Predicted')
    expect(queryClient.getQueryState(get.queryKey)?.fetchStatus).toBe('idle')

    // The cancelled read's answer arrives: it neither lands nor reverts over the prediction.
    read.release()
    await tick()
    expect((h.data(get) as Row)['title']).toBe('Predicted')

    write.release()
    await pending
    expect((h.data(get) as Row)['title']).toBe('Predicted')
    // The cancelled read is invalidated at settle, so it refetches when next observed.
    expect(queryClient.getQueryState(get.queryKey)?.isInvalidated).toBe(true)
  })

  it('applies at once when no candidate is fetching', async () => {
    const h = harness()
    const { client, queryClient } = h
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(get)
    const writes = createMutationApi(queryClient, client, descriptor)
    const pending = h.run(writes.albums.id('1').update({ optimistic: true }), { title: 'Now' })
    expect((h.data(get) as Row)['title']).toBe('Now')
    await pending
  })
})

describe('overlapping writes (B3: the last to settle invalidates for all)', () => {
  it('an earlier write settling refetches nothing; the last refetches every candidate, and the UI never flickers back', async () => {
    const h = harness()
    const { client, queryClient } = h
    const writes = createMutationApi(queryClient, client, descriptor)
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(linkage)
    const stop = h.observe(linkage)
    const reads = () => h.requests.filter((r) => r.startsWith('GET /albums/1/relationships')).length
    const before = reads()

    const first = h.hold('POST /albums/1/relationships/tracks')
    const second = h.hold('DELETE /albums/1/relationships/tracks')
    const adding = h.run(writes.albums.id('1').rel('tracks').add({ optimistic: true }), [
      { type: 'tracks', id: 't3' },
    ])
    const removing = h.run(writes.albums.id('1').rel('tracks').remove({ optimistic: true }), [
      { type: 'tracks', id: 't1' },
    ])
    await tick()
    expect(ids(h.data(linkage))).toEqual(['t2', 't3'])

    // The first write settles while the second is pending: no refetch replaces the second's change.
    first.release()
    await adding
    expect(reads()).toBe(before)
    expect(queryClient.getQueryState(linkage.queryKey)?.isInvalidated).toBe(false)
    expect(ids(h.data(linkage))).toEqual(['t2', 't3'])

    // The last one settles and refetches, for both.
    second.release()
    await removing
    expect(reads()).toBe(before + 1)
    expect(ids(h.data(linkage))).toEqual(['t2', 't3'])
    stop()
  })

  it('writes whose keys do not overlap each invalidate their own', async () => {
    const h = harness()
    const { client, queryClient } = h
    const writes = createMutationApi(queryClient, client, descriptor)
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    const artists = listQueryOptions(client, 'artists')
    await queryClient.fetchQuery(linkage)
    await queryClient.fetchQuery(artists)

    const held = h.hold('POST /albums/1/relationships/tracks')
    const adding = h.run(writes.albums.id('1').rel('tracks').add({ optimistic: true }), [
      { type: 'tracks', id: 't3' },
    ])
    await h.run(writes.artists.create(), { name: 'Muse' })
    expect(queryClient.getQueryState(artists.queryKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(linkage.queryKey)?.isInvalidated).toBe(false)
    held.release()
    await adding
    expect(queryClient.getQueryState(linkage.queryKey)?.isInvalidated).toBe(true)
  })

  it('a failed write hands its keys on too', async () => {
    const h = harness()
    const { client, queryClient } = h
    const writes = createMutationApi(queryClient, client, descriptor)
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(linkage)
    h.fail('POST /albums/1/relationships/tracks')
    const held = h.hold('DELETE /albums/1/relationships/tracks')
    const removing = h.run(writes.albums.id('1').rel('tracks').remove({ optimistic: true }), [
      { type: 'tracks', id: 't1' },
    ])
    await expect(
      h.run(writes.albums.id('1').rel('tracks').add({ optimistic: true }), [
        { type: 'tracks', id: 't3' },
      ]),
    ).rejects.toBeDefined()
    // Rolled back its own add, kept the pending remove, and refetched nothing yet.
    expect(ids(h.data(linkage))).toEqual(['t2'])
    expect(queryClient.getQueryState(linkage.queryKey)?.isInvalidated).toBe(false)
    held.release()
    await removing
    expect(queryClient.getQueryState(linkage.queryKey)?.isInvalidated).toBe(true)
  })
})

describe('a deleted resource', () => {
  it('evicts it optimistically, and removes its own queries on success instead of refetching into a 404', async () => {
    const h = harness()
    const { client, queryClient } = h
    const writes = createMutationApi(queryClient, client, descriptor)
    const list = listQueryOptions(client, 'albums')
    const get = getQueryOptions(client, 'albums', '1')
    const related = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(list)
    await queryClient.fetchQuery(get)
    await queryClient.fetchQuery(related)
    const stop = h.observe(get)

    const held = h.hold('DELETE /albums/1')
    const pending = h.run(writes.albums.id('1').delete({ optimistic: true }), undefined)
    await tick()
    expect(ids(h.data(list))).toEqual([])
    held.release()
    await pending

    expect(queryClient.getQueryState(get.queryKey)).toBeUndefined()
    expect(queryClient.getQueryState(related.queryKey)).toBeUndefined()
    expect(queryClient.getQueryState(list.queryKey)?.isInvalidated).toBe(true)
    expect(h.requests.filter((r) => r === 'GET /albums/1')).toHaveLength(1)
    stop()
  })

  it('restores it when the delete fails, and keeps its queries', async () => {
    const h = harness()
    const { client, queryClient } = h
    const writes = createMutationApi(queryClient, client, descriptor)
    const list = listQueryOptions(client, 'albums')
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(list)
    await queryClient.fetchQuery(get)
    h.fail('DELETE /albums/1')
    await expect(
      h.run(writes.albums.id('1').delete({ optimistic: true }), undefined),
    ).rejects.toBeDefined()
    expect(ids(h.data(list))).toEqual(['1'])
    expect(h.data(get)).toBeDefined()
  })
})

describe('202 Accepted', () => {
  it('without wait, keeps the optimistic change, refetches nothing of its own, and clears the markers at settle', async () => {
    const h = harness()
    const { client, queryClient } = h
    const writes = createMutationApi(queryClient, client, descriptor)
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(get)
    h.accept()

    const result = await h.run(writes.albums.id('1').update({ optimistic: true }), {
      title: 'Queued',
      artist: { type: 'artists', id: 'a2' },
    })
    expect(isAccepted(result)).toBe(true)
    const album = h.data(get) as Row
    expect(album['title']).toBe('Queued')
    expect(album.$optimistic).toBeUndefined()
    // The update's relation would have refetched the album; accepted, it doesn't.
    expect(queryClient.getQueryState(get.queryKey)?.isInvalidated).toBe(false)
  })

  it('with wait, reconciles normally once the job resolves', async () => {
    const h = harness()
    const { client, queryClient } = h
    const writes = createMutationApi(queryClient, client, descriptor)
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(get)
    h.accept()

    const result = await h.run(writes.albums.id('1').update({ optimistic: true, wait: true }), {
      title: 'Done',
    })
    expect(isAccepted(result)).toBe(false)
    expect((result as Row)['title']).toBe('Done')
    expect((h.data(get) as Row)['title']).toBe('Done')
    expect((h.data(get) as Row).$optimistic).toBeUndefined()
  })
})

describe('optimism by default', () => {
  it('JsonApiMutationCache({ optimistic: true }) makes every write optimistic unless it says false', async () => {
    const h = harness({ optimistic: true })
    const { client, queryClient } = h
    const writes = createMutationApi(queryClient, client, descriptor)
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(get)

    const held = h.hold('PATCH /albums/1')
    const pending = h.run(writes.albums.id('1').update(), { title: 'By default' })
    expect((h.data(get) as Row)['title']).toBe('By default')
    held.release()
    await pending

    const off = h.hold('PATCH /albums/1')
    const plain = h.run(writes.albums.id('1').update({ optimistic: false }), { title: 'Later' })
    expect((h.data(get) as Row)['title']).toBe('By default')
    off.release()
    await plain
    expect((h.data(get) as Row)['title']).toBe('Later')
  })

  it('autoPlace: false places additions only through into', async () => {
    const h = harness({ optimistic: { autoPlace: false } })
    const { client, queryClient } = h
    const writes = createMutationApi(queryClient, client, descriptor)
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(linkage)
    const held = h.hold('POST /albums/1/relationships/tracks')
    const pending = h.run(writes.albums.id('1').rel('tracks').add(), [{ type: 'tracks', id: 't3' }])
    await tick()
    expect(ids(h.data(linkage))).toEqual(['t1', 't2'])
    held.release()
    await pending

    const placed = h.hold('POST /albums/1/relationships/tracks')
    const into = h.run(
      writes.albums
        .id('1')
        .rel('tracks')
        .add({ optimistic: { into: () => 'start' } }),
      [{ type: 'tracks', id: 't4' }],
    )
    await tick()
    expect(ids(h.data(linkage))[0]).toBe('t4')
    placed.release()
    await into
  })
})

describe('spread callbacks', () => {
  it('an app onMutate/onError/onSettled spread alongside an optimistic write runs after the upkeep, and the rollback still happens', async () => {
    const h = harness()
    const { client, queryClient } = h
    const writes = createMutationApi(queryClient, client, descriptor)
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(get)
    h.fail('PATCH /albums/1')
    const seen: string[] = []
    const onMutate = vi.fn(() => {
      seen.push(`mutate:${String((h.data(get) as Row)['title'])}`)
    })
    const onError = vi.fn(() => {
      seen.push(`error:${String((h.data(get) as Row)['title'])}`)
    })
    const onSettled = vi.fn(() => {
      seen.push('settled')
    })
    await expect(
      h.run(
        { ...writes.albums.id('1').update({ optimistic: true }), onMutate, onError, onSettled },
        { title: 'Nope' },
      ),
    ).rejects.toBeDefined()
    expect(seen).toEqual(['mutate:Nope', 'error:OK Computer', 'settled'])
  })
})
