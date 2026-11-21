import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { InfiniteQueryObserver, QueryClient } from '@tanstack/query-core'
import { describe, expect, it } from 'vitest'
import { installNormalization } from './install'
import { keyFor } from './keys'
import { JsonApiMutationCache } from './mutation-cache'
import {
  getQueryOptions,
  infiniteListQueryOptions,
  listQueryOptions,
  relationshipQueryOptions,
} from './read'
import { resolveMember } from './resolve'
import { withScope } from './scope'
import { describeQuery, IDENTIFIERS, viewShape, type ViewShape } from './view-shape'

const BASE = 'https://music.example'

const descriptor = {
  albums: {
    attributes: { title: 'string' },
    relations: { tracks: { cardinality: 'many', types: ['tracks'], pivot: true } },
    paths: {
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
      fetchRelationship: '/albums/{id}/relationships/{rel}',
    },
    paginator: 'page',
    clientId: 'forbidden',
  },
  tracks: {
    attributes: { title: 'string', duration: 'integer' },
    relations: {},
    paths: { fetchMany: '/tracks', fetchOne: '/tracks/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

const fullTrack = (id: string) => ({
  type: 'tracks',
  id,
  attributes: { title: `Track ${id}`, duration: 100 },
})
const sparseTrack = (id: string) => ({ type: 'tracks', id, attributes: { title: `Track ${id}` } })

/** Answers each request by its pathname. */
const routes: Record<string, (url: URL) => unknown> = {
  '/tracks/t1': (url) => ({
    data: url.searchParams.has('fields[tracks]') ? sparseTrack('t1') : fullTrack('t1'),
  }),
  '/tracks': (url) =>
    url.searchParams.get('page[number]') === '2'
      ? { data: [fullTrack('t3')] }
      : { data: [fullTrack('t2')], links: { next: `${BASE}/tracks?page%5Bnumber%5D=2` } },
  '/albums/1': () => ({
    data: {
      type: 'albums',
      id: '1',
      attributes: { title: 'Blue' },
      relationships: {
        tracks: { data: [{ type: 'tracks', id: 't1', meta: { pivot: { position: 3 } } }] },
      },
    },
    included: [fullTrack('t1')],
  }),
  '/albums/1/relationships/tracks': () => ({ data: [{ type: 'tracks', id: 't1' }] }),
}

function setup() {
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    const url = new URL(req.url)
    const route = routes[url.pathname]
    return {
      status: route === undefined ? 404 : 200,
      headers: {},
      body: JSON.stringify(route === undefined ? { errors: [{ status: '404' }] } : route(url)),
    }
  }
  const client = createClient(descriptor, { baseUrl: BASE, transport })
  const queryClient = new QueryClient({
    mutationCache: new JsonApiMutationCache(),
    defaultOptions: { queries: { staleTime: Infinity } },
  })
  installNormalization(queryClient, descriptor)
  installNormalization(queryClient, descriptor, { scope: 'admin' })
  return { client, queryClient }
}

/** The shape a related read of album 1's tracks promises: tracks with both attributes. */
const fullShape: ViewShape = viewShape(
  describeQuery(
    keyFor({ type: 'albums', operation: 'fetchRelated', id: '1', rel: 'tracks' }),
    descriptor,
  )!,
  descriptor,
)

const fetchSparse = (setupResult: ReturnType<typeof setup>) =>
  setupResult.queryClient.fetchQuery(
    getQueryOptions(setupResult.client, 'tracks', 't1', {
      fields: { tracks: ['title'] },
    } as never) as never,
  )

describe('resolveMember', () => {
  it('prefers a fitting candidate over any cached copy', async () => {
    const context = setup()
    await context.queryClient.fetchQuery(getQueryOptions(context.client, 'tracks', 't1') as never)
    const candidate = { type: 'tracks', id: 't1', title: 'Picked', duration: 1 }
    const resolved = resolveMember(context.queryClient, 'tracks', 't1', fullShape, descriptor, {
      candidates: [{ type: 'tracks', id: 't9', title: 'Other', duration: 2 }, candidate],
    })
    expect(resolved).toBe(candidate)
  })

  it("falls back to a cached copy that fits when the candidate doesn't", async () => {
    const context = setup()
    await fetchSparse(context)
    await context.queryClient.fetchQuery(getQueryOptions(context.client, 'tracks', 't1') as never)
    const resolved = resolveMember(context.queryClient, 'tracks', 't1', fullShape, descriptor, {
      candidates: [{ type: 'tracks', id: 't1' }],
    })
    expect(resolved).toMatchObject({ type: 'tracks', id: 't1', title: 'Track t1', duration: 100 })
  })

  it('answers undefined when only sparse copies are cached', async () => {
    const context = setup()
    await fetchSparse(context)
    await context.queryClient.fetchQuery(
      relationshipQueryOptions(context.client, 'albums', '1', 'tracks' as never) as never,
    )
    expect(
      resolveMember(context.queryClient, 'tracks', 't1', fullShape, descriptor),
    ).toBeUndefined()
    // The identifier the relationship read holds is enough for an identifiers slot.
    expect(
      resolveMember(context.queryClient, 'tracks', 't1', IDENTIFIERS, descriptor),
    ).toMatchObject({ type: 'tracks', id: 't1' })
  })

  it('never crosses scopes', async () => {
    const context = setup()
    await context.queryClient.fetchQuery(
      withScope('admin', getQueryOptions(context.client, 'tracks', 't1')) as never,
    )
    expect(
      resolveMember(context.queryClient, 'tracks', 't1', fullShape, descriptor),
    ).toBeUndefined()
    expect(
      resolveMember(context.queryClient, 'tracks', 't1', fullShape, descriptor, {
        scope: 'admin',
      }),
    ).toMatchObject({ id: 't1', duration: 100 })
    expect(
      resolveMember(context.queryClient, 'tracks', 't1', fullShape, descriptor, {
        scope: 'other',
      }),
    ).toBeUndefined()
  })

  it('finds a copy on any page of an infinite query', async () => {
    const context = setup()
    const options = infiniteListQueryOptions(context.client, 'tracks')
    await context.queryClient.fetchInfiniteQuery(options as never)
    const observer = new InfiniteQueryObserver(context.queryClient, options as never)
    await observer.fetchNextPage()
    observer.destroy()
    expect(resolveMember(context.queryClient, 'tracks', 't3', fullShape, descriptor)).toMatchObject(
      { id: 't3', duration: 100 },
    )
  })

  it('finds a copy included as a per-edge view', async () => {
    const context = setup()
    await context.queryClient.fetchQuery(
      getQueryOptions(context.client, 'albums', '1', { include: ['tracks'] } as never) as never,
    )
    const resolved = resolveMember(context.queryClient, 'tracks', 't1', fullShape, descriptor) as {
      duration: number
      $pivot: unknown
    }
    expect(resolved.duration).toBe(100)
    expect(resolved.$pivot).toEqual({ position: 3 })
  })

  it('prefers the copy from the most recently updated query', async () => {
    const context = setup()
    const { queryClient, client } = context
    await queryClient.fetchQuery(getQueryOptions(client, 'tracks', 't1') as never)
    await queryClient.fetchQuery(
      getQueryOptions(client, 'albums', '1', { include: ['tracks'] } as never) as never,
    )
    const single = queryClient.getQueryCache().find({ queryKey: ['tracks', 'fetchOne', 't1'] })!
    const album = queryClient
      .getQueryCache()
      .find({ queryKey: ['albums', 'fetchOne', '1'], exact: false })!
    const edge = (album.state.data as { tracks: unknown[] }).tracks[0]

    single.setState({ dataUpdatedAt: 2_000 })
    album.setState({ dataUpdatedAt: 1_000 })
    const fromSingle = resolveMember(queryClient, 'tracks', 't1', fullShape, descriptor)
    expect(fromSingle).not.toBe(edge)
    expect((fromSingle as { $pivot?: unknown }).$pivot).toBeUndefined()

    album.setState({ dataUpdatedAt: 3_000 })
    expect(resolveMember(queryClient, 'tracks', 't1', fullShape, descriptor)).toBe(edge)
  })

  it("ignores queries that aren't the binding's", async () => {
    const context = setup()
    context.queryClient.setQueryData(
      ['todos'],
      [{ type: 'tracks', id: 't1', title: 'x', duration: 1 }],
    )
    expect(
      resolveMember(context.queryClient, 'tracks', 't1', fullShape, descriptor),
    ).toBeUndefined()
    await context.queryClient.fetchQuery(listQueryOptions(context.client, 'tracks') as never)
    expect(resolveMember(context.queryClient, 'tracks', 't2', fullShape, descriptor)).toMatchObject(
      { id: 't2' },
    )
  })
})
