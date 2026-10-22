// A small descriptor-bound client for the tests, shaped like the codegen's output.
import { type ApiDescriptor, type ClientOptions, createClient } from '@haddowg/json-api-client'

export const BASE = 'https://music.example'

const descriptor = {
  albums: {
    attributes: { title: 'string' },
    relations: { artist: { cardinality: 'one', types: ['artists'], pivot: false } },
    paths: {
      create: '/albums',
      update: '/albums/{id}',
      delete: '/albums/{id}',
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['artist'],
    sortable: ['title', '-title'],
    filterable: ['title'],
  },
  artists: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchMany: '/artists', fetchOne: '/artists/{id}' },
    paginator: 'cursor',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

interface Attributes {
  albums: { title: string }
  artists: { name: string }
}

export const createMusicClient = (options: ClientOptions) =>
  createClient<typeof descriptor, Attributes>(descriptor, options)
export const createAdminClient = (options: ClientOptions) =>
  createClient<typeof descriptor, Attributes>(descriptor, options)

export type MusicClient = ReturnType<typeof createMusicClient>
export type MusicDescriptor = typeof descriptor

declare module './provide' {
  interface Register {
    client: MusicClient
  }
}

export const album = (id: string, title: string) => ({
  type: 'albums',
  id,
  attributes: { title },
})

export const albumDocument = (id: string, title: string): string =>
  JSON.stringify({ data: album(id, title) })

export const albumsPage = (
  albums: ReturnType<typeof album>[],
  links: { next?: string; prev?: string } = {},
): string => JSON.stringify({ data: albums, links: { self: `${BASE}/albums`, ...links } })

/** Let the resource's effect run and the client's promise chain reach the transport. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
