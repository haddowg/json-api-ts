/**
 * Test support for the optimistic-lifecycle suites: a small music catalogue served over a mock
 * transport whose requests can be held open, failed or answered `202`, and a QueryClient built with
 * the JsonApiMutationCache. Not shipped: tsdown bundles from `index.ts` only.
 */
import {
  type ApiDescriptor,
  createClient,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { QueryClient, QueryObserver } from '@tanstack/query-core'
import { installNormalization } from './install'
import { type JsonApiMutationCacheConfig, JsonApiMutationCache } from './mutation-cache'

export const BASE = 'https://music.example'

export const descriptor = {
  albums: {
    attributes: { title: 'string', year: 'integer' },
    relations: {
      artist: {
        cardinality: 'one',
        types: ['artists'],
        pivot: false,
        mutations: { set: true },
      },
      tracks: {
        cardinality: 'many',
        types: ['tracks'],
        pivot: false,
        mutations: { add: true, remove: true, replace: true },
      },
    },
    paths: {
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
      fetchRelationship: '/albums/{id}/relationships/{rel}',
      create: '/albums',
      update: '/albums/{id}',
      delete: '/albums/{id}',
    },
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['artist', 'tracks'],
    sortable: ['title', '-title'],
    accepted: { update: { jobType: 'jobs' } },
  },
  tracks: {
    attributes: { title: 'string' },
    relations: {},
    paths: {
      fetchMany: '/tracks',
      fetchOne: '/tracks/{id}',
      create: '/tracks',
      update: '/tracks/{id}',
      delete: '/tracks/{id}',
    },
    paginator: 'page',
    clientId: 'forbidden',
  },
  artists: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchMany: '/artists', fetchOne: '/artists/{id}', create: '/artists' },
    paginator: 'none',
    clientId: 'optional',
  },
  jobs: {
    attributes: { state: 'string' },
    relations: {},
    paths: { fetchOne: '/jobs/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
  labels: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchMany: '/labels', create: '/labels' },
    paginator: 'none',
    clientId: 'required',
  },
} as const satisfies ApiDescriptor

export type Row = Record<string, unknown> & {
  readonly $optimistic?: 'pending'
  $pending(rel: string): readonly { type: string; id: string }[]
}

interface Album {
  title: string
  year: number
  artist: string
  tracks: string[]
}

/** A request held open until the test releases it. */
export interface Held {
  /** Resolves once the request has been made. */
  readonly started: Promise<void>
  release(): void
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers,
  body: body === undefined ? '' : JSON.stringify(body),
})

/** A request's JSON:API document. */
const body = (req: TransportRequest) =>
  (req.body === undefined || req.body === null ? {} : JSON.parse(String(req.body))) as {
    data?: unknown
  }

/** The catalogue, its client and a QueryClient built as an app builds one. */
export function harness(cache: JsonApiMutationCacheConfig = {}) {
  const albums: Record<string, Album> = {
    '1': { title: 'OK Computer', year: 1997, artist: 'a1', tracks: ['t1', 't2'] },
  }
  const tracks: Record<string, { title: string }> = {
    t1: { title: 'Airbag' },
    t2: { title: 'Paranoid Android' },
    t3: { title: 'Lucky' },
  }
  const artists: Record<string, { name: string }> = {
    a1: { name: 'Radiohead' },
    a2: { name: 'Blur' },
  }
  // A label's id is always the client's: the type requires one.
  const labels: Record<string, { name: string }> = {}
  const requests: string[] = []
  const sent = new Map<string, unknown>()
  const holds = new Map<string, { started: () => void; gate: Promise<void> }[]>()
  const failing = new Set<string>()
  let accepting = false
  let created = 0

  const track = (id: string) => ({ type: 'tracks', id, attributes: { ...tracks[id]! } })
  const artist = (id: string) => ({ type: 'artists', id, attributes: { ...artists[id]! } })
  const label = (id: string) => ({ type: 'labels', id, attributes: { ...labels[id]! } })
  const album = (id: string) => {
    const { artist: by, tracks: members, ...attributes } = albums[id]!
    return {
      type: 'albums',
      id,
      attributes,
      relationships: {
        artist: { data: { type: 'artists', id: by } },
        tracks: { data: members.map((t) => ({ type: 'tracks', id: t })) },
      },
    }
  }
  const included = (id: string, params: URLSearchParams) => {
    const include = params.get('include')?.split(',') ?? []
    const { artist: by, tracks: members } = albums[id]!
    return [
      ...(include.includes('artist') ? [artist(by)] : []),
      ...(include.includes('tracks') ? members.map(track) : []),
    ]
  }

  const route = (req: TransportRequest, url: URL): TransportResponse => {
    const path = url.pathname.split('/').filter(Boolean)
    const params = url.searchParams
    const [kind, id, third, fourth] = path
    if (req.method === 'GET') {
      if (kind === 'jobs') {
        return json(303, undefined, { Location: `${BASE}/albums/1` })
      }
      if (kind === 'labels') {
        return json(200, { data: Object.keys(labels).map(label) })
      }
      if (kind === 'albums' && id === undefined) {
        return json(200, { data: Object.keys(albums).map(album) })
      }
      if (kind === 'albums' && albums[id!] === undefined) {
        return json(404, { errors: [{ status: '404' }] })
      }
      if (kind === 'albums' && third === undefined) {
        return json(200, { data: album(id!), included: included(id!, params) })
      }
      if (kind === 'albums' && third === 'relationships') {
        const a = albums[id!]!
        return json(200, {
          data:
            fourth === 'artist'
              ? { type: 'artists', id: a.artist }
              : a.tracks.map((t) => ({ type: 'tracks', id: t })),
        })
      }
      if (kind === 'albums') {
        const a = albums[id!]!
        return json(200, { data: third === 'artist' ? artist(a.artist) : a.tracks.map(track) })
      }
      if (kind === 'tracks' && id === undefined) {
        return json(200, { data: Object.keys(tracks).map(track) })
      }
      if (kind === 'tracks') {
        return tracks[id!] === undefined
          ? json(404, { errors: [{ status: '404' }] })
          : json(200, { data: track(id!) })
      }
      return id === undefined
        ? json(200, { data: Object.keys(artists).map(artist) })
        : json(200, { data: artist(id) })
    }
    const data = body(req).data as
      | { id?: string; attributes?: Record<string, unknown> }
      | { type: string; id: string }[]
      | { type: string; id: string }
      | null
      | undefined
    if (kind === 'albums' && third === 'relationships') {
      const a = albums[id!]!
      if (fourth === 'artist') {
        a.artist = (data as { id: string }).id
        return json(200, { data })
      }
      const refs = (data as { id: string }[]).map((ref) => ref.id)
      if (req.method === 'POST') {
        a.tracks = [...a.tracks, ...refs.filter((t) => !a.tracks.includes(t))]
      } else if (req.method === 'DELETE') {
        a.tracks = a.tracks.filter((t) => !refs.includes(t))
      } else {
        a.tracks = refs
      }
      return req.method === 'PATCH' ? json(200, { data }) : json(204, undefined)
    }
    if (req.method === 'DELETE') {
      if (kind === 'albums') {
        delete albums[id!]
      } else {
        delete tracks[id!]
      }
      return json(204, undefined)
    }
    const write = data as { id?: string; attributes?: Record<string, unknown> }
    if (req.method === 'POST') {
      created += 1
      if (kind === 'labels') {
        if (write.id === undefined) {
          return json(422, { errors: [{ status: '422', detail: 'A label needs a client id.' }] })
        }
        labels[write.id] = { name: String(write.attributes?.['name'] ?? '') }
        return json(201, { data: label(write.id) })
      }
      if (kind === 'artists') {
        const newId = write.id ?? `srv-${created}`
        artists[newId] = { name: String(write.attributes?.['name'] ?? '') }
        return json(201, { data: artist(newId) })
      }
      if (kind === 'tracks') {
        const newId = `srv-${created}`
        tracks[newId] = { title: String(write.attributes?.['title'] ?? '') }
        return json(201, { data: track(newId) })
      }
      const newId = `srv-${created}`
      albums[newId] = {
        title: String(write.attributes?.['title'] ?? ''),
        year: Number(write.attributes?.['year'] ?? 0),
        artist: 'a1',
        tracks: [],
      }
      return json(201, { data: album(newId) })
    }
    // PATCH
    if (kind === 'albums') {
      if (accepting) {
        // The job is done by the time anything polls it.
        Object.assign(albums[id!]!, write.attributes ?? {})
        return json(
          202,
          { data: { type: 'jobs', id: 'j1', attributes: { state: 'queued' } } },
          { 'Content-Location': `${BASE}/jobs/j1`, 'Retry-After': '0' },
        )
      }
      Object.assign(albums[id!]!, write.attributes ?? {})
      return json(200, { data: album(id!) })
    }
    Object.assign(tracks[id!]!, write.attributes ?? {})
    return json(200, { data: track(id!) })
  }

  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    const url = new URL(req.url)
    const key = `${req.method} ${url.pathname.replace(BASE, '')}`
    requests.push(`${key}${url.search}`)
    sent.set(key, req.body)
    // The answer is read when the request is made: a held request answers as the server stood then.
    const answer = failing.has(key)
      ? json(422, { errors: [{ status: '422', code: 'NO' }] })
      : route(req, url)
    const held = holds.get(key)?.shift()
    if (held !== undefined) {
      held.started()
      await held.gate
    }
    return answer
  }

  const client = createClient(descriptor, { baseUrl: BASE, transport })
  const queryClient = new QueryClient({
    mutationCache: new JsonApiMutationCache(cache),
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  })
  installNormalization(queryClient, descriptor)

  return {
    client,
    queryClient,
    albums,
    tracks,
    artists,
    requests,
    /** The body last sent to `METHOD /path`. */
    sent(key: string): unknown {
      return sent.get(key)
    },
    /** Hold the next request to `METHOD /path` open until released. */
    hold(key: string): Held {
      let release!: () => void
      let started!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const begun = new Promise<void>((resolve) => {
        started = resolve
      })
      const list = holds.get(key) ?? []
      list.push({ started, gate })
      holds.set(key, list)
      return { started: begun, release }
    },
    /** Answer `METHOD /path` with a `422` from now on. */
    fail(key: string): void {
      failing.add(key)
    },
    /** Answer album updates with `202 Accepted` from now on. */
    accept(): void {
      accepting = true
    },
    /** Run a mutation-options object through the QueryClient's mutation cache. */
    run<TData, TVars>(options: object, variables: TVars): Promise<TData> {
      return queryClient
        .getMutationCache()
        .build<TData, unknown, TVars, unknown>(queryClient, options as never)
        .execute(variables)
    },
    /** Keep a query observed (active), as a mounted component does. */
    observe(options: object): () => void {
      const observer = new QueryObserver(queryClient, options as never)
      return observer.subscribe(() => {})
    },
    /** The data a read's key holds now. */
    data(options: { queryKey: readonly unknown[] }): unknown {
      return queryClient.getQueryData(options.queryKey as never)
    },
  }
}

/** Let pending promises and timers run. */
export const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const ids = (value: unknown): string[] =>
  (value as Row[]).map((member) => member['id'] as string)
