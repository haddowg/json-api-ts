import type { FormEvent } from 'react'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { reads, writes } from '../api/client'
import { GradientArt } from '../components/GradientArt'
import { QueryState } from '../components/QueryState'

/**
 * Playlists index + creation. The list is a typed `reads.playlists.list` read; the form drives
 * `writes.playlists.create()` — a `useMutation` over the create option factory. On success the
 * factory invalidates the type's list subtree, so the new playlist appears with no manual refetch
 * (and the fresh resource is normalized into the cache for any view already holding it).
 */
export function PlaylistsPage() {
  // `playlists` advertises no server-side sort, so list unsorted and order by title client-side.
  const playlistsQuery = useQuery(reads.playlists.list())
  const playlists = playlistsQuery.data?.toSorted((a, b) => a.title.localeCompare(b.title))

  const [title, setTitle] = useState('')
  const [isPublic, setIsPublic] = useState(true)

  const create = useMutation({
    ...writes.playlists.create(),
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
          {playlists?.map((playlist) => (
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

function mutationMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not create the playlist.'
}
