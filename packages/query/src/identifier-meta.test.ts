import { type ApiDescriptor, createClient, type TransportResponse } from '@haddowg/json-api-client'
import { QueryClient } from '@tanstack/query-core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { relationshipQueryOptions } from './read'

// A relation declaring the members its identifier meta carries, beside a pivot.
const descriptor = {
  teams: {
    attributes: { name: 'string' },
    relations: {
      members: {
        cardinality: 'many',
        types: ['users'],
        pivot: true,
        readPivot: { fields: { position: 'integer' } },
        identifierMeta: { fields: { role: 'string' } },
      },
    },
    paths: {
      fetchOne: '/teams/{id}',
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
  },
} as const satisfies ApiDescriptor

describe('relationshipQueryOptions with declared identifier meta', () => {
  it("resolves each member's typed edge meta beside its pivot", async () => {
    const client = createClient(descriptor, {
      baseUrl: 'https://teams.example',
      transport: async (): Promise<TransportResponse> => ({
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: [{ type: 'users', id: '7', meta: { role: 'captain', pivot: { position: 1 } } }],
        }),
      }),
    })
    const options = relationshipQueryOptions(client, 'teams', '1', 'members')
    type Member = Awaited<ReturnType<typeof options.queryFn>>[number]
    expectTypeOf<
      NonNullable<NonNullable<Member['$edge']>['meta']>['role']
    >().toEqualTypeOf<string>()
    expectTypeOf<NonNullable<Member['$pivot']>['position']>().toEqualTypeOf<number>()

    const members = await new QueryClient().fetchQuery(options)
    expect(members[0]?.$edge?.meta?.role).toBe('captain')
    expect(members[0]?.$pivot?.position).toBe(1)
  })
})
