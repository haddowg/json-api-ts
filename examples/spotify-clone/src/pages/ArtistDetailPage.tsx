import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { reads } from '../api/client'
import { GradientArt } from '../components/GradientArt'
import { QueryState } from '../components/QueryState'
import { formatYear } from '../lib/format'

/**
 * Artist detail: the artist + their discography. The `artists` endpoint declares no includable
 * relations, so the albums are a second typed read — `reads.albums.list` filtered by the
 * advertised `artist.name` filter — gated on the artist having loaded (a dependent query).
 */
export function ArtistDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const artistQuery = useQuery(reads.artists.get(id))
  const artist = artistQuery.data

  const albumsQuery = useQuery({
    ...reads.albums.list({
      filter: { 'artist.name': artist?.name ?? '' },
      sort: '-releasedAt',
    }),
    enabled: artist !== undefined,
  })
  const albums = albumsQuery.data ?? []

  return (
    <QueryState isPending={artistQuery.isPending} error={artistQuery.error}>
      {artist ? (
        <div>
          <header className="detail-header">
            <GradientArt
              seed={`artist-${artist.id}`}
              label={artist.name}
              size={184}
              shape="circle"
            />
            <div className="detail-header__meta">
              <span className="detail-header__kind">Artist</span>
              <h1 className="detail-header__name">{artist.name}</h1>
              <div className="detail-header__sub">
                {artist.trackCount} tracks · {albums.length} albums
              </div>
              {artist.bio ? <p className="muted">{artist.bio}</p> : null}
            </div>
          </header>

          <h2 className="section-title">Albums</h2>
          {albums.length === 0 ? (
            <p className="state">No albums yet.</p>
          ) : (
            <div className="grid">
              {albums.map((album) => (
                <Link key={album.id} to={`/albums/${album.id}`} className="card">
                  <div className="card__art">
                    <GradientArt seed={`album-${album.id}`} label={album.title} size={148} />
                  </div>
                  <div className="card__title">{album.title}</div>
                  <div className="card__subtitle">{formatYear(album.releasedAt)}</div>
                </Link>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </QueryState>
  )
}
