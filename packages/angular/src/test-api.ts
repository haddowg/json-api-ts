// A small descriptor-bound client for the tests, shaped like the codegen's output.
import {
  type ApiDescriptor,
  type ClientOptions,
  createClient,
  type DefaultActionTypes,
} from '@haddowg/json-api-client'

export const BASE = 'https://music.example'

const descriptor = {
  albums: {
    attributes: { title: 'string', steps: 'array' },
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
    sortFamilies: [{ prefix: 'value', suffixPattern: '[a-z_]+' }],
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

/** A structured list element: a discriminated union, as the codegen types one. */
export type Step = { op: 'trim' } | { op: 'replace'; find: string; with?: string }

interface Attributes {
  albums: { title: string; steps: Step[] | null }
  artists: { name: string }
}

interface WriteAttributes {
  albums: { create: { title: string; steps?: Step[] }; update: { title?: string; steps?: Step[] } }
  artists: { create: Record<string, unknown>; update: Record<string, unknown> }
}

export const createMusicClient = (options: ClientOptions) =>
  createClient<typeof descriptor, Attributes, WriteAttributes>(descriptor, options)
/** The admin server documents error codes, as a generated client would carry them. */
export type AdminErrorCode = 'ACCESS_DENIED' | 'RESOURCE_NOT_FOUND'

export const createAdminClient = (options: ClientOptions) =>
  createClient<typeof descriptor, Attributes, WriteAttributes, DefaultActionTypes, AdminErrorCode>(
    descriptor,
    options,
  )

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
