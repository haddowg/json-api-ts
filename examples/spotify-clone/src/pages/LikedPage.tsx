import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PAGE_SIZE, reads } from '../api/client'
import { QueryState } from '../components/QueryState'

/**
 * The caller's liked tracks. `favoritable` is a WhereMorph filter on the polymorphic relation, so
 * `{ type: 'tracks' }` keeps the favorites of tracks and leaves liked albums and artists out.
 * `dated` is a WhereSet filter that defaults to dated favorites only; sending `[true, false]` asks
 * for both. The favorite's `favoritable` linkage names the track, whose title comes from the
 * catalogue read.
 */
export function LikedPage() {
  const [includeUndated, setIncludeUndated] = useState(false)
  const favoritesQuery = useQuery(
    reads.favorites.list({
      filter: {
        favoritable: { type: 'tracks' },
        ...(includeUndated ? { dated: [true, false] } : {}),
      },
      page: { size: PAGE_SIZE },
    }),
  )
  const tracksQuery = useQuery(
    reads.tracks.list({ fields: { tracks: ['title'] }, page: { size: PAGE_SIZE } }),
  )
  const titles = new Map((tracksQuery.data ?? []).map((track) => [track.id, track.title]))
  const favorites = favoritesQuery.data ?? []

  return (
    <div>
      <h1 className="page-title">Liked tracks</h1>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={includeUndated}
          onChange={(e) => setIncludeUndated(e.target.checked)}
        />
        Include undated likes
      </label>
      <QueryState
        isPending={favoritesQuery.isPending || tracksQuery.isPending}
        error={favoritesQuery.error ?? tracksQuery.error}
        isEmpty={favorites.length === 0}
        emptyLabel="No liked tracks yet."
      >
        <div className="tracklist">
          {favorites.map((favorite, i) => {
            const trackId = favorite.favoritable?.id ?? ''
            return (
              <div key={favorite.id} className="track-row">
                <span className="track-row__index">{i + 1}</span>
                <span className="track-row__title">{titles.get(trackId) ?? trackId}</span>
                <span className="track-row__dur">
                  {favorite.favoritedAt === null ? 'Undated' : favorite.favoritedAt.slice(0, 10)}
                </span>
              </div>
            )
          })}
        </div>
      </QueryState>
    </div>
  )
}
