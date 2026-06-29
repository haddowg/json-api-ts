/**
 * The in-memory store: holds the seed rows and serialises them to JSON:API resource objects on
 * demand. Writes mutate the rows in place so the UI (read after write, optimistic, normalized)
 * reflects them within the session. This is NOT a general JSON:API server — it knows only the
 * shapes the app reads and writes.
 */
import {
  type AlbumRow,
  type ArtistRow,
  createSeed,
  type PlaylistRow,
  type PlaylistTrackEdge,
  type SeedData,
  type TrackRow,
} from './seed'

const SELF = 'https://music.example'

/** A minimal JSON:API resource object (what the store emits and the client materialises). */
export interface Resource {
  type: string
  id: string
  attributes?: Record<string, unknown>
  relationships?: Record<string, RelationshipObject>
  links?: { self: string }
  meta?: Record<string, unknown>
}

export interface RelationshipObject {
  links: { self: string; related: string }
  data?: ResourceIdentifier | ResourceIdentifier[] | null
  meta?: Record<string, unknown>
}

export interface ResourceIdentifier {
  type: string
  id: string
  meta?: Record<string, unknown>
}

const relLinks = (type: string, id: string, rel: string): RelationshipObject['links'] => ({
  self: `${SELF}/${type}/${id}/relationships/${rel}`,
  related: `${SELF}/${type}/${id}/${rel}`,
})

export class MockStore {
  private data: SeedData = createSeed()
  private nextId = 1000

  reset(): void {
    this.data = createSeed()
    this.nextId = 1000
  }

  // --- row access -------------------------------------------------------------------------

  artists(): ArtistRow[] {
    return this.data.artists
  }
  albums(): AlbumRow[] {
    return this.data.albums
  }
  tracks(): TrackRow[] {
    return this.data.tracks
  }
  playlists(): PlaylistRow[] {
    return this.data.playlists
  }

  artist(id: string): ArtistRow | undefined {
    return this.data.artists.find((a) => a.id === id)
  }
  album(id: string): AlbumRow | undefined {
    return this.data.albums.find((a) => a.id === id)
  }
  track(id: string): TrackRow | undefined {
    return this.data.tracks.find((t) => t.id === id)
  }
  playlist(id: string): PlaylistRow | undefined {
    return this.data.playlists.find((p) => p.id === id)
  }

  albumsByArtist(artistId: string): AlbumRow[] {
    return this.data.albums.filter((a) => a.artistId === artistId)
  }
  tracksByAlbum(albumId: string): TrackRow[] {
    return this.data.tracks
      .filter((t) => t.albumId === albumId)
      .toSorted((a, b) => a.trackNumber - b.trackNumber)
  }

  /** The ordered playlist edges (by pivot position), each with its track row. */
  orderedEdges(playlistId: string): Array<{ edge: PlaylistTrackEdge; track: TrackRow }> {
    return this.data.playlistTracks
      .filter((e) => e.playlistId === playlistId)
      .toSorted((a, b) => a.position - b.position)
      .flatMap((edge) => {
        const track = this.track(edge.trackId)
        return track ? [{ edge, track }] : []
      })
  }

  // --- serialisation ----------------------------------------------------------------------

  serializeArtist(row: ArtistRow): Resource {
    return {
      type: 'artists',
      id: row.id,
      links: { self: `${SELF}/artists/${row.id}` },
      attributes: {
        name: row.name,
        slug: row.slug,
        website: row.website,
        bio: row.bio,
        trackCount: this.data.tracks.filter((t) =>
          this.albumsByArtist(row.id).some((al) => al.id === t.albumId),
        ).length,
        createdAt: row.createdAt,
      },
      relationships: {
        albums: { links: relLinks('artists', row.id, 'albums') },
      },
    }
  }

  serializeAlbum(row: AlbumRow): Resource {
    return {
      type: 'albums',
      id: row.id,
      links: { self: `${SELF}/albums/${row.id}` },
      attributes: {
        title: row.title,
        status: row.status,
        releasedAt: row.releasedAt,
        averageRating: row.averageRating,
        explicit: row.explicit,
        artwork: row.artwork,
        availableFrom: row.availableFrom,
        availableUntil: row.availableUntil,
        releaseInfo: row.releaseInfo,
      },
      relationships: {
        artist: {
          links: relLinks('albums', row.id, 'artist'),
          data: { type: 'artists', id: row.artistId },
        },
        tracks: { links: relLinks('albums', row.id, 'tracks') },
      },
    }
  }

  serializeTrack(row: TrackRow, pivot?: PlaylistTrackEdge): Resource {
    const meta: Record<string, unknown> = { served_by: 'music-catalog' }
    if (pivot) {
      meta['pivot'] = { position: pivot.position, addedAt: pivot.addedAt }
    }
    return {
      type: 'tracks',
      id: row.id,
      meta,
      links: { self: `${SELF}/tracks/${row.id}` },
      attributes: {
        title: row.title,
        trackNumber: row.trackNumber,
        durationSeconds: row.durationSeconds,
        explicit: row.explicit,
        genres: row.genres,
        previewOffset: row.previewOffset,
        displayTitle: `${row.trackNumber}. ${row.title}`,
      },
      relationships: {
        album: {
          links: relLinks('tracks', row.id, 'album'),
          data: { type: 'albums', id: row.albumId },
        },
        playlists: { links: relLinks('tracks', row.id, 'playlists') },
      },
    }
  }

  serializePlaylist(row: PlaylistRow): Resource {
    return {
      type: 'playlists',
      id: row.id,
      links: { self: `${SELF}/playlists/${row.id}` },
      attributes: {
        title: row.title,
        slug: row.slug,
        public: row.public,
        externalId: row.externalId,
      },
      relationships: {
        orderedTracks: { links: relLinks('playlists', row.id, 'orderedTracks') },
        tracks: { links: relLinks('playlists', row.id, 'tracks') },
        owner: { links: relLinks('playlists', row.id, 'owner') },
      },
    }
  }

  /** Serialise any resource by type+id (used to hydrate `included` for a compound document). */
  serialize(type: string, id: string): Resource | undefined {
    switch (type) {
      case 'artists': {
        const r = this.artist(id)
        return r && this.serializeArtist(r)
      }
      case 'albums': {
        const r = this.album(id)
        return r && this.serializeAlbum(r)
      }
      case 'tracks': {
        const r = this.track(id)
        return r && this.serializeTrack(r)
      }
      case 'playlists': {
        const r = this.playlist(id)
        return r && this.serializePlaylist(r)
      }
      default:
        return undefined
    }
  }

  // --- writes -----------------------------------------------------------------------------

  createPlaylist(attrs: {
    title: string
    public?: boolean
    externalId?: string | null
  }): PlaylistRow {
    const id = `${(this.nextId += 1)}`
    const row: PlaylistRow = {
      id,
      title: attrs.title,
      slug: slugify(attrs.title),
      public: attrs.public ?? false,
      externalId: attrs.externalId ?? null,
    }
    this.data.playlists.push(row)
    return row
  }

  updatePlaylist(
    id: string,
    attrs: { title?: string; public?: boolean; externalId?: string | null },
  ): PlaylistRow | undefined {
    const row = this.playlist(id)
    if (!row) return undefined
    if (attrs.title !== undefined) {
      row.title = attrs.title
      row.slug = slugify(attrs.title)
    }
    if (attrs.public !== undefined) row.public = attrs.public
    if (attrs.externalId !== undefined) row.externalId = attrs.externalId
    return row
  }

  deletePlaylist(id: string): boolean {
    const i = this.data.playlists.findIndex((p) => p.id === id)
    if (i < 0) return false
    this.data.playlists.splice(i, 1)
    this.data.playlistTracks = this.data.playlistTracks.filter((e) => e.playlistId !== id)
    return true
  }

  /** Append track refs to a playlist's ordered tracks (next free positions). */
  addOrderedTracks(playlistId: string, trackIds: string[]): void {
    const existing = this.data.playlistTracks.filter((e) => e.playlistId === playlistId)
    let next = existing.reduce((max, e) => Math.max(max, e.position), 0)
    const now = new Date().toISOString()
    for (const trackId of trackIds) {
      if (existing.some((e) => e.trackId === trackId)) continue
      next += 1
      this.data.playlistTracks.push({ playlistId, trackId, position: next, addedAt: now })
    }
    this.renumber(playlistId)
  }

  removeOrderedTracks(playlistId: string, trackIds: string[]): void {
    this.data.playlistTracks = this.data.playlistTracks.filter(
      (e) => !(e.playlistId === playlistId && trackIds.includes(e.trackId)),
    )
    this.renumber(playlistId)
  }

  /** Replace the whole ordered set with `trackIds`, in the given order (drives reorder). */
  replaceOrderedTracks(playlistId: string, trackIds: string[]): void {
    const prior = new Map(
      this.data.playlistTracks
        .filter((e) => e.playlistId === playlistId)
        .map((e) => [e.trackId, e] as const),
    )
    const now = new Date().toISOString()
    this.data.playlistTracks = this.data.playlistTracks.filter((e) => e.playlistId !== playlistId)
    trackIds.forEach((trackId, i) => {
      this.data.playlistTracks.push({
        playlistId,
        trackId,
        position: i + 1,
        addedAt: prior.get(trackId)?.addedAt ?? now,
      })
    })
  }

  /** Set the per-edge pivot `position` for a track and re-sort the playlist around it. */
  setPivotPosition(playlistId: string, trackId: string, position: number): void {
    const ordered = this.orderedEdges(playlistId).map((o) => o.edge.trackId)
    const from = ordered.indexOf(trackId)
    if (from < 0) return
    ordered.splice(from, 1)
    const to = Math.max(0, Math.min(ordered.length, position - 1))
    ordered.splice(to, 0, trackId)
    this.replaceOrderedTracks(playlistId, ordered)
  }

  private renumber(playlistId: string): void {
    this.orderedEdges(playlistId).forEach(({ edge }, i) => {
      edge.position = i + 1
    })
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}
