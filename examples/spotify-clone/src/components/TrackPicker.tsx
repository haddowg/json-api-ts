import type { OrderedTrackLike } from '../api/playlist-tracks'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { reads } from '../api/client'
import { formatDuration } from '../lib/format'
import { QueryState } from './QueryState'

interface TrackPickerProps {
  /** Track ids already in the playlist — shown as disabled "Added". */
  excludeIds: string[]
  /** The id of the track whose add is in flight (shows a per-row pending state). */
  pendingId: string | null
  /** Called with the full catalogue track to add (so the add can patch the cache optimistically). */
  onAdd: (track: OrderedTrackLike) => void
}

/**
 * A catalogue track picker: a search box driving the shared full-text `filter[q]` over a typed
 * `reads.tracks.list` (with `include: ['album']` so a row can link to its album), each row an
 * "Add" button. The search reuses the same typed read surface the rest of the app does.
 */
export function TrackPicker({ excludeIds, pendingId, onAdd }: TrackPickerProps) {
  const [term, setTerm] = useState('')
  const q = term.trim()
  const filter = q ? { filter: { q } } : {}
  const excluded = new Set(excludeIds)

  const tracksQuery = useQuery(
    reads.tracks.list({
      ...filter,
      include: ['album'],
      fields: { tracks: ['title', 'durationSeconds', 'album'] },
    }),
  )

  return (
    <div className="picker">
      <input
        className="input"
        type="search"
        placeholder="Search tracks to add…"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        aria-label="Search tracks to add"
      />

      <QueryState
        isPending={tracksQuery.isPending}
        error={tracksQuery.error}
        isEmpty={tracksQuery.data?.length === 0}
        emptyLabel="No matching tracks."
      >
        <ul className="list-clean picker__list">
          {tracksQuery.data?.map((track) => {
            const added = excluded.has(track.id)
            const pending = pendingId === track.id
            return (
              <li key={track.id} className="picker__row">
                <span className="picker__title">{track.title}</span>
                <span className="muted">{track.album?.title ?? ''}</span>
                <span className="track-row__dur">{formatDuration(track.durationSeconds)}</span>
                <button
                  className="btn--ghost"
                  type="button"
                  disabled={added || pending}
                  aria-label={`Add ${track.title}`}
                  onClick={() => onAdd(track as unknown as OrderedTrackLike)}
                >
                  {added ? 'Added' : pending ? 'Adding…' : 'Add'}
                </button>
              </li>
            )
          })}
        </ul>
      </QueryState>
    </div>
  )
}
