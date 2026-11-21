import {
  type ApiDescriptor,
  createClient,
  type DefaultActionTypes,
  type DefaultWriteAttributes,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { type SkipToken, skipToken } from '@tanstack/query-core'
import { describe, expect, it } from 'vitest'
import { SKIPPED_SEGMENT } from './keys'
import {
  createQueryApi,
  getQueryOptions,
  infiniteListQueryOptions,
  infiniteRelatedQueryOptions,
  listQueryOptions,
  relatedQueryOptions,
  relationshipQueryOptions,
} from './read'

const descriptor = {
  albums: {
    attributes: { title: 'string' },
    relations: {
      tracks: { cardinality: 'many', types: ['albums'], pivot: false },
    },
    paths: {
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
      fetchRelationship: '/albums/{id}/relationships/{rel}',
    },
    paginator: 'page',
    clientId: 'forbidden',
  },
  inboxes: {
    attributes: { unread: 'number' },
    relations: { owner: { cardinality: 'one', types: ['albums'], pivot: false } },
    paths: { fetchOne: '/inbox', fetchRelated: '/inbox/{rel}' },
    paginator: 'none',
    clientId: 'forbidden',
    singleton: true,
  },
} as const satisfies ApiDescriptor
type D = typeof descriptor

function makeClient() {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    return { status: 200, headers: {}, body: JSON.stringify({ data: [] }) }
  }
  const client = createClient<
    D,
    { albums: { title: string }; inboxes: { unread: number } },
    DefaultWriteAttributes<D>,
    DefaultActionTypes,
    never
  >(descriptor, { baseUrl: 'https://music.example', transport })
  return { client, requests }
}

// Another copy of query-core has its own `Symbol()`, which this one's `skipToken` is not.
const foreign = Symbol('skipToken of another query-core')

describe('a skip token from any copy of query-core', () => {
  it('is the queryFn of every read factory, under the skipped key', () => {
    const { client, requests } = makeClient()
    const token: SkipToken = foreign as never
    const api = createQueryApi(client)
    const all = [
      [listQueryOptions(client, 'albums', token), ['albums', 'fetchMany', SKIPPED_SEGMENT]],
      [getQueryOptions(client, 'albums', token), ['albums', 'fetchOne', SKIPPED_SEGMENT]],
      [relationshipQueryOptions(client, 'albums', token, 'tracks'), undefined],
      [relatedQueryOptions(client, 'albums', token, 'tracks'), undefined],
      [infiniteListQueryOptions(client, 'albums', token), undefined],
      [infiniteRelatedQueryOptions(client, 'albums', token, 'tracks'), undefined],
      [api.albums.list(token), ['albums', 'fetchMany', SKIPPED_SEGMENT]],
      [api.albums.get(token), ['albums', 'fetchOne', SKIPPED_SEGMENT]],
      [api.albums.relationship(token, 'tracks'), undefined],
      [api.albums.related(token, 'tracks'), undefined],
      [api.albums.infinite(token), undefined],
      [api.albums.relatedInfinite(token, 'tracks'), undefined],
      [api.inboxes.get(token), undefined],
      [api.inboxes.related('owner', token), undefined],
    ] as const
    for (const [options, key] of all) {
      expect(options.queryFn).toBe(foreign)
      expect(JSON.stringify(options.queryKey)).toContain('$skip')
      if (key !== undefined) {
        expect(options.queryKey).toEqual(key)
      }
    }
    expect(requests).toEqual([])
  })

  it('still works with the real skipToken', () => {
    const { client, requests } = makeClient()
    expect(listQueryOptions(client, 'albums', skipToken).queryFn).toBe(skipToken)
    expect(createQueryApi(client).albums.get(skipToken).queryFn).toBe(skipToken)
    expect(createQueryApi(client).albums.infinite(skipToken).queryFn).toBe(skipToken)
    expect(requests).toEqual([])
  })
})
