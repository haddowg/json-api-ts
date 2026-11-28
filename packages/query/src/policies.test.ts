import {
  createClient,
  type CreateInput,
  type DefaultActionTypes,
  type DefaultWriteAttributes,
  type FieldErrors,
  fieldErrors,
  JsonApiError,
  type UpdateInput,
} from '@haddowg/json-api-client'
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/query-core'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { BASE, descriptor, harness, ids, type Row, tick } from './lifecycle-harness.test-support'
import { resourceKey } from './keys'
import {
  createMutationApi,
  jsonApiMutationOptions,
  type MutationError,
  type WriteMutationError,
} from './mutate'
import {
  createQueryApi,
  getQueryOptions,
  listQueryOptions,
  type ReadError,
  relationshipQueryOptions,
} from './read'
import { mutationKeyFor } from './upkeep'

const bound = (h: ReturnType<typeof harness>) =>
  createMutationApi(h.queryClient, h.client, descriptor)

describe('update', () => {
  it('patches attributes and links the relations of its input, rolled back on error', async () => {
    const h = harness()
    const { client, queryClient } = h
    const get = getQueryOptions(client, 'albums', '1', { include: ['artist'] })
    await queryClient.fetchQuery(get)
    await queryClient.fetchQuery(getQueryOptions(client, 'artists', 'a2'))
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    await queryClient.fetchQuery(linkage)
    h.fail('PATCH /albums/1')

    const pending = h.run(bound(h).albums.id('1').update({ optimistic: true }), {
      title: 'Renamed',
      artist: { type: 'artists', id: 'a2' },
      tracks: [{ type: 'tracks', id: 't2' }],
    })
    const album = h.data(get) as Row & { artist: Row }
    expect(album['title']).toBe('Renamed')
    expect(album.artist['name']).toBe('Blur')
    expect(ids(h.data(linkage))).toEqual(['t2'])

    await expect(pending).rejects.toBeDefined()
    const after = h.data(get) as Row & { artist: Row }
    expect(after['title']).toBe('OK Computer')
    expect(after.artist['name']).toBe('Radiohead')
    expect(ids(h.data(linkage))).toEqual(['t1', 't2'])
  })

  it('takes the id in its variables: one mutation serves every row, keyed [type, verb]', async () => {
    const h = harness()
    const { client, queryClient } = h
    const list = listQueryOptions(client, 'tracks')
    await queryClient.fetchQuery(list)
    const rename = bound(h).tracks.update({ optimistic: true })
    expect(rename.mutationKey).toEqual(mutationKeyFor({ type: 'tracks', verb: 'update' }))

    const held = h.hold('PATCH /tracks/t2')
    const first = h.run(rename, { id: 't1', title: 'One' })
    const second = h.run(rename, { id: 't2', title: 'Two' })
    await tick()
    expect((h.data(list) as Row[]).map((t) => t['title'])).toEqual(['One', 'Two', 'Lucky'])
    // Pending writes are found by key, and told apart by their variables.
    const pending = queryClient
      .getMutationCache()
      .findAll({ mutationKey: rename.mutationKey, status: 'pending' })
      .map((m) => (m.state.variables as { id: string }).id)
    expect(pending).toEqual(['t2'])
    held.release()
    await Promise.all([first, second])
    expect(h.requests).toContain('PATCH /tracks/t1')
    expect(h.tracks['t2']!.title).toBe('Two')
  })
})

describe('delete', () => {
  it('takes the id in its variables', async () => {
    const h = harness()
    const { client, queryClient } = h
    const list = listQueryOptions(client, 'tracks')
    await queryClient.fetchQuery(list)
    const remove = bound(h).tracks.delete({ optimistic: true })
    expect(remove.mutationKey).toEqual(['tracks', 'delete'])
    const held = h.hold('DELETE /tracks/t2')
    const pending = h.run(remove, { id: 't2' })
    await tick()
    expect(ids(h.data(list))).toEqual(['t1', 't3'])
    held.release()
    await pending
    expect(h.requests).toContain('DELETE /tracks/t2')
  })
})

describe('relationship verbs', () => {
  it('reach every cached copy of the parent', async () => {
    const h = harness()
    const { client, queryClient } = h
    const get = getQueryOptions(client, 'albums', '1')
    const included = getQueryOptions(client, 'albums', '1', { include: ['tracks'] })
    await queryClient.fetchQuery(get)
    await queryClient.fetchQuery(included)
    await queryClient.fetchQuery(listQueryOptions(client, 'tracks'))
    const held = h.hold('POST /albums/1/relationships/tracks')
    const pending = h.run(bound(h).albums.id('1').rel('tracks').add({ optimistic: true }), [
      { type: 'tracks', id: 't3' },
    ])
    await tick()
    expect(ids((h.data(get) as { tracks: Row[] }).tracks)).toEqual(['t1', 't2', 't3'])
    const rows = (h.data(included) as { tracks: Row[] }).tracks
    expect(rows[2]!['title']).toBe('Lucky')
    expect(rows[2]!.$optimistic).toBe('pending')
    held.release()
    await pending
  })
})

describe('create', () => {
  it('a forbidden-id type gets a temporary id in its variables, never sent, swapped in place for the server’s', async () => {
    const h = harness()
    const { client, queryClient } = h
    const list = listQueryOptions(client, 'albums')
    await queryClient.fetchQuery(list)
    const held = h.hold('POST /albums')
    const variables: Record<string, unknown> = { title: 'Kid A', year: 2000 }
    const pending = h.run(
      bound(h).albums.create({
        optimistic: { into: (q) => (q.operation === 'fetchMany' ? 'start' : false) },
      }),
      variables,
    )
    await tick()
    const temp = variables['$tempId'] as string
    expect(temp).toMatch(/^\$tmp:/)
    const row = (h.data(list) as Row[])[0]!
    expect(row['id']).toBe(temp)
    expect(row['title']).toBe('Kid A')
    expect(row.$optimistic).toBe('pending')
    // A query keyed by the temporary id, as a detail page opened on the new row would be.
    queryClient.setQueryData(resourceKey('albums', temp), row)

    held.release()
    await pending
    const sent = JSON.parse(String(h.sent('POST /albums'))) as { data: Record<string, unknown> }
    expect(sent.data['id']).toBeUndefined()
    expect(JSON.stringify(sent)).not.toContain('$tempId')
    const swapped = (h.data(list) as Row[])[0]!
    expect(swapped['id']).toBe('srv-1')
    expect(queryClient.getQueryData(resourceKey('albums', temp))).toBeUndefined()
    expect((queryClient.getQueryData(resourceKey('albums', 'srv-1')) as Row)['id']).toBe('srv-1')
  })

  it('a type requiring client ids gets a generated id in its variables, sent with the create (no swap)', async () => {
    const h = harness()
    const { client, queryClient } = h
    const list = listQueryOptions(client, 'labels')
    await queryClient.fetchQuery(list)
    const variables: Record<string, unknown> = { name: 'Parlophone' }
    await h.run(
      bound(h).labels.create({ optimistic: { into: () => 'end' }, clientId: () => 'parlophone' }),
      variables,
    )
    expect(variables['id']).toBe('parlophone')
    expect(variables['$tempId']).toBeUndefined()
    const sent = JSON.parse(String(h.sent('POST /labels'))) as { data: { id?: string } }
    expect(sent.data.id).toBe('parlophone')

    const generated: Record<string, unknown> = { name: 'XL' }
    await h.run(bound(h).labels.create({ optimistic: true }), generated)
    expect(generated['id']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('a type taking optional client ids gets a temporary id, never sent, swapped for the server’s', async () => {
    const h = harness()
    const { client, queryClient } = h
    const list = listQueryOptions(client, 'artists')
    await queryClient.fetchQuery(list)
    const held = h.hold('POST /artists')
    const variables: Record<string, unknown> = { name: 'Muse' }
    const pending = h.run(
      bound(h).artists.create({ optimistic: { into: () => 'end' }, clientId: () => 'muse' }),
      variables,
    )
    await tick()
    expect(variables['id']).toBeUndefined()
    expect(variables['$tempId']).toBe('$tmp:muse')
    expect(ids(h.data(list))).toEqual(['a1', 'a2', '$tmp:muse'])

    held.release()
    await pending
    const sent = JSON.parse(String(h.sent('POST /artists'))) as { data: Record<string, unknown> }
    expect(sent.data['id']).toBeUndefined()
    expect(JSON.stringify(sent)).not.toContain('$tempId')
    expect(ids(h.data(list))).toEqual(['a1', 'a2', 'srv-1'])
    expect(h.artists['srv-1']?.name).toBe('Muse')
  })

  it('an id the caller gives a type taking optional client ids is kept and sent', async () => {
    const h = harness()
    const variables: Record<string, unknown> = { id: 'muse', name: 'Muse' }
    await h.run(bound(h).artists.create({ optimistic: true }), variables)
    expect(variables['$tempId']).toBeUndefined()
    const sent = JSON.parse(String(h.sent('POST /artists'))) as { data: { id?: string } }
    expect(sent.data.id).toBe('muse')
    expect(h.artists['muse']?.name).toBe('Muse')
  })

  it('places into no list without into', async () => {
    const h = harness()
    const { client, queryClient } = h
    const list = listQueryOptions(client, 'albums')
    await queryClient.fetchQuery(list)
    const held = h.hold('POST /albums')
    const pending = h.run(bound(h).albums.create({ optimistic: true }), { title: 'X', year: 1 })
    await tick()
    expect(ids(h.data(list))).toEqual(['1'])
    held.release()
    await pending
    expect(queryClient.getQueryState(list.queryKey)?.isInvalidated).toBe(true)
  })

  it('attachTo attaches the new resource to a parent relation, its deferred member swapped to the server id', async () => {
    const h = harness()
    const { client, queryClient } = h
    const linkage = relationshipQueryOptions(client, 'albums', '1', 'tracks')
    const included = getQueryOptions(client, 'albums', '1', { include: ['tracks'] })
    await queryClient.fetchQuery(linkage)
    await queryClient.fetchQuery(included)
    const stop = h.observe(included)

    const write = h.hold('POST /tracks')
    // No title: the new track can't fill the included slot, which promises one, so it's deferred.
    const variables: Record<string, unknown> = {}
    const pending = h.run(
      bound(h).tracks.create({
        optimistic: true,
        attachTo: { type: 'albums', id: '1', rel: 'tracks' },
      }),
      variables,
    )
    await tick()
    const temp = variables['$tempId'] as string
    expect(ids(h.data(linkage))).toEqual(['t1', 't2', temp])
    const album = h.data(included) as Row
    expect(ids((album as unknown as { tracks: Row[] }).tracks)).toEqual(['t1', 't2'])
    expect(album.$pending('tracks')).toEqual([{ type: 'tracks', id: temp }])

    // Hold the settle's refetch, to see the state between success and settle.
    const refetch = h.hold('GET /albums/1')
    write.release()
    await vi.waitFor(() => expect(ids(h.data(linkage))).toEqual(['t1', 't2', 'srv-1']))
    expect((h.data(included) as Row).$pending('tracks')).toEqual([{ type: 'tracks', id: 'srv-1' }])
    refetch.release()
    await pending
    expect((h.data(included) as Row).$pending('tracks')).toEqual([])
    stop()
  })
})

describe('custom writes (B4)', () => {
  it('jsonApiMutationOptions gives any write the lifecycle: its own optimistic change, rollback and invalidation', async () => {
    const h = harness()
    const { client, queryClient } = h
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(get)
    let fail = false
    const publish = jsonApiMutationOptions({
      descriptor,
      mutationFn: async (albumId: string) => {
        await tick()
        if (fail) {
          throw new Error('nope')
        }
        return client.albums.id(albumId).get()
      },
      optimistic: (draft, albumId) => draft.patch('albums', albumId, { title: 'Published' }),
      invalidates: (albumId) => [resourceKey('albums', albumId)],
    })
    expect(publish.mutationKey).toEqual(['$custom'])
    expect(publish.meta).toEqual({ jsonApi: { verb: 'custom' } })

    const pending = h.run(publish, '1')
    expect((h.data(get) as Row)['title']).toBe('Published')
    await pending
    // The result is normalised and wins, and the invalidation ran.
    expect((h.data(get) as Row)['title']).toBe('OK Computer')
    expect(queryClient.getQueryState(get.queryKey)?.isInvalidated).toBe(true)

    fail = true
    await queryClient.fetchQuery({ ...get, staleTime: 0 })
    await expect(h.run(publish, '1')).rejects.toThrow('nope')
    expect((h.data(get) as Row)['title']).toBe('OK Computer')
  })

  it('a function replaces the built-in change unless it calls draft.applyDefault()', async () => {
    const h = harness()
    const { client, queryClient } = h
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(get)

    const replaced = h.hold('PATCH /albums/1')
    const only = h.run(
      bound(h)
        .albums.id('1')
        .update({
          optimistic: (draft) => draft.patch('albums', '1', { year: 2001 }),
        }),
      { title: 'Ignored' },
    )
    expect((h.data(get) as Row)['title']).toBe('OK Computer')
    expect((h.data(get) as Row)['year']).toBe(2001)
    replaced.release()
    await only

    const extended = h.hold('PATCH /albums/1')
    const both = h.run(
      bound(h)
        .albums.id('1')
        .update({
          optimistic: (draft) => {
            draft.applyDefault()
            draft.patch('albums', '1', { year: 1999 })
          },
        }),
      { title: 'Kept' },
    )
    expect((h.data(get) as Row)['title']).toBe('Kept')
    expect((h.data(get) as Row)['year']).toBe(1999)
    extended.release()
    await both
  })
})

describe('typing', () => {
  type D = typeof descriptor
  type ErrorCode = 'ALBUM_GONE' | 'RATE_LIMITED'
  const typed = createClient<
    D,
    DefaultWriteAttributes<D>,
    DefaultWriteAttributes<D>,
    DefaultActionTypes,
    ErrorCode
  >(descriptor, { baseUrl: BASE })

  it('types a mutation’s error with the client’s error codes, as MutationObserver infers it', () => {
    const qc = new QueryClient()
    const writes = createMutationApi(qc, typed, descriptor)
    const observer = new MutationObserver(qc, writes.albums.id('1').update())
    const error = observer.getCurrentResult().error
    expectTypeOf(error).toEqualTypeOf<WriteMutationError<
      ErrorCode,
      Record<never, never>,
      'update.albums',
      UpdateInput<D, DefaultWriteAttributes<D>, 'albums'>
    > | null>()
    expectTypeOf(error).toExtend<MutationError<ErrorCode> | null>()
    expectTypeOf<JsonApiError<ErrorCode>>().toExtend<MutationError<ErrorCode>>()
    const relation = new MutationObserver(qc, writes.albums.id('1').rel('tracks').add())
    expectTypeOf(relation.getCurrentResult().error).toExtend<MutationError<ErrorCode> | null>()
    const remove = new MutationObserver(qc, writes.albums.id('1').delete())
    expectTypeOf(remove.getCurrentResult().error).toEqualTypeOf<MutationError<ErrorCode> | null>()
  })

  it('types each error by the operation that raised it, and a write error by its input', () => {
    type ByOperation = {
      'create.albums': 'RATE_LIMITED'
      'addRelationship.albums.tracks': 'ALBUM_GONE'
      'fetchOne.albums': 'ALBUM_GONE'
    }
    const byOperation = createClient<
      D,
      DefaultWriteAttributes<D>,
      DefaultWriteAttributes<D>,
      DefaultActionTypes,
      ErrorCode,
      Record<never, never>,
      ByOperation
    >(descriptor, { baseUrl: BASE })
    const qc = new QueryClient()
    const writes = createMutationApi(qc, byOperation, descriptor)

    const create = new MutationObserver(qc, writes.albums.create()).getCurrentResult().error
    if (create instanceof JsonApiError) {
      expectTypeOf(create.errors[0]!.code).toEqualTypeOf<
        'RATE_LIMITED' | (string & {}) | undefined
      >()
    }
    expectTypeOf(fieldErrors(create)).toEqualTypeOf<
      FieldErrors<CreateInput<D, DefaultWriteAttributes<D>, 'albums'>, 'RATE_LIMITED'> | undefined
    >()
    const add = new MutationObserver(qc, writes.albums.id('1').rel('tracks').add())
    const added = fieldErrors(add.getCurrentResult().error)
    added?.first('tracks[0]')
    // @ts-expect-error the write's input holds only the relation it adds to
    added?.first('artist')
    // An operation the map doesn't list keeps every code.
    const remove = new MutationObserver(qc, writes.albums.id('1').delete()).getCurrentResult().error
    expectTypeOf(remove).toEqualTypeOf<MutationError<ErrorCode> | null>()

    const reads = createQueryApi(byOperation)
    expectTypeOf(
      new QueryObserver(qc, reads.albums.get('1')).getCurrentResult().error,
    ).toEqualTypeOf<ReadError<'ALBUM_GONE'> | null>()
    expectTypeOf(
      new QueryObserver(qc, reads.albums.list()).getCurrentResult().error,
    ).toEqualTypeOf<ReadError<ErrorCode> | null>()
  })

  it('types into by the view’s sort tokens', () => {
    const qc = new QueryClient()
    const writes = createMutationApi(qc, typed, descriptor)
    writes.albums.create({
      optimistic: { into: (q) => (q.params.sort === '-title' ? 'start' : false) },
    })
    writes.albums.create({
      // @ts-expect-error `-createdAt` is not a sort token albums' lists take
      optimistic: { into: (q) => (q.params.sort === '-createdAt' ? 'start' : false) },
    })
    writes.tracks.create({
      attachTo: {
        type: 'albums',
        id: '1',
        rel: 'tracks',
        into: (_q, member) => (member.type === 'tracks' ? 'end' : false),
      },
    })
    // @ts-expect-error albums has no relation `members`
    writes.tracks.create({ attachTo: { type: 'albums', id: '1', rel: 'members' } })
  })
})
