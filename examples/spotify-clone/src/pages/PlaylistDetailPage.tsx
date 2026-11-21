import type { Attributes, ResourceMap } from '../generated/music-catalog.gen'
import { type Collection, type HydratedMember, JsonApiError } from '@haddowg/json-api-client'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { PAGE_SIZE, reads, writes } from '../api/client'
import { orderedRefs, type OrderedTrackLike, trackRef } from '../api/playlist-tracks'
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
 * carries the writable pivot `position`). Every write is optimistic (`{ optimistic: true }`): the
 * mutation cache applies it to every cached copy through its draft, marks what it touched, rolls it
 * back if the server refuses, and refetches once the last overlapping write settles. The page only
 * renders those marks:
 *  - rename: `writes.playlists.update()`, with the id in the variables. The title shows at once,
 *    and the `type:id` write-through patch reflects it in the Playlists list and Browse with no
 *    refetch ("edit once, updates everywhere");
 *  - remove / reorder: the row leaves, or the rows swap, at once. A row a pending write touched
 *    carries `$optimistic`, rendered as `data-optimistic="pending"`;
 *  - add: the picker's track is a catalogue row narrowed to the picker's fieldset, which the
 *    playlist's tracks view can't render, so the draft defers it: the view keeps its rows and the
 *    playlist reports the member through `$pending('orderedTracks')`, drawn here as a skeleton row
 *    until the write settles and the refetch brings the server's row.
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
  // Members a pending write is adding that no cached view could render (see the header note).
  const adding = playlist?.$pending('orderedTracks') ?? []

  const relTracks = writes.playlists.id(id).rel('orderedTracks')
  const rename = useMutation(writes.playlists.update({ optimistic: true }))
  const add = useMutation(relTracks.add({ optimistic: true }))
  const remove = useMutation(relTracks.remove({ optimistic: true }))
  const reorder = useMutation(relTracks.replace({ optimistic: true }))
  const busy = remove.isPending || reorder.isPending

  // A rolled-back write leaves its error on its mutation; show the first, and clear a stale one
  // when the next write starts.
  const mutations = [rename, add, remove, reorder]
  const failed = mutations.find((m) => m.isError)
  const clearErrors = () => {
    for (const m of mutations) if (m.isError) m.reset()
  }

  // Move a track one slot up/down: replace the whole set in the new order, carrying the pivot.
  const move = (from: number, to: number) => {
    if (to < 0 || to >= ordered.length || busy) return
    const next = [...ordered]
    const [moved] = next.splice(from, 1)
    if (!moved) return
    next.splice(to, 0, moved)
    clearErrors()
    reorder.mutate(orderedRefs(next))
  }

  // Append a track: the catalogue row carrying its pivot position (end of the current list). An
  // addition is placed at the end of this complete, unfiltered, unsorted view automatically.
  const addTrack = (track: OrderedTrackLike) => {
    clearErrors()
    add.mutate([trackRef(track, ordered.length + 1)])
  }

  // The id of the in-flight add (its ref carries `id`), for the picker's pending indicator.
  const pendingAddId = (() => {
    const ref = add.variables?.[0]
    return ref !== undefined && 'id' in ref ? ref.id : null
  })()

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
                pending={playlist.$optimistic === 'pending'}
                isSaving={rename.isPending}
                onSave={(title) => {
                  clearErrors()
                  rename.mutate({ id, title })
                }}
              />
              <div className="detail-header__sub">
                {playlist.public ? 'Public' : 'Private'} · {ordered.length} tracks
              </div>
            </div>
          </header>
        ) : null}
      </QueryState>

      <h2 className="section-title">Tracks</h2>
      {failed ? (
        <p className="state state--error" role="alert">
          {failed.error ? errorDetail(failed.error) : 'The change was not saved.'}
        </p>
      ) : null}
      <QueryState
        isPending={tracksQuery.isPending}
        error={tracksQuery.error}
        isEmpty={ordered.length === 0 && adding.length === 0}
        emptyLabel="This playlist has no tracks yet — add some below."
      >
        <div className="tracklist">
          {ordered.map((track, i) => (
            <div key={track.id} className="track-row" data-optimistic={track.$optimistic}>
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
                  onClick={() => {
                    clearErrors()
                    remove.mutate([{ type: 'tracks', id: track.id }])
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
          ))}
          {adding.map((ref) => (
            <div key={ref.id} className="track-row track-row--skeleton" aria-label="Adding a track">
              <span className="track-row__index">{ordered.length + 1}</span>
              <span className="skeleton-bar" />
              <span className="track-row__dur">Adding…</span>
              <span className="track-row__actions" />
            </div>
          ))}
        </div>
      </QueryState>

      <h2 className="section-title">Add tracks</h2>
      <TrackPicker
        excludeIds={ordered.map((t) => t.id)}
        pendingId={add.isPending ? pendingAddId : null}
        onAdd={addTrack}
      />
    </div>
  )
}

/** The server's own explanation of a refused write, else the error's message. */
function errorDetail(error: Error): string {
  return (error instanceof JsonApiError ? error.errors[0]?.detail : undefined) ?? error.message
}

/** An inline-editable playlist title: click to edit, Enter / blur saves, Escape cancels. */
function PlaylistTitle({
  title,
  pending,
  isSaving,
  onSave,
}: {
  title: string
  /** The shown title is a pending write's prediction. */
  pending: boolean
  isSaving: boolean
  onSave: (title: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)

  if (!editing) {
    return (
      <h1
        className="detail-header__name detail-header__name--editable"
        data-optimistic={pending ? 'pending' : undefined}
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
