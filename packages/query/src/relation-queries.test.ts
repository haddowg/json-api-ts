import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { QueryClient } from '@tanstack/query-core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createQueryApi, relatedQueryOptions, relationshipQueryOptions } from './read'

// A polymorphic to-many identified by its link rows: a pivot, and the sorts and filters its reads
// declare over the pivot fields. `followers` declares none of its own, so it takes the users
// collection's sorts.
const descriptor = {
  teams: {
    attributes: { name: 'string' },
    relations: {
      sponsors: {
        cardinality: 'many',
        types: ['users', 'brands'],
        polymorphic: true,
        pivot: true,
        readPivot: { fields: { rank: 'integer' } },
        sortable: ['rank', '-rank'],
        filterable: ['minRank'],
      },
      followers: { cardinality: 'many', types: ['users'], pivot: false },
    },
    paths: {
      fetchOne: '/teams/{id}',
      fetchRelated: '/teams/{id}/{rel}',
      fetchRelationship: '/teams/{id}/relationships/{rel}',
    },
    paginator: 'none',
    clientId: 'forbidden',
  },
  users: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchOne: '/users/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    sortable: ['name', '-name'],
  },
  brands: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchOne: '/brands/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

function teamsClient() {
  const requests: TransportRequest[] = []
  const client = createClient(descriptor, {
    baseUrl: 'https://teams.example',
    transport: async (req): Promise<TransportResponse> => {
      requests.push(req)
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: [{ type: 'brands', id: '3', meta: { pivot: { rank: 1 } } }],
        }),
      }
    },
  })
  return { client, requests }
}

describe("relation reads with the relation's own sorts and filters", () => {
  it('sends them and keys the read by them', async () => {
    const { client, requests } = teamsClient()
    const options = relationshipQueryOptions(client, 'teams', '1', 'sponsors', {
      sort: '-rank',
      filter: { minRank: 1 },
    })
    expect(options.queryKey).toEqual([
      'teams',
      'fetchRelationship',
      '1',
      'sponsors',
      { filter: { minRank: 1 }, sort: '-rank' },
    ])
    const members = await new QueryClient().fetchQuery(options)
    expect(members[0]?.$pivot?.rank).toBe(1)
    expect(decodeURIComponent(requests[0]!.url)).toBe(
      'https://teams.example/teams/1/relationships/sponsors?filter[minRank]=1&sort=-rank',
    )
  })

  it('narrows sort and filter to what the relation declares', () => {
    const { client } = teamsClient()
    relatedQueryOptions(client, 'teams', '1', 'sponsors', { sort: ['rank'] })
    // @ts-expect-error — `name` is not a sort of the relation.
    relatedQueryOptions(client, 'teams', '1', 'sponsors', { sort: 'name' })
    // @ts-expect-error — `name` is not a filter of the relation.
    createQueryApi(client).teams.relationship('1', 'sponsors', { filter: { name: 'x' } })
    // A relation declaring none of its own takes its related type's sorts and any filter.
    createQueryApi(client).teams.related('1', 'followers', { sort: 'name', filter: { name: 'x' } })
    type Query = NonNullable<
      Parameters<typeof relatedQueryOptions<typeof descriptor, unknown, 'teams', 'sponsors'>>[4]
    >
    expectTypeOf<NonNullable<Query['sort']>>().toEqualTypeOf<
      'rank' | '-rank' | readonly ('rank' | '-rank')[]
    >()
  })
})
