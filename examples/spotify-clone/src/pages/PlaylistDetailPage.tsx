import type { Attributes, ResourceMap } from '../generated/music-catalog.gen'
import type { Collection, HydratedMember } from '@haddowg/json-api-client'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { PAGE_SIZE, reads, writes } from '../api/client'
import {
  addTrackMutation,
  orderedRefs,
  removeTrackMutation,
  reorderTracksMutation,
} from '../api/playlist-tracks'
import { GradientArt } from '../components/GradientArt'
import { QueryState } from '../components/QueryState'
import { TrackPicker } from '../components/TrackPicker'
import { formatDuration } from '../lib/format'

/** A related playlist track: the hydrated track resource plus its per-edge `$pivot`. */
type OrderedTrack = HydratedMember<ResourceMap, Attributes, 'tracks'> & {
  readonly $pivot: { position: number; addedAt?: string } | undefined
}

/**
 * Playlist detail + management. Reads the playlist and its ORDERED tracks (the related endpoint
 * carries the writable pivot `position`). Manages it through the relationship mutation factories,
 * each wrapped with an optimistic cache patch (`src/api/playlist-tracks.ts`):
 *  - rename — `update({ optimistic: true })`; the `type:id` write-through patch reflects the new
 *    title in the Playlists list / Browse with no refetch ("edit once, updates everywhere");
 *  - add / remove — relationship add/remove, optimistic + reconciled on settle;
 *  - reorder (move up/down) — a wholesale `replace` carrying each member's `$pivot.position`.
 */
export function PlaylistDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const playlistQuery = useQuery(reads.playlists.get(id))
  const tracksQuery = useQuery(
    reads.playlists.related(id, 'orderedTracks', { page: { size: PAGE_SIZE } }),
  )

  const playlist = playlistQuery.data
  const tracks = tracksQuery.data as Collection<OrderedTrack> | undefined
  const ordered: OrderedTrack[] = tracks ? [...tracks] : []

  const rename = useMutation(writes.playlists.id(id).update({ optimistic: true }))
  const add = useMutation(addTrackMutation(id))
  const remove = useMutation(removeTrackMutation(id))
  const reorder = useMutation(reorderTracksMutation(id))
  const busy = remove.isPending || reorder.isPending

  // Move a track one slot up/down: replace the whole set in the new order, carrying the pivot.
  const move = (from: number, to: number) => {
    if (to < 0 || to >= ordered.length || busy) return
    const next = [...ordered]
    const [moved] = next.splice(from, 1)
    if (!moved) return
    next.splice(to, 0, moved)
    reorder.mutate(orderedRefs(next))
  }

  return (
    <div>
      <QueryState isPending={playlistQuery.isPending} error={playlistQuery.error}>
        {playlist ? (
          <header className="detail-header">
            <GradientArt seed={`playlist-${playlist.id}`} label={playlist.title} size={184} />
            <div className="detail-header__meta">
              <span className="detail-header__kind">Playlist</span>
              <PlaylistTitle
                title={playlist.title}
                isSaving={rename.isPending}
                onSave={(title) => rename.mutate({ title })}
              />
              <div className="detail-header__sub">
                {playlist.public ? 'Public' : 'Private'} · {ordered.length} tracks
              </div>
            </div>
          </header>
        ) : null}
      </QueryState>

      <h2 className="section-title">Tracks</h2>
      <QueryState
        isPending={tracksQuery.isPending}
        error={tracksQuery.error}
        isEmpty={ordered.length === 0}
        emptyLabel="This playlist has no tracks yet — add some below."
      >
        <div className="tracklist">
          {ordered.map((track, i) => (
            <div key={track.id} className="track-row">
              <span className="track-row__index">{track.$pivot?.position ?? i + 1}</span>
              <Link to={`/albums/${track.album?.id ?? ''}`} className="track-row__title">
                {track.title}
              </Link>
              <span className="track-row__dur">{formatDuration(track.durationSeconds)}</span>
              <span className="track-row__actions">
                <button
                  className="btn--icon"
                  type="button"
                  aria-label={`Move ${track.title} up`}
                  disabled={i === 0 || busy}
                  onClick={() => move(i, i - 1)}
                >
                  ↑
                </button>
                <button
                  className="btn--icon"
                  type="button"
                  aria-label={`Move ${track.title} down`}
                  disabled={i === ordered.length - 1 || busy}
                  onClick={() => move(i, i + 1)}
                >
                  ↓
                </button>
                <button
                  className="btn--icon btn--danger"
                  type="button"
                  aria-label={`Remove ${track.title}`}
                  disabled={busy}
                  onClick={() => remove.mutate(track.id)}
                >
                  ✕
                </button>
              </span>
            </div>
          ))}
        </div>
      </QueryState>

      <h2 className="section-title">Add tracks</h2>
      <TrackPicker
        excludeIds={ordered.map((t) => t.id)}
        pendingId={add.isPending ? (add.variables?.id ?? null) : null}
        onAdd={(track) => add.mutate(track)}
      />
    </div>
  )
}

/** An inline-editable playlist title: click to edit, Enter / blur saves, Escape cancels. */
function PlaylistTitle({
  title,
  isSaving,
  onSave,
}: {
  title: string
  isSaving: boolean
  onSave: (title: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)

  if (!editing) {
    return (
      <h1
        className="detail-header__name detail-header__name--editable"
        onClick={() => {
          setDraft(title)
          setEditing(true)
        }}
        title="Click to rename"
      >
        {title}
      </h1>
    )
  }

  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (next !== '' && next !== title) onSave(next)
  }

  return (
    <input
      className="input detail-header__rename"
      type="text"
      value={draft}
      autoFocus
      disabled={isSaving}
      aria-label="Rename playlist"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
}
