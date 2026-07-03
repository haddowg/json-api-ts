import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ApiDescriptor, ResourceDescriptor } from './descriptor'
import {
  type ArrayEnvelope,
  type EdgeEnvelope,
  materialise,
  type MaterialiseContext,
  relatedPaginatorKind,
  type ResourceEnvelope,
} from './materialise'
import type { Document } from './request'

function loadFixture(name: string): Document {
  const path = fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as Document
}

// A focused descriptor matching the live music-catalog facts the fixtures exercise.
const res = (r: ResourceDescriptor): ResourceDescriptor => r
const descriptor: ApiDescriptor = {
  albums: res({
    attributes: {},
    relations: {
      artist: { cardinality: 'one', types: ['artists'], pivot: false },
      tracks: { cardinality: 'many', types: ['tracks'], pivot: false },
    },
    paths: {},
    paginator: 'page',
    clientId: 'optional',
  }),
  tracks: res({
    attributes: {},
    relations: {
      album: { cardinality: 'one', types: ['albums'], pivot: false },
      playlists: { cardinality: 'many', types: ['playlists'], pivot: false },
    },
    paths: {},
    paginator: 'page',
    clientId: 'optional',
  }),
  artists: res({
    attributes: {},
    relations: { albums: { cardinality: 'many', types: ['albums'], pivot: false } },
    paths: {},
    paginator: 'page',
    clientId: 'optional',
  }),
  playlists: res({
    attributes: {},
    relations: {
      owner: { cardinality: 'one', types: ['users'], pivot: false },
      publicOwner: { cardinality: 'one', types: ['public-profiles'], pivot: false },
      tracks: { cardinality: 'many', types: ['tracks'], pivot: false },
      orderedTracks: { cardinality: 'many', types: ['tracks'], pivot: true },
    },
    paths: {},
    paginator: 'page',
    clientId: 'optional',
  }),
  libraries: res({
    attributes: {},
    relations: {
      owner: { cardinality: 'one', types: ['users'], pivot: false },
      items: { cardinality: 'many', types: ['tracks', 'albums', 'artists'], pivot: false },
    },
    paths: {},
    paginator: 'page',
    clientId: 'optional',
  }),
}

const context = (
  navigate: MaterialiseContext['navigate'] = vi.fn(async () => undefined),
): MaterialiseContext => ({ descriptor, navigate })

// Helper casts: the runtime returns `unknown`; tests narrow against the documented shape.
type Materialised = Record<string, unknown> & ResourceEnvelope
type Related = Materialised & EdgeEnvelope
type Edged = Record<string, unknown> & EdgeEnvelope
type AugArray<T> = T[] & ArrayEnvelope

const asResource = (v: unknown): Materialised => v as Materialised
const asArray = <T>(v: unknown): AugArray<T> => v as AugArray<T>

describe('materialise — single resource (album-compound)', () => {
  const album = asResource(materialise(loadFixture('album-compound.json'), context()))

  it('flattens type/id/attributes as own enumerable props', () => {
    expect(album['type']).toBe('albums')
    expect(album['id']).toBe('1')
    expect(album['title']).toBe('OK Computer')
    expect(album['averageRating']).toBe(9.8)
    expect(album['releaseInfo']).toEqual({ label: 'Parlophone', catalogueNumber: 'NODATA 01' })
  })

  it('a spread carries no $-keys (clean serialisation)', () => {
    const spread = { ...album }
    expect(Object.keys(spread).some((k) => k.startsWith('$'))).toBe(false)
    expect(Object.keys(spread)).toContain('title')
    expect(Object.keys(spread)).toContain('artist')
    expect(JSON.parse(JSON.stringify(album)).$document).toBeUndefined()
  })

  it('hydrates the to-one artist to a nested resource with its real attributes + $edge', () => {
    const artist = album['artist'] as Related
    expect(artist['type']).toBe('artists')
    expect(artist['id']).toBe('1')
    expect(artist['name']).toBe('Radiohead')
    // $edge carries the relationship-instance envelope: the to-one's self/related links come
    // from the relationship OBJECT (CONTEXT.md), so no need to go via the parent's $rel.
    expect(artist.$edge?.links).toEqual({
      self: 'https://music.example/albums/1/relationships/artist',
      related: 'https://music.example/albums/1/artist',
    })
  })

  it('hydrates tracks to an augmented array of hydrated tracks', () => {
    const tracks = asArray<Related>(album['tracks'])
    expect(tracks).toHaveLength(3)
    expect(tracks.map((t) => t['title'])).toEqual([
      'Airbag',
      'Paranoid Android',
      'Exit Music (For a Film)',
    ])
    expect(tracks[0]!['durationSeconds']).toBe(284)
  })

  it('exposes $raw / $meta / $links / $self', () => {
    expect(album.$self).toBe('https://music.example/albums/1')
    expect(album.$links).toEqual({ self: 'https://music.example/albums/1' })
    expect(album.$meta).toBeUndefined()
    expect((album.$raw as { type: string }).type).toBe('albums')
  })

  it('$rel returns { data, links, meta } for a relation', () => {
    const rel = album.$rel('artist')
    expect(rel?.data).toEqual({ type: 'artists', id: '1' })
    expect(rel?.links).toMatchObject({ related: 'https://music.example/albums/1/artist' })
    expect(album.$rel('nope')).toBeUndefined()
  })

  it('shares one $document by reference across every resource from the response', () => {
    const artist = album['artist'] as Related
    const track0 = asArray<Related>(album['tracks'])[0]!
    expect(album.$document).toBe(artist.$document)
    expect(album.$document).toBe(track0.$document)
    expect(album.$document).toEqual({ jsonapi: { version: '1.1' }, links: expect.any(Object) })
  })
})

describe('materialise — pivot members', () => {
  it('populates $pivot from meta.pivot on the relationship endpoint', () => {
    const linkage = asArray<Edged>(
      materialise(loadFixture('playlist-orderedtracks-relationship.json'), context(), true),
    )
    expect(linkage).toHaveLength(2)
    expect(linkage[0]!.$pivot).toEqual({
      position: 2,
      weight: 100,
      addedAt: '2024-04-02T09:00:00+00:00',
    })
    expect(linkage[1]!.$pivot).toEqual({
      position: 1,
      weight: 100,
      addedAt: '2024-04-01T09:00:00+00:00',
    })
  })

  it('populates $pivot on the related endpoint members too', () => {
    const related = asArray<Related>(
      materialise(loadFixture('playlist-orderedtracks-related.json'), context()),
    )
    expect(related).toHaveLength(2)
    expect(related[0]!['title']).toBe('Airbag')
    expect(related[0]!.$pivot).toEqual({
      position: 2,
      weight: 100,
      addedAt: '2024-04-02T09:00:00+00:00',
    })
  })

  it('carries $pivot on a primary-resource compound include', () => {
    // The bundle now renders meta.pivot on a primary-document linkage, not only on the
    // relationship/related endpoints (json-api-symfony #79) — so a compound include
    // hydrates pivot the same way.
    const playlist = asResource(materialise(loadFixture('playlist-pivot.json'), context()))
    const ordered = asArray<Related>(playlist['orderedTracks'])
    expect(ordered).toHaveLength(3)
    expect(ordered[0]!['title']).toBe('Airbag')
    expect(ordered[0]!.$pivot).toEqual({
      position: 2,
      weight: 100,
      addedAt: '2024-04-02T09:00:00+00:00',
    })
    // pivot rides $edge.meta alongside served_by.
    expect(ordered[0]!.$edge?.meta).toEqual({
      served_by: 'music-catalog',
      pivot: { position: 2, weight: 100, addedAt: '2024-04-02T09:00:00+00:00' },
    })
  })

  it('leaves $pivot undefined on a non-pivot relation member', () => {
    // A plain (non-belongsToMany) to-many carries no meta.pivot; $pivot stays undefined.
    const album = asResource(materialise(loadFixture('album-compound.json'), context()))
    const tracks = asArray<Related>(album['tracks'])
    expect(tracks[0]!.$pivot).toBeUndefined()
    expect(tracks[0]!.$edge?.meta).toEqual({ served_by: 'music-catalog' })
  })

  it('reports the same $page.kind on a compound include as on the dedicated endpoint', () => {
    // The related type (`tracks`) paginates by `page`; the embedded to-many must report that
    // same discriminant — not `none` — so a consumer branching on $page.kind is consistent.
    const playlist = asResource(materialise(loadFixture('playlist-pivot.json'), context()))
    const ordered = asArray<Related>(playlist['orderedTracks'])
    expect(ordered.$page.kind).toBe('page')
  })
})

describe('materialise — polymorphic to-many (library-polymorphic)', () => {
  it('keeps members at their distinct types', () => {
    const library = asResource(materialise(loadFixture('library-polymorphic.json'), context()))
    const items = asArray<Related>(library['items'])
    expect(items.map((i) => i['type'])).toEqual(['tracks', 'albums', 'artists'])
    expect(items[0]!['title']).toBe('Airbag')
    expect(items[1]!['title']).toBe('Dummy')
    expect(items[2]!['name']).toBe('Radiohead')
  })
})

describe('materialise — top-level collection (albums-collection)', () => {
  const albums = asArray<Materialised>(
    materialise(loadFixture('albums-collection.json'), context()),
  )

  it('is an augmented array of resource objects', () => {
    expect(Array.isArray(albums)).toBe(true)
    expect(albums).toHaveLength(2)
    expect(albums[0]!['title']).toBe('OK Computer')
    expect(albums[1]!['title']).toBe('Dummy')
  })

  it('parses $page from meta.page and carries the descriptor paginator kind', () => {
    expect(albums.$page.kind).toBe('page')
    expect(albums.$page.meta).toEqual({ currentPage: 1, perPage: 3, from: 1, to: 2 })
  })

  it('reports hasNext via link presence (no next/prev link => last page)', async () => {
    expect(albums.$page.links.next).toBeUndefined()
    expect(albums.$page.links.first).toBe(
      'https://music.example/albums?page%5Bnumber%5D=1&page%5Bsize%5D=3',
    )
    await expect(albums.$next()).resolves.toBeUndefined()
    await expect(albums.$prev()).resolves.toBeUndefined()
  })
})

describe('materialise — relationship linkage (album-tracks-relationship)', () => {
  // The relationship endpoint is a linkage surface (caller passes linkage=true).
  const linkage = asArray<Edged & { type: string; id: string }>(
    materialise(loadFixture('album-tracks-relationship.json'), context(), true),
  )

  it('is an augmented array of identifier views (no attributes)', () => {
    expect(linkage).toHaveLength(2)
    expect(linkage[0]).toMatchObject({ type: 'tracks', id: '1' })
    expect(linkage[0]!['title']).toBeUndefined()
    expect(linkage[0]!.$edge?.meta).toEqual({ served_by: 'music-catalog' })
    // relationship-level navigation links present (first).
    expect(linkage.$links).toMatchObject({ related: 'https://music.example/albums/1/tracks' })
  })

  it('reports the related type paginator kind (one model across surfaces)', () => {
    // The members are `tracks`, whose descriptor paginator is `page` — so the relationship
    // endpoint discriminant matches the same relation embedded in a compound include.
    expect(linkage.$page.kind).toBe('page')
  })
})

describe('materialise — related collection (album-tracks-related)', () => {
  it('hydrates each member with attributes + $page', () => {
    const tracks = asArray<Related>(
      materialise(loadFixture('album-tracks-related.json'), context()),
    )
    expect(tracks).toHaveLength(2)
    expect(tracks[0]!['title']).toBe('Airbag')
    expect(tracks[0]!['album']).toMatchObject({ type: 'albums', id: '1' })
    expect(tracks.$page.kind).toBe('page')
    expect(tracks.$page.meta).toEqual({ currentPage: 1, perPage: 2, from: 1, to: 2 })
  })
})

describe('materialise — navigation seam', () => {
  it('drives ctx.navigate(next link) from $next() when present', async () => {
    const next = 'https://music.example/albums?page%5Bnumber%5D=2'
    const doc: Document = {
      data: [],
      links: { self: 'x', next },
      meta: { page: { currentPage: 1 } },
    }
    const navigate = vi.fn(async () => 'PAGE2')
    const arr = asArray<unknown>(materialise(doc, context(navigate)))
    await expect(arr.$next()).resolves.toBe('PAGE2')
    // A top-level collection re-materialises its next page as resources (linkage=false), threading
    // the current page's paginator kind so an empty/divergent next page keeps the discriminant (D6a).
    expect(navigate).toHaveBeenCalledWith(next, false, 'none')
  })
})

describe('materialise — to-one / empty shapes', () => {
  it('returns null for an empty to-one document', () => {
    expect(materialise({ data: null }, context())).toBeNull()
  })

  it('returns null for an included-but-empty to-one relation slot', () => {
    // The relation IS requested (included present) yet legitimately has no related resource.
    const doc: Document = {
      data: {
        type: 'albums',
        id: '1',
        attributes: { title: 'X' },
        relationships: { artist: { data: null } },
      },
      included: [],
    }
    const album = asResource(materialise(doc, context()))
    expect(album['artist']).toBeNull()
  })

  it('carries the relationship object links/meta on a to-one $edge', () => {
    // A synthetic to-one whose relationship object has self/related links + meta: the per-edge
    // $edge must surface them so there is no need to go via the parent $rel (CONTEXT.md).
    const doc: Document = {
      data: {
        type: 'albums',
        id: '1',
        attributes: { title: 'X' },
        relationships: {
          artist: {
            links: { self: 'S', related: 'R' },
            meta: { strength: 5 },
            data: { type: 'artists', id: '7' },
          },
        },
      },
      included: [{ type: 'artists', id: '7', attributes: { name: 'A' } }],
    }
    const album = asResource(materialise(doc, context()))
    const artist = album['artist'] as Related
    expect(artist['name']).toBe('A')
    expect(artist.$edge?.links).toEqual({ self: 'S', related: 'R' })
    expect(artist.$edge?.meta).toEqual({ strength: 5 })
  })

  it('treats an attribute-less, relation-less primary resource as a full resource', () => {
    // A genuine resource (e.g. a sparse fieldset reduced to empty) carries neither attributes
    // nor relationships — it must NOT be misclassified as a bare linkage identifier.
    const doc: Document = {
      data: {
        type: 'albums',
        id: '1',
        links: { self: 'https://music.example/albums/1' },
        meta: { revision: 3 },
      },
    }
    const album = asResource(materialise(doc, context()))
    expect(album['type']).toBe('albums')
    expect(album['id']).toBe('1')
    // Resource-level $-accessors are present (it's a resource, not an identifier).
    expect(album.$self).toBe('https://music.example/albums/1')
    expect(album.$meta).toEqual({ revision: 3 })
    expect(album.$document).toBeDefined()
    expect(typeof album.$rel).toBe('function')
    // `meta` is NOT an enumerable own prop (it rides $meta).
    expect(Object.keys({ ...album })).not.toContain('meta')
  })

  it('returns a single identifier view for a to-one linkage (linkage surface)', () => {
    // The `/relationships/{rel}` endpoint returns pure linkage; the caller marks it so an
    // attribute-less, relation-less identifier is materialised as an identifier view.
    const view = materialise(
      { data: { type: 'artists', id: '9', meta: { served_by: 'x' } } },
      context(),
      true,
    ) as Edged & { type: string }
    expect(view['type']).toBe('artists')
    expect((view as Record<string, unknown>)['id']).toBe('9')
    expect(view.$edge?.meta).toEqual({ served_by: 'x' })
  })

  it('leaves a linked-but-not-included relation as an identifier', () => {
    // artist linkage points at artists:99 which is NOT in included => identifier only.
    const doc: Document = {
      data: {
        type: 'albums',
        id: '1',
        attributes: { title: 'X' },
        relationships: { artist: { data: { type: 'artists', id: '99' } } },
      },
    }
    const album = asResource(materialise(doc, context()))
    const artist = album['artist'] as Record<string, unknown>
    expect(artist['type']).toBe('artists')
    expect(artist['id']).toBe('99')
    expect(artist['name']).toBeUndefined()
  })

  it('leaves a links-only relation undefined', () => {
    const doc: Document = {
      data: {
        type: 'albums',
        id: '1',
        attributes: { title: 'X' },
        relationships: { artist: { links: { related: 'r' } } },
      },
    }
    const album = asResource(materialise(doc, context()))
    expect(album['artist']).toBeUndefined()
    expect(album.$rel('artist')?.links).toEqual({ related: 'r' })
  })
})

describe('materialise — per-edge view identity', () => {
  it('reads attributes through the node but is not reference-equal across edges', () => {
    // Same track reachable from album.tracks and (in a richer doc) elsewhere; here we
    // assert a per-edge view is a distinct object carrying its own edge data.
    const album = asResource(materialise(loadFixture('album-compound.json'), context()))
    const t0 = asArray<Related>(album['tracks'])[0]!
    const standalone = asResource(
      materialise(loadFixture('album-tracks-related.json'), context()),
    ) as never as AugArray<Related>
    // distinct response => distinct objects, equal by type:id, never by reference
    expect(t0['id']).toBe(standalone[0]!['id'])
    expect(t0).not.toBe(standalone[0])
  })
})

describe('materialise — per-relation paginator divergence (D6a)', () => {
  // A relation whose OWN related endpoint paginates by `cursor` even though the related type's
  // top-level collection is `page`. The descriptor carries the per-relation kind on the relation.
  const divergent: ApiDescriptor = {
    parents: res({
      attributes: {},
      relations: {
        // The related endpoint diverges (cursor) from `children`'s collection (page).
        children: { cardinality: 'many', types: ['children'], pivot: false, paginator: 'cursor' },
        // No per-relation kind -> falls back to the related type's collection paginator (page).
        mirror: { cardinality: 'many', types: ['children'], pivot: false },
      },
      paths: {},
      paginator: 'page',
      clientId: 'optional',
    }),
    children: res({
      attributes: {},
      relations: {},
      paths: {},
      paginator: 'page',
      clientId: 'optional',
    }),
  }
  const ctx = (nav: MaterialiseContext['navigate'] = vi.fn(async () => undefined)) => ({
    descriptor: divergent,
    navigate: nav,
  })

  it('relatedPaginatorKind prefers the per-relation kind over the related type default', () => {
    expect(relatedPaginatorKind(divergent['parents']!.relations['children'], ctx())).toBe('cursor')
    expect(relatedPaginatorKind(divergent['parents']!.relations['mirror'], ctx())).toBe('page')
  })

  it('a compound-include to-many array reports the diverging per-relation kind', () => {
    const doc: Document = {
      data: {
        type: 'parents',
        id: '1',
        relationships: { children: { data: [{ type: 'children', id: '9' }] } },
      },
      included: [{ type: 'children', id: '9', attributes: {} }],
    }
    const parent = asResource(materialise(doc, ctx()))
    expect(asArray<unknown>(parent['children']).$page.kind).toBe('cursor')
  })

  it('an EMPTY related-collection read reports the threaded per-relation kind (not a sniffed none)', () => {
    // A related read passes the resolved per-relation paginator as the override so an empty page
    // (no member to sniff a type from) still reports the relation's real kind.
    const empty = asArray<unknown>(materialise({ data: [] }, ctx(), false, undefined, 'cursor'))
    expect(empty.$page.kind).toBe('cursor')
  })
})
