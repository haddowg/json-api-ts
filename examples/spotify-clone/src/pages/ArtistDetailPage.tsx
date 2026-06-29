import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { reads } from '../api/client'
import { GradientArt } from '../components/GradientArt'
import { QueryState } from '../components/QueryState'
import { formatYear } from '../lib/format'

/**
 * Artist detail: the artist + their albums. Including `albums` narrows the relation to a typed
 * Collection of album resources (`a.title`/`a.releasedAt`), so the discography renders straight off
 * the compound document — no second request, no cast.
 */
export function ArtistDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const artistQuery = useQuery(reads.artists.get(id, { include: ['albums'] }))
  const artist = artistQuery.data

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
                {artist.trackCount} tracks · {artist.albums.length} albums
              </div>
              {artist.bio ? <p className="muted">{artist.bio}</p> : null}
            </div>
          </header>

          <h2 className="section-title">Albums</h2>
          {artist.albums.length === 0 ? (
            <p className="state">No albums yet.</p>
          ) : (
            <div className="grid">
              {artist.albums.map((album) => (
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
