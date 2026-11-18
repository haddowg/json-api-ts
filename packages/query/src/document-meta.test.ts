import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { QueryClient } from '@tanstack/query-core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createMutationApi } from './mutate'
import { createQueryApi } from './read'

const BASE = 'https://api.example'

const LIST_META = {
  fields: { page: 'object', total: 'integer', unread: 'integer' },
  required: ['unread'],
} as const

// Core's witness `notices`, whose reads, update and delete declare their top-level meta.
const descriptor = {
  notices: {
    attributes: { message: 'string' },
    relations: {
      replies: {
        cardinality: 'many',
        types: ['notices'],
        pivot: false,
        mutations: {},
        documentMeta: LIST_META,
      },
    },
    paths: {
      delete: '/notices/{id}',
      fetchMany: '/notices',
      fetchOne: '/notices/{id}',
      fetchRelated: '/notices/{id}/{rel}',
      update: '/notices/{id}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    documentMeta: {
      fetchMany: LIST_META,
      fetchOne: { fields: { etag: 'string' } },
      update: { fields: { etag: 'string' } },
      delete: { fields: { archived: 'integer' } },
    },
  },
} as const satisfies ApiDescriptor

const notice = { type: 'notices', id: 'n-1', attributes: { message: 'Hi' } }

function makeClient(routes: Record<string, unknown>) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    const body = routes[`${req.method} ${new URL(req.url).pathname}`]
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }
  return { client: createClient(descriptor, { baseUrl: BASE, transport }), requests }
}

describe('typed document meta through the query bindings', () => {
  it('carries the declared meta beside the page on a collection and a related read', async () => {
    const { client } = makeClient({
      'GET /notices': { data: [notice], meta: { unread: 3, page: { currentPage: 1 } } },
      'GET /notices/n-1/replies': { data: [], meta: { unread: 0, total: 0 } },
      'GET /notices/n-1': { data: notice, meta: { etag: 'W/"7"' } },
    })
    const qc = new QueryClient()
    const api = createQueryApi(client)
    const list = await qc.fetchQuery(api.notices.list())
    expect(list.$meta.unread).toBe(3)
    expect(list.$page.kind).toBe('page')
    expectTypeOf(list.$meta.unread).toEqualTypeOf<number>()
    expectTypeOf(list.$meta.page).toEqualTypeOf<Record<string, unknown> | undefined>()
    const replies = await qc.fetchQuery(api.notices.related('n-1', 'replies'))
    expect(replies.$meta.total).toBe(0)
    expectTypeOf(replies.$meta.unread).toEqualTypeOf<number>()
    const read = await qc.fetchQuery(api.notices.get('n-1'))
    expect(read.$document.meta.etag).toBe('W/"7"')
    expectTypeOf(read.$document.meta.etag).toEqualTypeOf<string>()
  })

  it('resolves the writes to their declared meta', async () => {
    const { client } = makeClient({
      'PATCH /notices/n-1': { data: notice, meta: { etag: 'W/"8"' } },
      'DELETE /notices/n-1': { meta: { archived: 1 } },
    })
    const qc = new QueryClient()
    const mutations = createMutationApi(qc, client, descriptor)
    const updated = await mutations.notices.id('n-1').update().mutationFn({ message: 'Bye' })
    expect(updated.$document.meta.etag).toBe('W/"8"')
    expectTypeOf(updated.$document.meta.etag).toEqualTypeOf<string>()
    const deleted = await mutations.notices.id('n-1').delete().mutationFn()
    expect(deleted).toEqual({ archived: 1 })
    expectTypeOf(deleted.archived).toEqualTypeOf<number>()
  })
})
