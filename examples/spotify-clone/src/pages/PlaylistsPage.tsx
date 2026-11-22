import type { FormEvent } from 'react'
import type { ResourceMap, WriteAttributes } from '../generated/music-catalog.gen'
import { type PendingCreateOf, withPending } from '@haddowg/json-api-query'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { reads, writes } from '../api/client'
import { GradientArt } from '../components/GradientArt'
import { QueryState } from '../components/QueryState'

/** A create the list holds as a pending entry: its input, its id and where it belongs. */
type PendingPlaylist = PendingCreateOf<ResourceMap, WriteAttributes, 'playlists'>

/** A slug as a server might make one from a title, to show until the server's arrives. */
const slugOf = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/**
 * Playlists index + creation. The list is a typed `reads.playlists.list` read of whole playlists,
 * served newest first; the form drives `writes.playlists.create()`, a `useMutation` over the create
 * option factory.
 *
 * The create is optimistic. A create is never placed automatically (only the server knows where a
 * new resource belongs in a filtered, sorted or paged list), so `into` puts it at the top of the
 * unfiltered lists, where a newest-first server would. A list of whole playlists promises every
 * attribute: `slug`, which only the server sets, and `public` and `externalId`, which a create may
 * leave out. So `complete` gives the row a placeholder slug made from its title and fills the two
 * optional attributes the input didn't give (the server defaults `public` to true). The row
 * then shows as a real card, with a temporary id (`playlists` takes no client ids) and
 * `$optimistic: 'pending'`, until the write settles, when its id is swapped for the server's and the
 * type's lists refetch.
 *
 * A create whose row can't fill the list's shape, such as one made elsewhere without `complete`,
 * is kept by the list as a pending entry instead, which `withPending` merges in as a skeleton card.
 */
export function PlaylistsPage() {
  const playlistsQuery = useQuery(reads.playlists.list())
  const playlists = playlistsQuery.data

  const [title, setTitle] = useState('')
  const [isPublic, setIsPublic] = useState(true)

  const create = useMutation({
    ...writes.playlists.create({
      optimistic: {
        into: (q) => (q.params.filter === undefined ? 'start' : false),
        complete: (input) => ({
          slug: slugOf(input.title),
          public: input.public ?? true,
          externalId: input.externalId ?? null,
        }),
      },
    }),
    onSuccess: () => {
      setTitle('')
      setIsPublic(true)
    },
  })

  const trimmed = title.trim()
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (trimmed === '' || create.isPending) return
    create.mutate({ title: trimmed, public: isPublic })
  }

  // The members, with a skeleton for each create the list holds as a pending entry, in place.
  const rows = playlists ? withPending(playlists, (pending: PendingPlaylist) => ({ pending })) : []

  return (
    <div>
      <h1 className="page-title">Playlists</h1>

      <form className="create-form" onSubmit={onSubmit}>
        <input
          className="input"
          type="text"
          placeholder="New playlist name…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="New playlist name"
          disabled={create.isPending}
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            disabled={create.isPending}
          />
          Public
        </label>
        <button className="btn" type="submit" disabled={trimmed === '' || create.isPending}>
          {create.isPending ? 'Creating…' : 'Create playlist'}
        </button>
        {create.isError ? (
          <span className="form-error">{mutationMessage(create.error)}</span>
        ) : null}
      </form>

      <QueryState
        isPending={playlistsQuery.isPending}
        error={playlistsQuery.error}
        isEmpty={rows.length === 0}
        emptyLabel="No playlists yet — create one above."
      >
        <div className="grid">
          {rows.map((row) => {
            if ('pending' in row) {
              // A pending entry: what the user typed, until the refetch brings the server's row.
              const { id, input } = row.pending
              return (
                <div
                  key={id}
                  className="card card--skeleton"
                  aria-label={`Creating ${input.title}`}
                >
                  <div className="card__art">
                    <span className="skeleton-bar skeleton-bar--art" />
                  </div>
                  <div className="card__title">{input.title}</div>
                  <div className="card__subtitle">Creating…</div>
                </div>
              )
            }
            const playlist = row
            const card = (
              <>
                <div className="card__art">
                  <GradientArt seed={`playlist-${playlist.id}`} label={playlist.title} size={148} />
                </div>
                <div className="card__title">{playlist.title}</div>
                <div className="card__subtitle">{playlist.public ? 'Public' : 'Private'}</div>
              </>
            )
            // A pending playlist has only its temporary id, which no route can open yet.
            return playlist.$optimistic ? (
              <div key={playlist.id} className="card" data-optimistic={playlist.$optimistic}>
                {card}
              </div>
            ) : (
              <Link key={playlist.id} to={`/playlists/${playlist.id}`} className="card">
                {card}
              </Link>
            )
          })}
        </div>
      </QueryState>
    </div>
  )
}

function mutationMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not create the playlist.'
}
