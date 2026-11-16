import { loadAll } from '@haddowg/json-api-client'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { reads } from '../api/client'
import { GradientArt } from '../components/GradientArt'
import { QueryState } from '../components/QueryState'
import { formatDuration, formatYear } from '../lib/format'

/**
 * Album detail: the album + its tracklist + its artist, all in one compound read. `include` widens
 * `artist`/`tracks` to hydrated resources, so `album.artist.name` and each `track.title` are typed
 * off the client with no cast (the relations narrow to their related types).
 *
 * The server renders an included to-many as its first page, two tracks here, so the page shows
 * those at once and `loadAll` follows the relationship's `next` links for the rest of the tracklist.
 */
export function AlbumDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const albumQuery = useQuery(reads.albums.get(id, { include: ['artist', 'tracks'] }))
  const album = albumQuery.data
  const tracklistQuery = useQuery({
    queryKey: ['albums', id, 'tracklist'],
    queryFn: () => loadAll(album!.tracks),
    enabled: album !== undefined,
    structuralSharing: false,
  })
  const tracks = tracklistQuery.data ?? album?.tracks ?? []

  return (
    <QueryState isPending={albumQuery.isPending} error={albumQuery.error}>
      {album ? (
        <div>
          <header className="detail-header">
            <GradientArt seed={`album-${album.id}`} label={album.title} size={184} />
            <div className="detail-header__meta">
              <span className="detail-header__kind">Album</span>
              <h1 className="detail-header__name">{album.title}</h1>
              <div className="detail-header__sub">
                {album.artist ? (
                  <Link to={`/artists/${album.artist.id}`} className="link-strong">
                    {album.artist.name}
                  </Link>
                ) : (
                  'Unknown artist'
                )}
                {formatYear(album.releasedAt) ? ` · ${formatYear(album.releasedAt)}` : ''}
                {` · ${tracks.length} tracks`}
              </div>
            </div>
          </header>

          {tracks.length === 0 ? (
            <p className="state">No tracks on this album.</p>
          ) : (
            <div className="tracklist">
              {tracks.map((track, i) => (
                <div key={track.id} className="track-row">
                  <span className="track-row__index">{i + 1}</span>
                  <span className="track-row__title">
                    {track.title}
                    {track.explicit ? <span className="pill"> E</span> : null}
                  </span>
                  <span />
                  <span className="track-row__dur">{formatDuration(track.durationSeconds)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </QueryState>
  )
}
