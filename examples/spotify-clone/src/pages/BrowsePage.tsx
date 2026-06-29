import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { reads } from '../api/client'
import { GradientArt } from '../components/GradientArt'
import { QueryState } from '../components/QueryState'
import { formatYear } from '../lib/format'

/**
 * Browse: a grid of albums (each hydrating its `artist` via `include`, narrowed by a sparse
 * fieldset), a grid of artists, and the playlists. Every read goes through the bound query API +
 * react-query.
 */
export function BrowsePage() {
  const albumsQuery = useQuery(
    reads.albums.list({
      include: ['artist'],
      fields: { albums: ['title', 'releasedAt', 'status', 'artist'] },
      sort: '-releasedAt',
    }),
  )
  const artistsQuery = useQuery(reads.artists.list({ sort: 'name' }))
  // `playlists` advertises no server-side sort, so list as-is.
  const playlistsQuery = useQuery(reads.playlists.list())

  return (
    <div>
      <h1 className="page-title">Browse</h1>

      <h2 className="section-title">Albums</h2>
      <QueryState
        isPending={albumsQuery.isPending}
        error={albumsQuery.error}
        isEmpty={albumsQuery.data?.length === 0}
        emptyLabel="No albums."
      >
        <div className="grid">
          {albumsQuery.data?.map((album) => (
            <Link key={album.id} to={`/albums/${album.id}`} className="card">
              <div className="card__art">
                <GradientArt seed={`album-${album.id}`} label={album.title} size={148} />
              </div>
              <div className="card__title">{album.title}</div>
              <div className="card__subtitle">
                {album.artist?.name ?? 'Unknown artist'}
                {formatYear(album.releasedAt) ? ` · ${formatYear(album.releasedAt)}` : ''}
              </div>
            </Link>
          ))}
        </div>
      </QueryState>

      <h2 className="section-title">Artists</h2>
      <QueryState
        isPending={artistsQuery.isPending}
        error={artistsQuery.error}
        isEmpty={artistsQuery.data?.length === 0}
        emptyLabel="No artists."
      >
        <div className="grid">
          {artistsQuery.data?.map((artist) => (
            <Link key={artist.id} to={`/artists/${artist.id}`} className="card">
              <div className="card__art">
                <GradientArt
                  seed={`artist-${artist.id}`}
                  label={artist.name}
                  size={148}
                  shape="circle"
                />
              </div>
              <div className="card__title">{artist.name}</div>
              <div className="card__subtitle">{artist.trackCount} tracks</div>
            </Link>
          ))}
        </div>
      </QueryState>

      <h2 className="section-title">Playlists</h2>
      <QueryState
        isPending={playlistsQuery.isPending}
        error={playlistsQuery.error}
        isEmpty={playlistsQuery.data?.length === 0}
        emptyLabel="No playlists."
      >
        <div className="grid">
          {playlistsQuery.data?.map((playlist) => (
            <Link key={playlist.id} to={`/playlists/${playlist.id}`} className="card">
              <div className="card__art">
                <GradientArt seed={`playlist-${playlist.id}`} label={playlist.title} size={148} />
              </div>
              <div className="card__title">{playlist.title}</div>
              <div className="card__subtitle">{playlist.public ? 'Public' : 'Private'}</div>
            </Link>
          ))}
        </div>
      </QueryState>
    </div>
  )
}
