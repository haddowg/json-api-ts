/**
 * A focused JSON:API request handler over the {@link MockStore}. It supports exactly the query
 * patterns the app uses — collection list (filter/sort/page/include/fields), get-one (+include),
 * related/relationship reads, create/update/delete, and relationship add/remove/replace including
 * the pivot `position`. It returns JSON:API documents shaped like the real bundle's.
 */
import type { TransportRequest, TransportResponse } from '@haddowg/json-api-client'
import type { MockStore, Resource, ResourceIdentifier } from './store'

const SELF = 'https://music.example'

interface ParsedUrl {
  segments: string[]
  filter: Record<string, string>
  sort: string[]
  include: string[]
  fields: Record<string, string[]>
  page: { number?: number; size?: number }
}

function parseUrl(url: string): ParsedUrl {
  const u = new URL(url, SELF)
  const segments = u.pathname.split('/').filter(Boolean)
  const filter: Record<string, string> = {}
  const fields: Record<string, string[]> = {}
  const page: ParsedUrl['page'] = {}
  let sort: string[] = []
  let include: string[] = []

  for (const [key, value] of u.searchParams.entries()) {
    const bracket = /^(\w+)\[(.+)\]$/.exec(key)
    if (bracket) {
      const [, family, inner] = bracket
      if (family === 'filter') filter[inner!] = value
      else if (family === 'fields') fields[inner!] = value.split(',').filter(Boolean)
      else if (family === 'page' && inner === 'number') page.number = Number(value)
      else if (family === 'page' && inner === 'size') page.size = Number(value)
    } else if (key === 'sort') {
      sort = value.split(',').filter(Boolean)
    } else if (key === 'include') {
      include = value.split(',').filter(Boolean)
    }
  }

  return { segments, filter, sort, include, fields, page }
}

const ok = (body: unknown, status = 200): TransportResponse => ({
  status,
  headers: { 'Content-Type': 'application/vnd.api+json' },
  body: JSON.stringify(body),
})

const noContent = (): TransportResponse => ({ status: 204, headers: {}, body: '' })

const error = (status: number, detail: string, pointer?: string): TransportResponse => ({
  status,
  headers: { 'Content-Type': 'application/vnd.api+json' },
  body: JSON.stringify({
    errors: [{ status: String(status), detail, ...(pointer ? { source: { pointer } } : {}) }],
  }),
})

/** Apply sparse fieldsets to a resource (drop attributes/relations not selected for its type). */
function applyFields(resource: Resource, fields: Record<string, string[]>): Resource {
  const selected = fields[resource.type]
  if (!selected) return resource
  const set = new Set(selected)
  const out: Resource = { type: resource.type, id: resource.id }
  if (resource.links) out.links = resource.links
  if (resource.meta) out.meta = resource.meta
  if (resource.attributes) {
    out.attributes = Object.fromEntries(
      Object.entries(resource.attributes).filter(([k]) => set.has(k)),
    )
  }
  if (resource.relationships) {
    out.relationships = Object.fromEntries(
      Object.entries(resource.relationships).filter(([k]) => set.has(k)),
    )
  }
  return out
}

const identifiersOf = (rel: { data?: unknown } | undefined): ResourceIdentifier[] => {
  if (!rel?.data) return []
  return Array.isArray(rel.data)
    ? (rel.data as ResourceIdentifier[])
    : [rel.data as ResourceIdentifier]
}

/** Gather the `included` resources for an `include` request over one or more primary resources. */
function gatherIncluded(
  store: MockStore,
  primaries: Resource[],
  include: string[],
  fields: Record<string, string[]>,
): Resource[] {
  const seen = new Set<string>()
  const included: Resource[] = []
  for (const primary of primaries) {
    for (const path of include) {
      const rel = primary.relationships?.[path]
      for (const ref of identifiersOf(rel)) {
        const key = `${ref.type}:${ref.id}`
        if (seen.has(key)) continue
        const r = store.serialize(ref.type, ref.id)
        if (r) {
          seen.add(key)
          included.push(applyFields(r, fields))
        }
      }
    }
  }
  return included
}

/**
 * Embed linkage `data` for the requested include paths onto a primary resource (so the client can
 * follow a hydrated to-one/to-many). The store omits to-many linkage by default (links-only); a
 * compound read materialises it here from the live relationships.
 */
function withLinkage(store: MockStore, resource: Resource, include: string[]): Resource {
  if (include.length === 0) return resource
  const out: Resource = { ...resource, relationships: { ...resource.relationships } }
  for (const path of include) {
    if (path === 'tracks' && resource.type === 'albums') {
      out.relationships!['tracks'] = {
        links: resource.relationships!['tracks']!.links,
        data: store.tracksByAlbum(resource.id).map((t) => ({ type: 'tracks', id: t.id })),
      }
    } else if (path === 'albums' && resource.type === 'artists') {
      out.relationships!['albums'] = {
        links: resource.relationships!['albums']!.links,
        data: store.albumsByArtist(resource.id).map((a) => ({ type: 'albums', id: a.id })),
      }
    }
  }
  return out
}

function listResources(store: MockStore, type: string): Resource[] {
  switch (type) {
    case 'albums':
      return store.albums().map((r) => store.serializeAlbum(r))
    case 'artists':
      return store.artists().map((r) => store.serializeArtist(r))
    case 'tracks':
      return store.tracks().map((r) => store.serializeTrack(r))
    case 'playlists':
      return store.playlists().map((r) => store.serializePlaylist(r))
    default:
      return []
  }
}

function attrText(resource: Resource, key: string): string {
  return String(resource.attributes?.[key] ?? '').toLowerCase()
}

function applyFilter(resources: Resource[], filter: Record<string, string>): Resource[] {
  let out = resources
  for (const [key, raw] of Object.entries(filter)) {
    const value = raw.toLowerCase()
    if (key === 'q' || key === 'title' || key === 'name') {
      out = out.filter(
        (r) => attrText(r, 'title').includes(value) || attrText(r, 'name').includes(value),
      )
    } else if (key === 'status') {
      out = out.filter((r) => attrText(r, 'status') === value)
    } else if (key === 'artist') {
      out = out.filter((r) => identifiersOf(r.relationships?.['artist']).some((i) => i.id === raw))
    }
  }
  return out
}

function applySort(resources: Resource[], sort: string[]): Resource[] {
  if (sort.length === 0) return resources
  const out = [...resources]
  out.sort((a, b) => {
    for (const token of sort) {
      const desc = token.startsWith('-')
      const field = desc ? token.slice(1) : token
      const av = a.attributes?.[field]
      const bv = b.attributes?.[field]
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av ?? '').localeCompare(String(bv ?? ''))
      if (cmp !== 0) return desc ? -cmp : cmp
    }
    return 0
  })
  return out
}

function paginate(
  resources: Resource[],
  page: ParsedUrl['page'],
): { window: Resource[]; meta: Record<string, unknown>; links: Record<string, string> } {
  const size = page.size ?? resources.length
  const number = page.number ?? 1
  const start = (number - 1) * size
  const window = resources.slice(start, start + size)
  const meta = {
    page: {
      currentPage: number,
      perPage: size,
      from: window.length ? start + 1 : 0,
      to: start + window.length,
    },
  }
  const links: Record<string, string> = {}
  if (number > 1) links['prev'] = `${SELF}?page[number]=${number - 1}&page[size]=${size}`
  if (start + size < resources.length)
    links['next'] = `${SELF}?page[number]=${number + 1}&page[size]=${size}`
  return { window, meta, links }
}

/** Resolve related resources for `GET /{type}/{id}/{rel}` (the related collection / resource). */
function relatedResources(store: MockStore, type: string, id: string, rel: string): Resource[] {
  if (type === 'albums' && rel === 'tracks')
    return store.tracksByAlbum(id).map((t) => store.serializeTrack(t))
  if (type === 'albums' && rel === 'artist') {
    const a = store.album(id)
    const artist = a && store.artist(a.artistId)
    return artist ? [store.serializeArtist(artist)] : []
  }
  if (type === 'artists' && rel === 'albums')
    return store.albumsByArtist(id).map((a) => store.serializeAlbum(a))
  if (type === 'playlists' && rel === 'orderedTracks')
    return store.orderedEdges(id).map(({ track, edge }) => store.serializeTrack(track, edge))
  if (type === 'playlists' && rel === 'tracks')
    return store.orderedEdges(id).map(({ track }) => store.serializeTrack(track))
  return []
}

function parseBody<T>(req: TransportRequest): T | undefined {
  return req.body ? (JSON.parse(req.body) as T) : undefined
}

/**
 * The handler entry point: matches `method + segments` to a store operation and returns a
 * JSON:API response. Anything it does not recognise is a 404 (the app never hits those paths).
 */
export function handle(store: MockStore, req: TransportRequest): TransportResponse {
  const { segments, filter, sort, include, fields, page } = parseUrl(req.url)
  const method = req.method.toUpperCase()
  const [type, id, third, fourth] = segments

  if (!type) return error(404, 'not found')

  // Relationship reads/mutations: /{type}/{id}/relationships/{rel}
  if (third === 'relationships' && id && fourth) {
    return relationshipEndpoint(store, req, method, type, id, fourth)
  }

  // Related read: /{type}/{id}/{rel}
  if (id && third && method === 'GET') {
    const resources = relatedResources(store, type, id, third).map((r) => applyFields(r, fields))
    const { window, meta, links } = paginate(resources, page)
    return ok({ data: window, meta, links, jsonapi: { version: '1.1' } })
  }

  // Single resource: /{type}/{id}
  if (id) {
    if (method === 'GET') {
      const resource = store.serialize(type, id)
      if (!resource) return error(404, `${type} ${id} not found`)
      const hydrated = applyFields(withLinkage(store, resource, include), fields)
      const included = gatherIncluded(
        store,
        [withLinkage(store, resource, include)],
        include,
        fields,
      )
      return ok({ data: hydrated, included, jsonapi: { version: '1.1' } })
    }
    if (method === 'PATCH') return updateResource(store, req, type, id)
    if (method === 'DELETE') return deleteResource(store, type, id)
    return error(405, `method ${method} not allowed`)
  }

  // Collection: /{type}
  if (method === 'GET') {
    let resources = listResources(store, type)
    resources = applySort(applyFilter(resources, filter), sort)
    const { window, meta, links } = paginate(resources, page)
    const shaped = window.map((r) => applyFields(withLinkage(store, r, include), fields))
    const included = gatherIncluded(
      store,
      window.map((r) => withLinkage(store, r, include)),
      include,
      fields,
    )
    return ok({ data: shaped, included, meta, links, jsonapi: { version: '1.1' } })
  }
  if (method === 'POST') return createResource(store, req, type)

  return error(404, 'not found')
}

// --- write handlers -----------------------------------------------------------------------

interface WriteDoc {
  data: {
    type: string
    id?: string
    attributes?: Record<string, unknown>
    relationships?: Record<string, { data: unknown }>
  }
}

function createResource(store: MockStore, req: TransportRequest, type: string): TransportResponse {
  const body = parseBody<WriteDoc>(req)
  const attrs = body?.data.attributes ?? {}
  if (type === 'playlists') {
    if (typeof attrs['title'] !== 'string' || attrs['title'].trim() === '') {
      return error(422, 'must not be blank', '/data/attributes/title')
    }
    const row = store.createPlaylist({
      title: attrs['title'],
      public: typeof attrs['public'] === 'boolean' ? attrs['public'] : false,
    })
    return ok({ data: store.serializePlaylist(row), jsonapi: { version: '1.1' } }, 201)
  }
  return error(403, `creating ${type} is not supported by this demo`)
}

function updateResource(
  store: MockStore,
  req: TransportRequest,
  type: string,
  id: string,
): TransportResponse {
  const body = parseBody<WriteDoc>(req)
  const attrs = body?.data.attributes ?? {}
  if (type === 'playlists') {
    const row = store.updatePlaylist(id, {
      ...(typeof attrs['title'] === 'string' ? { title: attrs['title'] } : {}),
      ...(typeof attrs['public'] === 'boolean' ? { public: attrs['public'] } : {}),
    })
    if (!row) return error(404, `playlist ${id} not found`)
    return ok({ data: store.serializePlaylist(row), jsonapi: { version: '1.1' } })
  }
  return error(403, `updating ${type} is not supported by this demo`)
}

function deleteResource(store: MockStore, type: string, id: string): TransportResponse {
  if (type === 'playlists') {
    return store.deletePlaylist(id) ? noContent() : error(404, `playlist ${id} not found`)
  }
  return error(403, `deleting ${type} is not supported by this demo`)
}

interface RelDoc {
  data: ResourceIdentifier | ResourceIdentifier[] | null
}

function relationshipEndpoint(
  store: MockStore,
  req: TransportRequest,
  method: string,
  type: string,
  id: string,
  rel: string,
): TransportResponse {
  if (type !== 'playlists' || (rel !== 'orderedTracks' && rel !== 'tracks')) {
    if (method === 'GET') {
      const refs = relatedResources(store, type, id, rel).map((r) => ({ type: r.type, id: r.id }))
      return ok({ data: refs, jsonapi: { version: '1.1' } })
    }
    return error(403, `mutating ${type}.${rel} is not supported by this demo`)
  }

  if (method === 'GET') {
    const data = store.orderedEdges(id).map(({ track, edge }) => ({
      type: 'tracks',
      id: track.id,
      meta: { pivot: { position: edge.position } },
    }))
    return ok({ data, jsonapi: { version: '1.1' } })
  }

  const body = parseBody<RelDoc>(req)
  const refs = (Array.isArray(body?.data) ? body!.data : body?.data ? [body.data] : []).filter(
    (r): r is ResourceIdentifier => r != null,
  )
  const ids = refs.map((r) => r.id)

  if (method === 'POST') store.addOrderedTracks(id, ids)
  else if (method === 'DELETE') store.removeOrderedTracks(id, ids)
  else if (method === 'PATCH') {
    // A replace that carries pivot meta drives a reorder; otherwise it is a plain wholesale set.
    const withPivot = refs.filter((r) => typeof r.meta?.['pivot'] === 'object')
    if (withPivot.length > 0) {
      store.replaceOrderedTracks(id, ids)
      for (const ref of withPivot) {
        const pos = (ref.meta!['pivot'] as { position?: number }).position
        if (typeof pos === 'number') store.setPivotPosition(id, ref.id, pos)
      }
    } else {
      store.replaceOrderedTracks(id, ids)
    }
  } else return error(405, `method ${method} not allowed`)

  return noContent()
}
