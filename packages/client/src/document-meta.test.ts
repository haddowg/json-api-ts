import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'

const LIST_META = {
  fields: { digest: 'string', page: 'object', total: 'integer', unread: 'integer' },
  required: ['unread'],
  nullable: ['digest'],
} as const

// Core's witness `notices`, as the codegen describes it, and `tags`, which declares no meta.
const descriptor = {
  notices: {
    attributes: { message: 'string' },
    relations: {
      replies: {
        cardinality: 'many',
        types: ['notices'],
        pivot: false,
        mutations: { add: true, remove: true, replace: true },
        documentMeta: LIST_META,
      },
      parent: {
        cardinality: 'one',
        types: ['notices'],
        pivot: false,
        mutations: { set: true },
        documentMeta: { fields: { etag: 'string' } },
      },
    },
    paths: {
      create: '/notices',
      delete: '/notices/{id}',
      fetchMany: '/notices',
      fetchOne: '/notices/{id}',
      fetchRelated: '/notices/{id}/{rel}',
      fetchRelationship: '/notices/{id}/relationships/{rel}',
      update: '/notices/{id}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    actions: {
      'mark-read': {
        scope: 'collection',
        path: '/notices/-actions/mark-read',
        input: 'none',
        output: 'document',
        outputType: 'notices',
        outputCardinality: 'one',
        documentMeta: { '200': { fields: { marked: 'integer' } } },
      },
      snapshot: {
        scope: 'resource',
        path: '/notices/{id}/-actions/snapshot',
        input: 'none',
        output: 'document',
        metaResult: true,
        outputType: 'notices',
        outputCardinality: 'one',
        documentMeta: {
          '200': { fields: { unchanged: 'boolean' } },
          '201': { fields: { snapshotOf: 'string' } },
        },
      },
      count: {
        scope: 'collection',
        path: '/notices/-actions/count',
        input: 'none',
        output: 'meta',
        documentMeta: { '200': { fields: { count: 'integer' } } },
      },
    },
    documentMeta: {
      fetchMany: LIST_META,
      fetchOne: { fields: { etag: 'string' } },
      update: { fields: { etag: 'string' }, required: [], nullable: ['etag'] },
      delete: { fields: { archived: 'integer' } },
    },
  },
  tags: {
    attributes: { name: 'string' },
    relations: {},
    paths: { delete: '/tags/{id}', fetchMany: '/tags', fetchOne: '/tags/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

interface Attributes {
  notices: { message: string }
  tags: { name: string }
}

const notice = { type: 'notices', id: 'n-1', attributes: { message: 'Hi' } }

function answering(...bodies: { status?: number; body?: unknown }[]) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    const next = bodies.shift() ?? {}
    return {
      status: next.status ?? 200,
      headers: {},
      body: next.body === undefined ? '' : JSON.stringify(next.body),
    }
  }
  const client = createClient<typeof descriptor, Attributes>(descriptor, {
    baseUrl: BASE,
    transport,
  })
  return { requests, client }
}

describe('typed document meta', () => {
  it('types a collection read’s $meta with the members it declares', async () => {
    const { client } = answering({ body: { data: [notice], meta: { unread: 3, digest: null } } })
    const list = await client.notices.list()
    expect(list.$meta.unread).toBe(3)
    expectTypeOf(list.$meta.unread).toEqualTypeOf<number>()
    expectTypeOf(list.$meta.digest).toEqualTypeOf<string | null | undefined>()
    expectTypeOf(list.$meta.total).toEqualTypeOf<number | undefined>()
    expectTypeOf(list.$meta.page).toEqualTypeOf<Record<string, unknown> | undefined>()
  })

  it('types a single read’s and a write’s $document.meta', async () => {
    const { client } = answering(
      { body: { data: notice, meta: { etag: 'W/"7"' } } },
      { body: { data: notice } },
      { status: 201, body: { data: notice } },
    )
    const read = await client.notices.get('n-1')
    expect(read.$document.meta.etag).toBe('W/"7"')
    expectTypeOf(read.$document.meta.etag).toEqualTypeOf<string>()
    // No member of the update's meta is required, so the document may carry none.
    const updated = await client.notices.id('n-1').update({})
    expect(updated.$document.meta).toBeUndefined()
    expectTypeOf(updated.$document.meta?.etag).toEqualTypeOf<string | null | undefined>()
    const created = await client.notices.create({})
    expectTypeOf(created.$document.meta).toEqualTypeOf<Record<string, unknown> | undefined>()
  })

  it('types the related read’s meta by cardinality', async () => {
    const { client } = answering(
      { body: { data: [notice], meta: { unread: 1 } } },
      { body: { data: notice, meta: { etag: 'W/"2"' } } },
    )
    const replies = await client.notices.id('n-1').replies.related()
    expectTypeOf(replies.$meta.unread).toEqualTypeOf<number>()
    expect(replies.$meta.unread).toBe(1)
    const parent = await client.notices.id('n-1').parent.related()
    expect(parent?.$document.meta.etag).toBe('W/"2"')
    expectTypeOf(parent?.$document.meta.etag).toEqualTypeOf<string | undefined>()
  })

  it('resolves a delete declaring its meta to that meta', async () => {
    const { client } = answering({ body: { meta: { archived: 1 } } }, { status: 204 })
    const deleted = await client.notices.id('n-1').delete()
    expect(deleted).toEqual({ archived: 1 })
    expectTypeOf(deleted.archived).toEqualTypeOf<number>()
    const removed = await client.tags.id('t-1').delete()
    expect(removed).toBeUndefined()
    expectTypeOf(removed).toEqualTypeOf<void>()
  })

  it('types an action’s meta, and answers a meta-only 200 with its meta', async () => {
    const { client } = answering(
      { body: { data: notice, meta: { marked: 12 } } },
      { body: { meta: { unchanged: true } } },
      { status: 201, body: { data: notice, meta: { snapshotOf: 'n-1' } } },
      { body: { meta: { count: 4 } } },
    )
    const marked = await client.notices.actions['mark-read']()
    expect(marked.$document.meta.marked).toBe(12)
    expectTypeOf(marked.$document.meta.marked).toEqualTypeOf<number>()
    const unchanged = await client.notices.id('n-1').actions.snapshot()
    expect(unchanged).toEqual({ unchanged: true })
    const created = await client.notices.id('n-1').actions.snapshot()
    if ('unchanged' in created) {
      throw new Error('expected the created resource')
    }
    expect(created.id).toBe('n-1')
    expect(created.$document.meta.snapshotOf).toBe('n-1')
    const counted = await client.notices.actions.count()
    expect(counted).toEqual({ count: 4 })
    expectTypeOf(counted.count).toEqualTypeOf<number>()
  })

  it('keeps the loose meta where nothing is declared', async () => {
    const tag = { type: 'tags', id: 't-1', attributes: { name: 'news' } }
    const { client } = answering(
      { body: { data: [], meta: { anything: 1 } } },
      { body: { data: tag, meta: { anything: 2 } } },
    )
    const tags = await client.tags.list()
    expect(tags.$meta).toEqual({ anything: 1 })
    expectTypeOf(tags.$meta).toEqualTypeOf<Record<string, unknown> | undefined>()
    const read = await client.tags.get('t-1')
    expect(read.$document.meta).toEqual({ anything: 2 })
    expectTypeOf(read.$document.meta).toEqualTypeOf<Record<string, unknown> | undefined>()
  })
})
