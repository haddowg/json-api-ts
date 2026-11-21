// Type-level proofs: what TanStack's own inject functions infer from the bound factories. The
// functions below are never called (the inject functions need an injection context); `tsc` checks
// their assertions.
import { signal } from '@angular/core'
import type { JsonApiError } from '@haddowg/json-api-client'
import {
  createMutationApi,
  createQueryApi,
  type InfiniteQueryOptions,
  type MutationError,
  type MutationOptions,
  type ReadError,
} from '@haddowg/json-api-query'
import {
  injectInfiniteQuery,
  injectMutation,
  injectQuery,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/angular-query'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createJsonApiClientToken } from '../provide'
import {
  type AdminErrorCode,
  type createAdminClient,
  descriptor,
  type MusicClient,
  type Step,
} from '../test-api'
import { asJsonApiError } from './error'
import {
  injectJsonApiReads,
  injectJsonApiWrites,
  type JsonApiReads,
  type JsonApiWrites,
} from './provide'

type AdminClient = ReturnType<typeof createAdminClient>
const ADMIN = createJsonApiClientToken<AdminClient>('AdminApi')

declare const musicClient: MusicClient
declare const adminClient: AdminClient
declare const queryClient: QueryClient

function boundApis(): void {
  const direct = createQueryApi(musicClient)
  const directWrites = createMutationApi(queryClient, musicClient, descriptor)
  expectTypeOf<JsonApiReads<MusicClient>>().toEqualTypeOf<typeof direct>()
  expectTypeOf<JsonApiWrites<MusicClient>>().toEqualTypeOf<typeof directWrites>()

  const adminDirect = createQueryApi(adminClient)
  expectTypeOf<JsonApiReads<AdminClient>>().toEqualTypeOf<typeof adminDirect>()

  // Without a token: the client `Register` declares. With one: that token's client.
  expectTypeOf(injectJsonApiReads()).toEqualTypeOf<JsonApiReads<MusicClient>>()
  expectTypeOf(injectJsonApiReads(ADMIN)).toEqualTypeOf<JsonApiReads<AdminClient>>()
  expectTypeOf(injectJsonApiWrites()).toEqualTypeOf<JsonApiWrites<MusicClient>>()
  expectTypeOf(injectJsonApiWrites(ADMIN)).toEqualTypeOf<JsonApiWrites<AdminClient>>()
}

function narrowedQuery(): void {
  const reads = injectJsonApiReads()
  const id = signal('1')
  const read = () =>
    reads.albums.get(id(), { include: ['artist'], fields: { albums: ['title', 'artist'] } })
  const album = injectQuery(read)
  const data = album.data()
  expectTypeOf(data).toEqualTypeOf<
    Awaited<ReturnType<ReturnType<typeof read>['queryFn']>> | undefined
  >()
  if (data !== undefined) {
    expectTypeOf(data.title).toEqualTypeOf<string>()
    expectTypeOf(data.artist?.name).toEqualTypeOf<string | undefined>()
    // `steps` isn't in the sparse fieldset, so it isn't on the view.
    expectTypeOf(data).not.toHaveProperty('steps')
  }
  expectTypeOf(album.error()).toEqualTypeOf<ReadError | null>()

  // Another server's client carries its own codes into error() and the error pipe's result.
  const admin = injectJsonApiReads(ADMIN)
  const adminAlbum = injectQuery(() => admin.albums.get(id()))
  expectTypeOf(adminAlbum.error()).toEqualTypeOf<ReadError<AdminErrorCode> | null>()
  expectTypeOf(asJsonApiError(adminAlbum.error())).toEqualTypeOf<
    JsonApiError<AdminErrorCode> | undefined
  >()
}

function infiniteQuery(): void {
  const reads = injectJsonApiReads()
  const read = () => reads.albums.infinite({ page: { size: 10 } })
  const albums = injectInfiniteQuery(read)
  type Options = ReturnType<typeof read>
  type Page = Options extends InfiniteQueryOptions<infer R, infer _P, infer _E> ? R : never
  // TanStack's own default for an infinite query's data leaves the page params `unknown`.
  expectTypeOf(albums.data()).toEqualTypeOf<InfiniteData<Page> | undefined>()
  const page = albums.data()?.pages[0]
  if (page !== undefined) {
    expectTypeOf(page[0]!.title).toEqualTypeOf<string>()
    expectTypeOf(page.$page.kind).toEqualTypeOf<'page'>()
  }
  expectTypeOf(albums.error()).toEqualTypeOf<ReadError | null>()
}

function spreadMutation(): void {
  const writes = injectJsonApiWrites()
  const id = signal('1')
  const update = () => writes.albums.id(id()).update({ optimistic: true })
  type Variables = ReturnType<typeof update> extends MutationOptions<infer _D, infer V> ? V : never
  const rename = injectMutation(() => ({
    ...update(),
    onSuccess: (album, variables) => {
      expectTypeOf(album.title).toEqualTypeOf<string>()
      expectTypeOf(variables).toEqualTypeOf<Variables>()
    },
  }))
  expectTypeOf(rename.mutate).parameter(0).toEqualTypeOf<Variables>()
  expectTypeOf<Variables['title']>().toEqualTypeOf<string | undefined>()
  expectTypeOf<Variables['steps']>().toEqualTypeOf<Step[] | undefined>()
  expectTypeOf(rename.data()?.title).toEqualTypeOf<string | undefined>()
  expectTypeOf(rename.error()).toEqualTypeOf<MutationError | null>()

  // Another server's client carries its own codes into a write's error() too.
  const adminWrites = injectJsonApiWrites(ADMIN)
  const adminRename = injectMutation(() => adminWrites.albums.id(id()).update())
  expectTypeOf(adminRename.error()).toEqualTypeOf<MutationError<AdminErrorCode> | null>()
  expectTypeOf(asJsonApiError(adminRename.error())).toEqualTypeOf<
    JsonApiError<AdminErrorCode> | undefined
  >()
}

describe('typing', () => {
  it('types the injected factories as the bound APIs over the same client', () => {
    expect(typeof boundApis).toBe('function')
  })

  it('narrows injectQuery data by include and fields, and types error() by the error codes', () => {
    expect(typeof narrowedQuery).toBe('function')
  })

  it('types an infinite read page by page', () => {
    expect(typeof infiniteQuery).toBe('function')
  })

  it('types a spread mutation, its variables and its callbacks', () => {
    expect(typeof spreadMutation).toBe('function')
  })
})
