import type { FormEvent } from 'react'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { reads, writes } from '../api/client'
import { GradientArt } from '../components/GradientArt'
import { QueryState } from '../components/QueryState'

/**
 * Playlists index + creation. The list is a typed `reads.playlists.list` read, served newest first;
 * the form drives `writes.playlists.create()` — a `useMutation` over the create option factory.
 * The create is optimistic: a create is never placed automatically (only the server knows where a
 * new resource belongs in a filtered, sorted or paged list), so `into` puts it at the top of the
 * unfiltered lists, where a newest-first server would. The row appears only in a list whose
 * fieldset the create's input satisfies, which is why the list selects `title` and `public`. It
 * carries a temporary id
 * (`playlists` takes no client ids) and `$optimistic: 'pending'` until the write settles, when its
 * id is swapped for the server's and the type's lists refetch.
 */
export function PlaylistsPage() {
  // The cards show a title and visibility, so the read selects just those: the create's own input
  // then satisfies the list's shape, which a list of whole playlists (with server-made `slug`
  // and the like) would refuse the optimistic row for.
  const playlistsQuery = useQuery(
    reads.playlists.list({ fields: { playlists: ['title', 'public'] } }),
  )
  const playlists = playlistsQuery.data

  const [title, setTitle] = useState('')
  const [isPublic, setIsPublic] = useState(true)

  const create = useMutation({
    ...writes.playlists.create({
      optimistic: { into: (q) => (q.params.filter === undefined ? 'start' : false) },
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
        isEmpty={playlists?.length === 0}
        emptyLabel="No playlists yet — create one above."
      >
        <div className="grid">
          {playlists?.map((playlist) => {
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
