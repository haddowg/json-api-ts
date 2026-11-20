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
    attributes: { title: 'string', steps: 'array', credits: 'object' },
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
    nestedFieldsets: { credits: '[a-z][a-z_]*' },
    sortable: ['title', '-title'],
    sortFamilies: [{ prefix: 'value', suffixPattern: '[a-z_]+' }],
    filterable: ['title'],
    documentMeta: { delete: { fields: { archived: 'integer' } } },
    requestMeta: { create: { fields: { idempotencyKey: 'string' }, required: [] } },
    resourceMeta: {
      read: { fields: { playCount: 'integer' }, required: [] },
      create: { fields: { source: 'string' }, required: [] },
    },
  },
  artists: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchMany: '/artists', fetchOne: '/artists/{id}' },
    paginator: 'cursor',
    clientId: 'forbidden',
  },
  // The caller's inbox, a singleton served at /inbox with no id.
  inboxes: {
    attributes: { unread: 'integer', seenUpTo: 'date-time' },
    relations: {},
    paths: { fetchOne: '/inbox', update: '/inbox' },
    paginator: 'none',
    clientId: 'forbidden',
    singleton: true,
    documentMeta: { fetchOne: { fields: { etag: 'string' } } },
  },
} as const satisfies ApiDescriptor

/** A structured list element: a discriminated union, as the codegen types one. */
export type Step = { op: 'trim' } | { op: 'replace'; find: string; with?: string }

interface Attributes {
  albums: { title: string; steps: Step[] | null; credits: Record<string, string> | null }
  artists: { name: string }
  inboxes: { unread: number; seenUpTo: string | null }
}

interface WriteAttributes {
  albums: { create: { title: string; steps?: Step[] }; update: { title?: string; steps?: Step[] } }
  artists: { create: Record<string, unknown>; update: Record<string, unknown> }
  inboxes: { update: { seenUpTo?: string } }
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
