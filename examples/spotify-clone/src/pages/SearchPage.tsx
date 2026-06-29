import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { reads } from '../api/client'
import { GradientArt } from '../components/GradientArt'
import { QueryState } from '../components/QueryState'
import { formatDuration, formatYear } from '../lib/format'

type SortKey = 'relevance' | 'title' | '-releasedAt'

/**
 * Search: one text box driving a single `filter[q]` + `sort` + sparse fieldsets across three typed
 * reads (albums / artists / tracks). The catalogue exposes the same full-text `q` filter on every
 * type (artists search both name and bio), so the one search key narrows all three server-side.
 * `fields` narrows each result to exactly the members the cards show, `sort` reorders the albums.
 * The three reads run in parallel; an empty term lists the full catalogue.
 */
export function SearchPage() {
  const [term, setTerm] = useState('')
  const [sort, setSort] = useState<SortKey>('relevance')
  const q = term.trim()
  // Build the params so the optional keys are ABSENT when unset (the read query is
  // `exactOptionalPropertyTypes`, so an explicit `undefined` is rejected). The shared `filter[q]`
  // drives all three reads; the album `sort` is applied only when a real key is chosen.
  const qFilter = q ? { filter: { q } } : {}
  const albumSort = sort === 'relevance' ? {} : { sort }

  const albumsQuery = useQuery(
    reads.albums.list({
      ...qFilter,
      ...albumSort,
      include: ['artist'],
      fields: { albums: ['title', 'releasedAt', 'artist'] },
    }),
  )
  const artistsQuery = useQuery(
    reads.artists.list({ ...qFilter, sort: 'name', fields: { artists: ['name', 'trackCount'] } }),
  )
  const tracksQuery = useQuery(
    reads.tracks.list({
      ...qFilter,
      include: ['album'],
      fields: { tracks: ['title', 'durationSeconds', 'album'] },
    }),
  )

  return (
    <div>
      <h1 className="page-title">Search</h1>

      <div className="search-bar">
        <input
          className="input"
          type="search"
          placeholder="Search albums, artists, tracks…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          aria-label="Search the catalogue"
        />
        <select
          className="select"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Sort albums"
        >
          <option value="relevance">Sort: default</option>
          <option value="title">Albums A–Z</option>
          <option value="-releasedAt">Albums newest</option>
        </select>
      </div>

      <h2 className="section-title">Albums</h2>
      <QueryState
        isPending={albumsQuery.isPending}
        error={albumsQuery.error}
        isEmpty={albumsQuery.data?.length === 0}
        emptyLabel="No matching albums."
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
        emptyLabel="No matching artists."
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

      <h2 className="section-title">Tracks</h2>
      <QueryState
        isPending={tracksQuery.isPending}
        error={tracksQuery.error}
        isEmpty={tracksQuery.data?.length === 0}
        emptyLabel="No matching tracks."
      >
        <ul className="list-clean tracklist">
          {tracksQuery.data?.map((track) => (
            <li key={track.id} className="track-row">
              <span className="track-row__index">♪</span>
              <span className="track-row__title">{track.title}</span>
              <span className="muted">
                {track.album ? (
                  <Link to={`/albums/${track.album.id}`} className="link-strong">
                    {track.album.title}
                  </Link>
                ) : null}
              </span>
              <span className="track-row__dur">{formatDuration(track.durationSeconds)}</span>
            </li>
          ))}
        </ul>
      </QueryState>
    </div>
  )
}
