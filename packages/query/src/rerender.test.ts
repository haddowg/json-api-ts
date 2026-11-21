import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { QueryClient, QueryObserver } from '@tanstack/query-core'
import { describe, expect, it } from 'vitest'
import { installNormalization } from './install'
import { applyOptimisticPatch } from './normalize'
import { getQueryOptions, listQueryOptions, type QueryOptions } from './read'

const BASE = 'https://music.example'

const descriptor = {
  albums: {
    attributes: { title: 'string' },
    relations: {},
    paths: { fetchMany: '/albums', fetchOne: '/albums/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

const album = (title: string) => ({ type: 'albums', id: '1', attributes: { title } })

function setup() {
  let title = 'OK Computer'
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    const body = req.url.includes('/albums/1') ? { data: album(title) } : { data: [album(title)] }
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }
  const client = createClient(descriptor, { baseUrl: BASE, transport })
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  installNormalization(queryClient, descriptor)
  return {
    client,
    queryClient,
    rename: (next: string) => {
      title = next
    },
  }
}

/**
 * A component observing a read through React Query re-renders when a value it reads changes. In
 * the default tracked mode an observer that only reads `data` notifies only when `data` is a new
 * reference, which `notifyOnChangeProps: ['data']` reproduces here without React.
 */
function observe<R>(queryClient: QueryClient, options: QueryOptions<R>) {
  const observer = new QueryObserver(queryClient, { ...options, notifyOnChangeProps: ['data'] })
  const seen: unknown[] = []
  const unsubscribe = observer.subscribe((result) => {
    seen.push((result.data as { title?: string } | undefined)?.title)
  })
  return { seen, unsubscribe }
}

describe('an observed read after a write-through patch', () => {
  it('notifies its observer when another query patches the resource', async () => {
    const { client, queryClient, rename } = setup()
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(get)
    const { seen, unsubscribe } = observe(queryClient, get)

    rename('OK Computer OKNOTOK')
    await queryClient.fetchQuery(listQueryOptions(client, 'albums'))

    expect(seen.at(-1)).toBe('OK Computer OKNOTOK')
    unsubscribe()
  })

  it('keeps an invalidated read invalidated, and its accessors, after the patch', async () => {
    const { client, queryClient, rename } = setup()
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(get)
    await queryClient.invalidateQueries({ queryKey: get.queryKey, refetchType: 'none' })

    rename('Kid A')
    await queryClient.fetchQuery(listQueryOptions(client, 'albums'))

    const state = queryClient.getQueryState(get.queryKey)
    expect(state?.isInvalidated).toBe(true)
    // The tagged key types the cached state, so no cast is needed to read it.
    const data = state?.data
    expect(data?.title).toBe('Kid A')
    expect(data?.$raw).toBeDefined()
  })

  it('notifies its observer for an optimistic patch and again for its rollback', async () => {
    const { client, queryClient } = setup()
    const get = getQueryOptions(client, 'albums', '1')
    await queryClient.fetchQuery(get)
    const { seen, unsubscribe } = observe(queryClient, get)

    const snapshot = applyOptimisticPatch(
      queryClient,
      'albums',
      '1',
      { title: 'Optimistic' },
      descriptor,
    )
    expect(seen.at(-1)).toBe('Optimistic')
    snapshot.restore()
    expect(seen.at(-1)).toBe('OK Computer')
    expect((queryClient.getQueryData(get.queryKey) as { title: string }).title).toBe('OK Computer')
    unsubscribe()
  })

  it('re-renders the list a patch reaches, keeping it an augmented array', async () => {
    const { client, queryClient, rename } = setup()
    const list = listQueryOptions(client, 'albums')
    await queryClient.fetchQuery(list)
    const observer = new QueryObserver(queryClient, { ...list, notifyOnChangeProps: ['data'] })
    let notified = 0
    const unsubscribe = observer.subscribe(() => {
      notified++
    })

    rename('Amnesiac')
    await queryClient.fetchQuery(getQueryOptions(client, 'albums', '1'))

    expect(notified).toBeGreaterThan(0)
    const data = queryClient.getQueryData(list.queryKey) as unknown as {
      0: { title: string }
      $page: unknown
      length: number
    }
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBe(1)
    expect(data[0].title).toBe('Amnesiac')
    expect(data.$page).toBeDefined()
    unsubscribe()
  })
})
