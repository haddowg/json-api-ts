import { type ApiDescriptor, createClient } from '@haddowg/json-api-client'
import { QueryClient } from '@tanstack/query-core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type DraftMember,
  type DraftQuery,
  type InsertInto,
  type Into,
  type ListDraftQuery,
  openDraft,
  type RelationDraftQuery,
  type RelationInto,
} from './draft'
import { JsonApiMutationCache } from './mutation-cache'
import { createMutationApi } from './mutate'
import type { QueryDescription } from './view-shape'

const descriptor = {
  albums: {
    attributes: { title: 'string', createdAt: 'date-time' },
    relations: {
      artist: { cardinality: 'one', types: ['artists'] },
      tracks: { cardinality: 'many', types: ['tracks'] },
    },
    paths: {
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
      fetchRelationship: '/albums/{id}/relationships/{rel}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    sortable: ['title', '-title', 'createdAt', '-createdAt'],
    filterable: ['title', 'artist'],
  },
  tracks: {
    attributes: { title: 'string' },
    relations: {},
    paths: { fetchMany: '/tracks', fetchOne: '/tracks/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
    sortable: ['title', '-title'],
    filterable: ['album'],
  },
  artists: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchMany: '/artists', fetchOne: '/artists/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
  playlists: {
    attributes: { name: 'string' },
    relations: {
      tracks: {
        cardinality: 'many',
        types: ['tracks'],
        pivot: true,
        readPivot: {
          fields: { position: 'integer', addedAt: 'date-time' },
          required: ['position', 'addedAt'],
        },
        writePivot: { fields: { position: 'integer' }, required: ['position'] },
        sortable: ['position', '-position'],
        filterable: [],
      },
    },
    paths: {
      fetchMany: '/playlists',
      fetchOne: '/playlists/{id}',
      fetchRelated: '/playlists/{id}/{rel}',
      fetchRelationship: '/playlists/{id}/relationships/{rel}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    relatedQuery: { operations: ['fetchOne'], profile: 'urn:related', relations: ['tracks'] },
  },
} as const satisfies ApiDescriptor

type D = typeof descriptor

const draft = () => openDraft(new QueryClient(), descriptor)

/** An `into` that places nothing. */
const nowhere = (): false => false

/** An `into` written for any descriptor's views. */
const anyViews: Into = (q) => (q.params.sort === 'anything' ? 'end' : false)

// The callbacks below are never called (no query is cached); `tsc` checks their assertions.
describe('typed into', () => {
  it("types an insert's views as its type's collection reads", () => {
    draft().insert('albums', { id: 'new', title: 'Kid A' } as never, (q, member) => {
      expectTypeOf(q).toEqualTypeOf<ListDraftQuery<D, 'albums'>>()
      expectTypeOf(q.operation).toEqualTypeOf<'fetchMany'>()
      expectTypeOf(q.type).toEqualTypeOf<'albums'>()
      expectTypeOf(member.type).toEqualTypeOf<'albums'>()
      expectTypeOf<NonNullable<typeof q.params.filter>>().toHaveProperty('title')
      expectTypeOf<keyof NonNullable<typeof q.params.filter>>().toEqualTypeOf<'title' | 'artist'>()
      // @ts-expect-error albums take no `year` filter
      void q.params.filter?.year
      // @ts-expect-error `-createdd` is no albums sort token
      void (q.params.sort === '-createdd')
      // The design's example compiles as written.
      return q.operation === 'fetchMany' && !q.params.filter && q.params.sort === '-createdAt'
        ? 'start'
        : false
    })
  })

  it("types a relation verb's views by narrowing on the view's type and relation", () => {
    draft().attach('playlists', 'p1', 'tracks', [{ type: 'tracks', id: 't1' }], {
      into: (q, member) => {
        expectTypeOf(q).toEqualTypeOf<DraftQuery<D>>()
        expectTypeOf(member.type).toEqualTypeOf<'tracks'>()
        expectTypeOf(q.type).toEqualTypeOf<'albums' | 'tracks' | 'artists' | 'playlists'>()
        expectTypeOf(q.operation).toEqualTypeOf<
          'fetchMany' | 'fetchOne' | 'fetchRelated' | 'fetchRelationship'
        >()
        // No read of the catalogue sorts by `-createdd`.
        // @ts-expect-error `-createdd` is no sort token of any read
        void (q.params.sort === '-createdd')
        if (q.type === 'playlists' && q.rel === 'tracks') {
          expectTypeOf(q).toEqualTypeOf<RelationDraftQuery<D, 'playlists', 'tracks'>>()
          expectTypeOf(q.params.sort).toEqualTypeOf<
            'position' | '-position' | readonly ('position' | '-position')[] | undefined
          >()
          // A relation recording an empty `filterable` takes no filter.
          expectTypeOf(q.params.filter).toEqualTypeOf<undefined>()
          // @ts-expect-error the playlist's tracks don't sort by title
          void (q.params.sort === 'title')
          return q.params.sort === 'position'
            ? (members) => members.findIndex((m) => m.type === 'tracks')
            : false
        }
        if (q.type === 'playlists' && q.operation === 'fetchOne') {
          // A slot on a cached playlist is ordered by the read's relatedQuery entry.
          return q.params.relatedQuery?.tracks?.sort === '-position' ? 'start' : false
        }
        if (q.type === 'albums' && q.operation === 'fetchMany') {
          expectTypeOf(q.params.sort).toEqualTypeOf<
            | 'title'
            | '-title'
            | 'createdAt'
            | '-createdAt'
            | readonly ('title' | '-title' | 'createdAt' | '-createdAt')[]
            | undefined
          >()
        }
        return false
      },
    })
  })

  it("types the member by the relation's related types for link and replaceMembers", () => {
    draft().link(
      'albums',
      '1',
      'artist',
      { type: 'artists', id: 'a1' },
      {
        into: (q, member) => {
          expectTypeOf(member.type).toEqualTypeOf<'artists'>()
          if (q.type === 'albums' && q.rel === 'artist') {
            // The artists advertise no sort, so neither does the albums' artist read.
            expectTypeOf(q.params.sort).toEqualTypeOf<undefined>()
          }
          return 'end'
        },
      },
    )
    draft().replaceMembers('albums', '1', 'tracks', [], {
      into: (_q, member) => {
        expectTypeOf(member).toEqualTypeOf<DraftMember<'tracks', never>>()
        return false
      },
    })
    // @ts-expect-error albums relate no `members`
    draft().attach('albums', '1', 'members', [])
  })

  it("types a placed member's $pivot from the relation's pivot", () => {
    draft().attach(
      'playlists',
      'p1',
      'tracks',
      [{ type: 'tracks', id: 't1', $pivot: { position: 1 } }],
      {
        into: (q, member) => {
          // The entering member carries the pivot the caller sent, the loaded ones the server's;
          // either may be absent.
          expectTypeOf(member.$pivot?.position).toEqualTypeOf<number | undefined>()
          // @ts-expect-error the entering member may carry no pivot
          void member.$pivot.position
          // @ts-expect-error addedAt is read-only: a request pivot never carries it
          void member.$pivot?.addedAt
          return q.params.sort === 'position'
            ? (members) => {
                expectTypeOf(members[0]!.$pivot?.addedAt).toEqualTypeOf<string | undefined>()
                // @ts-expect-error a loaded member may carry no pivot
                void members[0]!.$pivot.position
                // The design's example, reading the pivot as the client types it.
                return members.findIndex(
                  (m) => (m.$pivot?.position ?? Infinity) > (member.$pivot?.position ?? 0),
                )
              }
            : false
        },
      },
    )
    draft().replaceMembers('playlists', 'p1', 'tracks', [], {
      into: (_q, member) => (members) =>
        members.findIndex((m) => (m.$pivot?.position ?? Infinity) > (member.$pivot?.position ?? 0)),
    })
    draft().attach('albums', '1', 'tracks', [{ type: 'tracks', id: 't1' }], {
      into: (_q, member) => {
        expectTypeOf(member.$pivot).toEqualTypeOf<undefined>()
        // @ts-expect-error the albums' tracks carry no pivot
        void member.$pivot.position
        return (members) => {
          // @ts-expect-error nor do the members already loaded
          void members[0]!.$pivot.position
          return -1
        }
      },
    })
  })

  it("types a placed member's $pivot through the mutation factories", () => {
    const writes = createMutationApi(
      new QueryClient({ mutationCache: new JsonApiMutationCache() }),
      createClient(descriptor, { baseUrl: 'https://api.test' }),
      descriptor,
    )
    writes.playlists
      .id('p1')
      .rel('tracks')
      .add({
        optimistic: {
          into: (q, member) =>
            q.params.sort === 'position'
              ? (members) =>
                  members.findIndex(
                    (m) => (m.$pivot?.position ?? Infinity) > (member.$pivot?.position ?? 0),
                  )
              : false,
        },
      })
    writes.tracks.create({
      attachTo: {
        type: 'playlists',
        id: 'p1',
        rel: 'tracks',
        into: (_q, member) => {
          expectTypeOf(member.$pivot?.position).toEqualTypeOf<number | undefined>()
          return (members) => {
            expectTypeOf(members[0]!.$pivot?.position).toEqualTypeOf<number | undefined>()
            // @ts-expect-error a loaded member may carry no pivot
            void members[0]!.$pivot.position
            return 0
          }
        },
      },
    })
  })

  it("types the draft's own into over every view and member", () => {
    const into: Into<D> = (q, member) => {
      expectTypeOf(q).toEqualTypeOf<DraftQuery<D>>()
      expectTypeOf(member.type).toEqualTypeOf<'albums' | 'tracks' | 'artists' | 'playlists'>()
      return false
    }
    openDraft(new QueryClient(), descriptor, { into })
    // A callback written for any descriptor's views still fits a typed draft.
    openDraft(new QueryClient(), descriptor, { into: anyViews })
    // A typed `into` can be held where a loose one is, as a plan holding it would.
    const relation: RelationInto<D, 'playlists', 'tracks'> = nowhere
    const insert: InsertInto<D, 'albums'> = nowhere
    const held: readonly Into[] = [relation, insert]
    // An insert's `into` for one type doesn't fit another type's insert.
    // @ts-expect-error an albums insert's into
    const misplaced: InsertInto<D, 'tracks'> = insert
    expect([...held, misplaced]).toHaveLength(3)
  })

  it('keeps the loose description over the base descriptor', () => {
    const loose = openDraft(new QueryClient(), descriptor as ApiDescriptor)
    loose.insert('albums', { id: 'new' } as never, (q, member) => {
      expectTypeOf(q).toEqualTypeOf<QueryDescription>()
      expectTypeOf(member.type).toEqualTypeOf<'albums'>()
      return q.params.sort === 'anything' ? 'start' : false
    })
    expect(typeof loose.attach).toBe('function')
  })
})
