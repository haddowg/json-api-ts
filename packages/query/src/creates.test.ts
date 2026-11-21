/**
 * Optimistic creates (design B2a): completion by `complete` and automatic nulls, included relations
 * resolved from the cache, pending entries where the row still can't fit, `withPending`, the list
 * totals, deferred relation members carrying data, and the development warning.
 */
import {
  type ApiDescriptor,
  createClient,
  type DefaultActionTypes,
  type PendingCreate,
  type PendingMember,
  type TransportRequest,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { InfiniteQueryObserver, QueryClient, QueryObserver } from '@tanstack/query-core'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { openDraft } from './draft'
import { installNormalization } from './install'
import { type CreateCompletion, createMutationApi, type ServerOnly } from './mutate'
import { JsonApiMutationCache } from './mutation-cache'
import { type PendingCreateOf, withPending } from './pending'
import { createQueryApi, getQueryOptions, infiniteListQueryOptions, listQueryOptions } from './read'

const BASE = 'https://music.example'

const descriptor = {
  playlists: {
    attributes: {
      title: 'string',
      public: 'boolean',
      slug: 'string',
      externalId: 'string',
      createdAt: 'date-time',
    },
    relations: {
      owner: { cardinality: 'one', types: ['accounts'], pivot: false },
      tracks: {
        cardinality: 'many',
        types: ['tracks'],
        pivot: false,
        mutations: { add: true, remove: true, replace: true },
      },
    },
    paths: {
      fetchMany: '/playlists',
      fetchOne: '/playlists/{id}',
      fetchRelated: '/playlists/{id}/{rel}',
      fetchRelationship: '/playlists/{id}/relationships/{rel}',
      create: '/playlists',
    },
    paginator: 'page',
    clientId: 'forbidden',
    serverOnly: ['slug', 'externalId', 'createdAt'],
    nullable: ['externalId', 'createdAt'],
    includable: ['owner', 'tracks'],
  },
  accounts: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchMany: '/accounts', fetchOne: '/accounts/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
  tracks: {
    attributes: { title: 'string', duration: 'integer' },
    relations: {},
    paths: { fetchMany: '/tracks', fetchOne: '/tracks/{id}', create: '/tracks' },
    paginator: 'page',
    clientId: 'optional',
  },
} as const satisfies ApiDescriptor
type D = typeof descriptor

interface Attributes {
  playlists: {
    title: string
    public: boolean
    slug: string
    externalId: string | null
    createdAt: string | null
  }
  accounts: { name: string }
  tracks: { title: string; duration: number }
}

interface WriteAttributes {
  playlists: {
    create: { title: string; public?: boolean }
    update: { title?: string; public?: boolean }
  }
  accounts: { create: { name: string }; update: { name?: string } }
  tracks: {
    create: { title: string; duration: number }
    update: { title?: string; duration?: number }
  }
}

interface Playlist {
  title: string
  public: boolean
  slug: string
  externalId: string | null
  createdAt: string | null
  owner: string
  tracks: string[]
}

const json = (status: number, body: unknown): TransportResponse => ({
  status,
  headers: {},
  body: body === undefined ? '' : JSON.stringify(body),
})

/** A stored playlist, as the server first makes it. */
function stored(title: string): Playlist {
  return {
    title,
    public: true,
    slug: title.toLowerCase(),
    externalId: null,
    createdAt: null,
    owner: 'a1',
    tracks: ['t1'],
  }
}

interface ResourceObject {
  type: string
  id: string
  attributes: Record<string, unknown>
  relationships: Record<string, unknown>
}

/** A resource object with only the members a sparse fieldset selects. */
function sparse(value: ResourceObject, fields: string[] | undefined): ResourceObject {
  return fields === undefined
    ? value
    : {
        ...value,
        attributes: Object.fromEntries(
          Object.entries(value.attributes).filter(([key]) => fields.includes(key)),
        ),
        relationships: Object.fromEntries(
          Object.entries(value.relationships).filter(([key]) => fields.includes(key)),
        ),
      }
}

/** A playlist server: a paged, counted list, an `owner` include, and holdable, failable writes. */
function server() {
  const playlists: Record<string, Playlist> = {
    p1: stored('Morning'),
    p2: stored('Evening'),
    p3: stored('Night'),
  }
  const accounts: Record<string, { name: string }> = { a1: { name: 'Ada' } }
  const tracks: Record<string, { title: string; duration: number }> = {
    t1: { title: 'Airbag', duration: 284 },
  }
  const holds = new Map<string, Promise<void>[]>()
  const failing = new Set<string>()
  let created = 0

  const resource = (id: string): ResourceObject => {
    const { owner, tracks: members, ...attributes } = playlists[id]!
    return {
      type: 'playlists',
      id,
      attributes,
      relationships: {
        owner: { data: { type: 'accounts', id: owner } },
        tracks: { data: members.map((t) => ({ type: 'tracks', id: t })) },
      },
    }
  }
  const route = (req: TransportRequest, url: URL): TransportResponse => {
    const [kind, id] = url.pathname.split('/').filter(Boolean)
    const params = url.searchParams
    if (req.method === 'GET' && kind === 'playlists' && id === undefined) {
      const all = Object.keys(playlists)
      const size = Number(params.get('page[size]') ?? String(all.length))
      const number = Number(params.get('page[number]') ?? '1')
      const window = all.slice((number - 1) * size, number * size)
      const fields = params.get('fields[playlists]')?.split(',')
      const include = params.get('include')?.split(',') ?? []
      const link = (n: number) =>
        `${BASE}/playlists?page%5Bnumber%5D=${n}&page%5Bsize%5D=${size}${
          include.length > 0 ? `&include=${include.join(',')}` : ''
        }`
      return json(200, {
        data: window.map((p) => sparse(resource(p), fields)),
        included: include.includes('owner')
          ? [{ type: 'accounts', id: 'a1', attributes: accounts['a1'] }]
          : [],
        links: {
          ...(number > 1 ? { prev: link(number - 1) } : {}),
          ...(number * size < all.length ? { next: link(number + 1) } : {}),
        },
        meta: {
          total: all.length,
          page: { currentPage: number, perPage: size, total: all.length },
        },
      })
    }
    if (req.method === 'GET' && kind === 'playlists') {
      const include = params.get('include')?.split(',') ?? []
      return json(200, {
        data: resource(id!),
        included: include.includes('tracks')
          ? playlists[id!]!.tracks.map((t) => ({ type: 'tracks', id: t, attributes: tracks[t] }))
          : [],
      })
    }
    if (req.method === 'GET' && kind === 'accounts') {
      return json(200, { data: { type: 'accounts', id, attributes: accounts[id!] } })
    }
    if (req.method === 'POST' && kind === 'playlists') {
      created += 1
      const data = (JSON.parse(String(req.body)) as { data: { attributes: { title: string } } })
        .data
      const newId = `srv-${created}`
      playlists[newId] = stored(data.attributes.title)
      return json(201, { data: resource(newId) })
    }
    return json(404, { errors: [{ status: '404' }] })
  }

  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    const url = new URL(req.url)
    const key = `${req.method} ${url.pathname}`
    const answer = failing.has(key) ? json(422, { errors: [{ status: '422' }] }) : route(req, url)
    const gate = holds.get(key)?.shift()
    if (gate !== undefined) {
      await gate
    }
    return answer
  }

  const client = createClient<D, Attributes, WriteAttributes, DefaultActionTypes, string>(
    descriptor,
    { baseUrl: BASE, transport },
  )
  const queryClient = new QueryClient({
    mutationCache: new JsonApiMutationCache(),
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  })
  installNormalization(queryClient, descriptor)
  const writes = createMutationApi(queryClient, client, descriptor)
  const reads = createQueryApi(client)

  return {
    client,
    queryClient,
    writes,
    reads,
    playlists,
    /** Hold the next `METHOD /path` request open until the returned function is called. */
    hold(key: string): () => void {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      holds.set(key, [...(holds.get(key) ?? []), gate])
      return release
    },
    fail(key: string): void {
      failing.add(key)
    },
    run<TVars>(options: object, variables: TVars): Promise<unknown> {
      return queryClient
        .getMutationCache()
        .build<unknown, unknown, TVars, unknown>(queryClient, options as never)
        .execute(variables)
    },
    observe(options: object): () => void {
      return new QueryObserver(queryClient, options as never).subscribe(() => {})
    },
    data(options: { queryKey: readonly unknown[] }): unknown {
      return queryClient.getQueryData(options.queryKey as never)
    },
  }
}

type Row = Record<string, unknown> & { readonly $optimistic?: 'pending' }
type List = readonly Row[] & {
  $pending(): readonly PendingCreate[]
  readonly $page: { meta?: Record<string, unknown> }
  readonly $meta: Record<string, unknown> | undefined
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const ids = (list: unknown): string[] => (list as Row[]).map((row) => row['id'] as string)
const slug = (title: string): string => title.toLowerCase().replaceAll(' ', '-')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('completion', () => {
  it('completes a row from complete and automatic nulls, so it joins a list of whole playlists', async () => {
    const s = server()
    const list = listQueryOptions(s.client, 'playlists')
    await s.queryClient.fetchQuery(list)
    const stop = s.observe(list)
    const release = s.hold('POST /playlists')
    const complete = vi.fn((input: { title: string }) => ({ slug: slug(input.title) }))
    const pending = s.run(
      s.writes.playlists.create({ optimistic: { into: () => 'start', complete } }),
      { title: 'Road Trip', public: true },
    )
    await tick()

    const rows = s.data(list) as List
    expect(rows).toHaveLength(4)
    const row = rows[0]!
    // `complete` gave the slug; externalId and createdAt are nullable server-only attributes.
    expect({ ...row }).toMatchObject({
      type: 'playlists',
      title: 'Road Trip',
      slug: 'road-trip',
      externalId: null,
      createdAt: null,
    })
    expect(row.$optimistic).toBe('pending')
    expect(rows.$pending()).toEqual([])
    expect(complete).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledWith({ title: 'Road Trip', public: true })
    // The list's totals count the new member.
    expect(rows.$page.meta?.['total']).toBe(4)
    expect(rows.$meta?.['total']).toBe(4)

    release()
    await pending
    const after = s.data(list) as List
    expect(after.map((r) => r['title'])).toContain('Road Trip')
    expect(after.$page.meta?.['total']).toBe(4)
    expect(after.some((r) => r.$optimistic === 'pending')).toBe(false)
    stop()
  })

  it('completes nullable server-only attributes to null on its own', async () => {
    const s = server()
    const list = listQueryOptions(s.client, 'playlists', {
      fields: { playlists: ['title', 'externalId'] },
    })
    await s.queryClient.fetchQuery(list)
    const release = s.hold('POST /playlists')
    const pending = s.run(s.writes.playlists.create({ optimistic: { into: () => 'end' } }), {
      title: 'Focus',
    })
    await tick()
    const rows = s.data(list) as List
    expect({ ...rows.at(-1)! }).toEqual({
      type: 'playlists',
      id: expect.stringMatching(/^\$tmp:/),
      title: 'Focus',
      externalId: null,
    })
    release()
    await pending
  })

  it('types complete by the read attributes the create input lacks', () => {
    type Completion = ServerOnly<Attributes, WriteAttributes, 'playlists'>
    // `slug` is required; the nullable ones are optional, completing to null on their own.
    expectTypeOf<{ slug: string }>().toExtend<Completion>()
    expectTypeOf<{
      slug: string
      externalId: string | null
      createdAt: null
    }>().toExtend<Completion>()
    expectTypeOf<{ externalId: null }>().not.toExtend<Completion>()
    expectTypeOf<{ slug: number }>().not.toExtend<Completion>()
    // A type whose create supplies every read attribute completes nothing.
    expectTypeOf<ServerOnly<Attributes, WriteAttributes, 'tracks'>>().toEqualTypeOf<{} & {}>()
    // Without generated types it is an open record.
    expectTypeOf<ServerOnly<unknown, unknown, 'playlists'>>().toEqualTypeOf<
      Readonly<Record<string, unknown>>
    >()

    const s = server()
    s.writes.playlists.create({
      optimistic: { complete: (input) => ({ slug: slug(input.title) }) },
    })
    s.writes.playlists.create({
      // @ts-expect-error -- `slug` is a required server-only attribute
      optimistic: { complete: () => ({ externalId: null }) },
    })
    s.writes.playlists.create({
      // @ts-expect-error -- `title` is required in the input, whose value always wins
      optimistic: { complete: (input) => ({ slug: input.title, title: input.title }) },
    })
    // An optional create attribute the read renders may be completed, typed as the read says.
    s.writes.playlists.create({
      optimistic: {
        complete: (input) => ({ slug: slug(input.title), public: input.public ?? false }),
      },
    })
    s.writes.playlists.create({
      // @ts-expect-error -- `public` reads as a boolean
      optimistic: { complete: (input) => ({ slug: input.title, public: 'yes' }) },
    })
  })

  it('types the completion as server-only plus optional creatable attributes', () => {
    type Completion = CreateCompletion<Attributes, WriteAttributes, 'playlists'>
    expectTypeOf<{ slug: string }>().toExtend<Completion>()
    expectTypeOf<{ slug: string; public: boolean }>().toExtend<Completion>()
    expectTypeOf<{ slug: string; public: string }>().not.toExtend<Completion>()
    expectTypeOf<{ slug: string; title: string }>().not.toExtend<Completion>()
    expectTypeOf<{ public: boolean }>().not.toExtend<Completion>()
    expectTypeOf<CreateCompletion<unknown, unknown, 'playlists'>>().toEqualTypeOf<
      Readonly<Record<string, unknown>>
    >()
  })

  it('completes an optional create attribute the input left out, the input’s value winning', async () => {
    const s = server()
    const list = listQueryOptions(s.client, 'playlists')
    await s.queryClient.fetchQuery(list)
    const releases = [s.hold('POST /playlists'), s.hold('POST /playlists')]
    const create = s.writes.playlists.create({
      optimistic: {
        into: () => 'start',
        complete: (input) => ({ slug: slug(input.title), public: input.public ?? false }),
      },
    })
    // No `public` in the input: `complete` supplies it, so the row joins the full list.
    const omitted = s.run(create, { title: 'Quiet' })
    // A `public` in the input wins over anything `complete` returns for it.
    const given = s.run(
      s.writes.playlists.create({
        optimistic: {
          into: () => 'start',
          complete: () => ({ slug: 'loud', public: false }),
        },
      }),
      { title: 'Loud', public: true },
    )
    await tick()
    const rows = s.data(list) as List
    expect(rows.$pending()).toEqual([])
    const quiet = rows.find((row) => row['title'] === 'Quiet')!
    expect({ ...quiet }).toMatchObject({ public: false, slug: 'quiet', externalId: null })
    expect(quiet.$optimistic).toBe('pending')
    expect(rows.find((row) => row['title'] === 'Loud')?.['public']).toBe(true)
    releases.forEach((release) => release())
    await Promise.all([omitted, given])
  })

  it('resolves an included relation from the cache by the input’s ref', async () => {
    const s = server()
    const list = listQueryOptions(s.client, 'playlists', { include: ['owner'] })
    await s.queryClient.fetchQuery(list)
    const releases = [s.hold('POST /playlists'), s.hold('POST /playlists')]
    const create = s.writes.playlists.create({
      optimistic: { into: () => 'start', complete: (input) => ({ slug: slug(input.title) }) },
    })
    const pending = s.run(create, {
      title: 'Mine',
      public: true,
      owner: { type: 'accounts', id: 'a1' },
    })
    // An owner nothing caches can't be resolved, so that row is pending instead.
    const stranger = s.run(create, {
      title: 'Theirs',
      public: true,
      owner: { type: 'accounts', id: 'a9' },
    })
    await tick()
    const rows = s.data(list) as List
    const mine = rows.find((row) => row['title'] === 'Mine') as Row & { owner: Row }
    expect(mine.owner['name']).toBe('Ada')
    expect(rows.find((row) => row['title'] === 'Theirs')).toBeUndefined()
    expect(rows.$pending().map((entry) => entry.input['title'])).toEqual(['Theirs'])
    releases.forEach((release) => release())
    await Promise.allSettled([pending, stranger])
  })
})

describe('pending entries', () => {
  it('keeps a row it can’t complete as a pending entry where into placed it, rolled back on error', async () => {
    const s = server()
    const list = listQueryOptions(s.client, 'playlists')
    await s.queryClient.fetchQuery(list)
    const stop = s.observe(list)
    s.fail('POST /playlists')
    const release = s.hold('POST /playlists')
    const pending = s.run(s.writes.playlists.create({ optimistic: { into: () => 1 } }), {
      title: 'Untitled',
      public: false,
    })
    await tick()

    const rows = s.data(list) as List
    // No `complete` for `slug`: the list's members stay honest, and the create is pending.
    expect(ids(rows)).toEqual(['p1', 'p2', 'p3'])
    const [entry] = rows.$pending()
    expect(entry).toEqual({
      type: 'playlists',
      id: expect.stringMatching(/^\$tmp:/),
      at: 1,
      input: { title: 'Untitled', public: false },
    })
    expect(rows.$page.meta?.['total']).toBe(4)
    expect(rows.$meta?.['total']).toBe(4)
    expect(withPending(rows, (p) => `[${String(p.input['title'])}]`).map(label)).toEqual([
      'Morning',
      '[Untitled]',
      'Evening',
      'Night',
    ])

    release()
    await expect(pending).rejects.toBeDefined()
    const after = s.data(list) as List
    expect(after.$pending()).toEqual([])
    expect(after.$page.meta?.['total']).toBe(3)
    stop()
  })

  it('clears on settle, when the refetch brings the server’s row, its id swapped meanwhile', async () => {
    const s = server()
    const list = listQueryOptions(s.client, 'playlists')
    await s.queryClient.fetchQuery(list)
    const stop = s.observe(list)
    const write = s.hold('POST /playlists')
    const variables: Record<string, unknown> = { title: 'Later' }
    const pending = s.run(
      s.writes.playlists.create({ optimistic: { into: () => 'end' } }),
      variables,
    )
    await tick()
    expect((s.data(list) as List).$pending().map((entry) => entry.id)).toEqual([
      variables['$tempId'],
    ])

    // Between success and settle the pending entry already carries the server's id.
    const refetch = s.hold('GET /playlists')
    write()
    await vi.waitFor(() =>
      expect((s.data(list) as List).$pending().map((entry) => entry.id)).toEqual(['srv-1']),
    )
    refetch()
    await pending
    const after = s.data(list) as List
    expect(after.$pending()).toEqual([])
    expect(ids(after)).toEqual(['p1', 'p2', 'p3', 'srv-1'])
    expect(after.$page.meta?.['total']).toBe(4)
    stop()
  })

  it('rides the page it was placed on in an infinite list, which withPending merges in order', async () => {
    const s = server()
    const infinite = infiniteListQueryOptions(s.client, 'playlists', { page: { size: 2 } })
    const observer = new InfiniteQueryObserver(s.queryClient, infinite as never)
    const stop = observer.subscribe(() => {})
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toBeDefined())
    await observer.fetchNextPage()
    const releases = [s.hold('POST /playlists'), s.hold('POST /playlists')]
    const create = s.writes.playlists.create({
      optimistic: {
        into: (q) => (q.params.page === undefined ? false : 'end'),
      },
    })
    const first = s.run(s.writes.playlists.create({ optimistic: { into: () => 'start' } }), {
      title: 'First',
    })
    const last = s.run(create, { title: 'Last' })
    await tick()

    const data = s.data(infinite) as { pages: List[] }
    expect(data.pages.map((page) => page.$pending().map((entry) => entry.input['title']))).toEqual([
      ['First'],
      ['Last'],
    ])
    // Every page reports the list's total, moved by both.
    expect(data.pages.map((page) => page.$page.meta?.['total'])).toEqual([5, 5])
    const merged = withPending(data, (p) => `[${String(p.input['title'])}]`)
    expect(merged.map(label)).toEqual(['[First]', 'Morning', 'Evening', 'Night', '[Last]'])
    releases.forEach((release) => release())
    await Promise.all([first, last])
    stop()
  })
})

const entry = (id: string, at: PendingCreate['at']): PendingCreate => ({
  type: 'rows',
  id,
  at,
  input: {},
})

describe('withPending', () => {
  it('orders placeholders by placement: start, an index, end; same place in creation order', () => {
    const members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const list = Object.assign([...members], {
      $pending: () => [
        entry('e1', 'end'),
        entry('s1', 'start'),
        entry('i1', 1),
        entry('s2', 'start'),
        entry('i9', 9),
        entry('i0', 0),
      ],
    })
    expect(withPending(list, (p) => ({ id: `+${p.id}` })).map((row) => row.id)).toEqual([
      '+s1',
      '+s2',
      '+i0',
      'a',
      '+i1',
      'b',
      'c',
      '+e1',
      '+i9',
    ])
    // A list with nothing pending, or no `$pending` at all, is copied as it is.
    expect(withPending(members, () => null)).toEqual(members)
  })

  it('types the rows as members or placeholders, and takes a typed placeholder', async () => {
    const s = server()
    const list = await s.queryClient.fetchQuery(s.reads.playlists.list())
    const rows = withPending(list, (pending: PendingCreateOf<D, WriteAttributes, 'playlists'>) => ({
      skeleton: true as const,
      title: pending.input.title,
    }))
    expectTypeOf(rows).toEqualTypeOf<
      Array<(typeof list)[number] | { skeleton: true; title: string }>
    >()
    expectTypeOf(list.$pending).toEqualTypeOf<
      (() => readonly PendingCreate<Readonly<Record<string, unknown>>, 'playlists'>[]) | undefined
    >()
  })
})

describe('deferred relation members', () => {
  it('carry the member the caller supplied, so a placeholder can show it', async () => {
    const s = server()
    const get = getQueryOptions(s.client, 'playlists', 'p1', { include: ['tracks'] })
    await s.queryClient.fetchQuery(get)
    const draft = openDraft(s.queryClient, descriptor)
    // Neither copy holds `duration`, so neither fills the included slot.
    draft.attach('playlists', 'p1', 'tracks', [
      { type: 'tracks', id: 't7', title: 'Lucky' },
      { type: 'tracks', id: 't8' },
    ])
    const playlist = s.data(get) as Row & { $pending(rel: string): readonly PendingMember[] }
    expect(playlist.$pending('tracks')).toEqual([
      { type: 'tracks', id: 't7', member: { type: 'tracks', id: 't7', title: 'Lucky' } },
      { type: 'tracks', id: 't8' },
    ])
    expectTypeOf<PendingMember>().toExtend<{ type: string; id: string }>()
    draft.rollback()
    expect(playlist.$pending('tracks')).toEqual([])
  })

  it('carry a created resource’s input when attachTo defers it', async () => {
    const s = server()
    const get = getQueryOptions(s.client, 'playlists', 'p1', { include: ['tracks'] })
    await s.queryClient.fetchQuery(get)
    const draft = openDraft(s.queryClient, descriptor)
    draft.insert('tracks', { id: 't9', title: 'Half' } as never)
    draft.attach('playlists', 'p1', 'tracks', [{ type: 'tracks', id: 't9', title: 'Half' }])
    const playlist = s.data(get) as Row & { $pending(rel: string): readonly PendingMember[] }
    expect(playlist.$pending('tracks')).toEqual([
      { type: 'tracks', id: 't9', member: { id: 't9', title: 'Half' } },
    ])
    draft.rollback()
  })
})

describe('the placed-nowhere warning', () => {
  it('warns once per create placed nowhere, naming the type and why', async () => {
    const s = server()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // No list cached.
    await s.run(s.writes.playlists.create({ optimistic: { into: () => 'start' } }), { title: 'A' })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toContain('an optimistic create of playlists')
    expect(warn.mock.calls[0]![0]).toContain('no list of playlists is cached')

    // `into` places it nowhere.
    await s.queryClient.fetchQuery(listQueryOptions(s.client, 'playlists'))
    await s.run(s.writes.playlists.create({ optimistic: { into: () => false } }), { title: 'B' })
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[1]![0]).toContain('`into` placed it in none of the 1 cached list')

    // No `into` at all.
    await s.run(s.writes.playlists.create({ optimistic: true }), { title: 'C' })
    expect(warn).toHaveBeenCalledTimes(3)
    expect(warn.mock.calls[2]![0]).toContain('no `into` was given')

    // Placed (as a pending entry, even): no warning.
    await s.run(s.writes.playlists.create({ optimistic: { into: () => 'start' } }), { title: 'D' })
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('stays silent in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const s = server()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await s.run(s.writes.playlists.create({ optimistic: true }), { title: 'A' })
    expect(warn).not.toHaveBeenCalled()
  })
})

function label(row: unknown): string {
  return typeof row === 'string' ? row : String((row as Row)['title'])
}
