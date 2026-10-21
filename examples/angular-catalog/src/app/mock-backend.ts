import {
  HttpErrorResponse,
  HttpHeaders,
  type HttpInterceptorFn,
  type HttpRequest,
  HttpResponse,
} from '@angular/common/http'
import { delay, dematerialize, materialize, of, throwError } from 'rxjs'

// A stand-in for the music-catalog server, registered as the last interceptor so the app's own
// interceptors still run first. It answers the few requests the app makes from an in-memory
// store, with a delay so a superseded request is visibly cancelled.

interface Artist {
  id: string
  name: string
}

interface Album {
  id: string
  title: string
  releasedAt: string
  artistId: string
}

const artists: Artist[] = [
  { id: '1', name: 'Radiohead' },
  { id: '2', name: 'Portishead' },
  { id: '3', name: 'Massive Attack' },
  { id: '4', name: 'Björk' },
  { id: '5', name: 'Boards of Canada' },
]

const albums: Album[] = [
  { id: '1', title: 'OK Computer', releasedAt: '1997-05-21T00:00:00+00:00', artistId: '1' },
  { id: '2', title: 'Dummy', releasedAt: '1994-08-22T00:00:00+00:00', artistId: '2' },
  { id: '3', title: 'Kid A', releasedAt: '2000-10-02T00:00:00+00:00', artistId: '1' },
  { id: '4', title: 'Mezzanine', releasedAt: '1998-04-20T00:00:00+00:00', artistId: '3' },
  { id: '5', title: 'Homogenic', releasedAt: '1997-09-22T00:00:00+00:00', artistId: '4' },
  { id: '6', title: 'Third', releasedAt: '2008-04-28T00:00:00+00:00', artistId: '2' },
  { id: '7', title: 'Blue Lines', releasedAt: '1991-04-08T00:00:00+00:00', artistId: '3' },
  {
    id: '8',
    title: 'Music Has the Right to Children',
    releasedAt: '1998-04-20T00:00:00+00:00',
    artistId: '5',
  },
  { id: '9', title: 'In Rainbows', releasedAt: '2007-10-10T00:00:00+00:00', artistId: '1' },
  { id: '10', title: 'Post', releasedAt: '1995-06-13T00:00:00+00:00', artistId: '4' },
  { id: '11', title: 'Geogaddi', releasedAt: '2002-02-18T00:00:00+00:00', artistId: '5' },
  { id: '12', title: 'Portishead', releasedAt: '1997-09-29T00:00:00+00:00', artistId: '2' },
]

const LATENCY_MS = 400
const MEDIA_TYPE = 'application/vnd.api+json'

export function mockBackendInterceptor(basePath: string): HttpInterceptorFn {
  return (req, next) => {
    // The client sends relative URLs for its own reads and absolute ones for page links.
    const url = new URL(req.urlWithParams, location.origin)
    if (url.origin !== location.origin || !url.pathname.startsWith(`${basePath}/`)) {
      return next(req)
    }
    const path = url.pathname.slice(basePath.length)
    const { status, body } = handle(req, path, url.searchParams, `${location.origin}${basePath}`)
    const headers = new HttpHeaders({ 'Content-Type': MEDIA_TYPE })
    const response =
      status < 400
        ? of(new HttpResponse({ status, body, headers, url: req.url }))
        : throwError(() => new HttpErrorResponse({ status, error: body, headers, url: req.url }))
    // Delay errors as well as values, so every request takes the same time.
    return response.pipe(materialize(), delay(LATENCY_MS), dematerialize())
  }
}

function handle(
  req: HttpRequest<unknown>,
  path: string,
  query: URLSearchParams,
  base: string,
): { status: number; body: string } {
  const one = /^\/albums\/([^/]+)$/.exec(path)
  if (req.method === 'GET' && path === '/albums') {
    return list(query, base)
  }
  if (req.method === 'GET' && one?.[1] !== undefined) {
    const album = albums.find((a) => a.id === one[1])
    return album === undefined
      ? error(404, 'Not Found')
      : ok({ data: resource(album, base), included: includedArtists([album], query) })
  }
  if (req.method === 'PATCH' && one?.[1] !== undefined) {
    const album = albums.find((a) => a.id === one[1])
    if (album === undefined) {
      return error(404, 'Not Found')
    }
    const doc = JSON.parse(String(req.body)) as { data: { attributes?: { title?: string } } }
    const title = doc.data.attributes?.title
    if (title !== undefined && title.trim() === '') {
      return error(
        422,
        'Unprocessable Content',
        'This value should not be blank.',
        '/data/attributes/title',
      )
    }
    if (title !== undefined) {
      album.title = title
    }
    return ok({ data: resource(album, base) })
  }
  return error(404, 'Not Found')
}

function list(query: URLSearchParams, base: string): { status: number; body: string } {
  const title = query.get('filter[title]')?.toLowerCase() ?? ''
  const size = Number(query.get('page[size]') ?? 5)
  const number = Number(query.get('page[number]') ?? 1)
  const matches = albums
    .filter((a) => a.title.toLowerCase().includes(title))
    .toSorted((a, b) => a.title.localeCompare(b.title))
  const pages = Math.max(1, Math.ceil(matches.length / size))
  const window = matches.slice((number - 1) * size, number * size)

  const link = (page: number): string => {
    const params = new URLSearchParams(query)
    params.set('page[number]', String(page))
    params.set('page[size]', String(size))
    return `${base}/albums?${params.toString().replace(/%5B/g, '[').replace(/%5D/g, ']')}`
  }
  const links: Record<string, string> = { self: link(number), first: link(1), last: link(pages) }
  if (number > 1) links['prev'] = link(number - 1)
  if (number < pages) links['next'] = link(number + 1)

  return ok({
    data: window.map((a) => resource(a, base)),
    included: includedArtists(window, query),
    links,
    meta: { page: { currentPage: number, perPage: size, lastPage: pages, total: matches.length } },
  })
}

function resource(album: Album, base: string) {
  return {
    type: 'albums',
    id: album.id,
    attributes: { title: album.title, releasedAt: album.releasedAt },
    relationships: { artist: { data: { type: 'artists', id: album.artistId } } },
    links: { self: `${base}/albums/${album.id}` },
  }
}

function includedArtists(rows: Album[], query: URLSearchParams) {
  if (!(query.get('include') ?? '').split(',').includes('artist')) {
    return []
  }
  const ids = new Set(rows.map((a) => a.artistId))
  return artists
    .filter((artist) => ids.has(artist.id))
    .map((artist) => ({ type: 'artists', id: artist.id, attributes: { name: artist.name } }))
}

function ok(document: object): { status: number; body: string } {
  return { status: 200, body: JSON.stringify({ jsonapi: { version: '1.1' }, ...document }) }
}

function error(
  status: number,
  title: string,
  detail?: string,
  pointer?: string,
): { status: number; body: string } {
  const errorObject = {
    status: String(status),
    title,
    ...(detail !== undefined ? { detail } : {}),
    ...(pointer !== undefined ? { source: { pointer } } : {}),
  }
  return { status, body: JSON.stringify({ errors: [errorObject] }) }
}
