import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'

// Shaped like core's witness: `count` takes every filter of the collection read, `bulk-archive`
// a subset, and `stats` none.
const descriptor = {
  articles: {
    attributes: { title: 'string' },
    relations: {},
    paths: { fetchMany: '/articles' },
    paginator: 'none',
    clientId: 'forbidden',
    filterable: ['labels', 'rating', 'state', 'status', 'wordCount'],
    actions: {
      count: {
        scope: 'collection',
        path: '/articles/-actions/count',
        method: 'GET',
        input: 'none',
        output: 'meta',
        filterable: ['labels', 'rating', 'state', 'status', 'wordCount'],
      },
      'bulk-archive': {
        scope: 'collection',
        path: '/articles/-actions/bulk-archive',
        input: 'none',
        output: 'none',
        filterable: ['labels', 'rating', 'status'],
      },
      relabel: {
        scope: 'collection',
        path: '/articles/-actions/relabel',
        input: 'document',
        output: 'none',
        filterable: ['status'],
      },
      stats: {
        scope: 'collection',
        path: '/articles/-actions/stats',
        method: 'GET',
        input: 'none',
        output: 'meta',
      },
    },
  },
} as const satisfies ApiDescriptor

type Attributes = { articles: { title: string } }

function recorder(reply: TransportResponse) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    return reply
  }
  return { requests, transport }
}

const meta = { status: 200, headers: {}, body: JSON.stringify({ meta: { total: 3 } }) }
const noContent = { status: 204, headers: {}, body: '' }

const client = (transport: (req: TransportRequest) => Promise<TransportResponse>) =>
  createClient<typeof descriptor, Attributes>(descriptor, { baseUrl: BASE, transport })

describe('collection actions that take filters', () => {
  it('sends the filters in the query string as a collection read does', async () => {
    const { requests, transport } = recorder(meta)
    const result = await client(transport).articles.actions.count({
      filter: { status: 'published', rating: { min: 1, max: 5 }, labels: ['a', 'b'] },
    })
    expect(result).toEqual({ total: 3 })
    expect(requests[0]!.method).toBe('GET')
    expect(decodeURIComponent(requests[0]!.url)).toBe(
      `${BASE}/articles/-actions/count?filter[status]=published&filter[rating][min]=1&filter[rating][max]=5&filter[labels]=a,b`,
    )
  })

  it('sends a body action its filters alongside the body', async () => {
    const { requests, transport } = recorder(noContent)
    await client(transport).articles.actions.relabel(
      { data: { type: 'articles' } },
      { filter: { status: 'draft' } },
    )
    expect(requests[0]!.method).toBe('POST')
    expect(decodeURIComponent(requests[0]!.url)).toBe(
      `${BASE}/articles/-actions/relabel?filter[status]=draft`,
    )
    expect(JSON.parse(requests[0]!.body as string)).toEqual({ data: { type: 'articles' } })
  })

  it('sends no query without filters', async () => {
    const { requests, transport } = recorder(noContent)
    await client(transport).articles.actions['bulk-archive']()
    expect(requests[0]!.url).toBe(`${BASE}/articles/-actions/bulk-archive`)
  })

  it('narrows the filter keys to the ones the action takes', () => {
    const actions = client(recorder(noContent).transport).articles.actions
    type Options = NonNullable<Parameters<(typeof actions)['bulk-archive']>[0]>
    expectTypeOf<keyof NonNullable<Options['filter']>>().toEqualTypeOf<
      'labels' | 'rating' | 'status'
    >()
    expectTypeOf<Options['signal']>().toEqualTypeOf<AbortSignal | undefined>()
    // Never called: the line is here for the compiler.
    const outOfScope = () =>
      // @ts-expect-error -- `wordCount` is a filter of the collection read, not of this action
      actions['bulk-archive']({ filter: { wordCount: 3 } })
    expect(outOfScope).toBeTypeOf('function')
  })

  it('keeps an action without filters as it was', () => {
    const actions = client(recorder(meta).transport).articles.actions
    expectTypeOf(actions.stats).parameters.toEqualTypeOf<[]>()
  })
})
