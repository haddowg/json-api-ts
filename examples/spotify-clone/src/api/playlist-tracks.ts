/**
 * Optimistic playlist-track mutations: thin wrappers over the `@haddowg/json-api-query` relationship
 * mutation factories (`writes.playlists.id(id).rel('orderedTracks').{add,remove,replace}`) that add
 * an `onMutate`/`onError` optimistic patch of the related-tracks cache.
 *
 * The factories already do the right thing on settle — they invalidate the parent's relations
 * subtree so the related read reconciles against the server. Here we ALSO pre-apply the expected
 * order to the cached `Collection` so the UI reflects add / remove / reorder immediately, snapshot
 * it for rollback, and carry the writable pivot `position` on a reorder via each ref's `$pivot`.
 */
import type { MutationOptions } from '@haddowg/json-api-query'
import { queryClient, reads, writes } from './client'

/** A related ordered track as the page reads it: a hydrated track carrying its per-edge `$pivot`. */
export interface OrderedTrackLike {
  id: string
  $pivot?: { position: number; weight?: number; addedAt?: string }
  [key: string]: unknown
}

/**
 * A to-many linkage ref the app sends: a track identifier carrying the writable pivot fields
 * (for an add or a reorder). `orderedTracks` declares two writable pivot fields — `position` and
 * `weight`, constrained `weight >= position` — so the app sends `weight = position` (always valid,
 * and robust against later moves). Narrower than the client's full `LinkageRef` union (no
 * `lid`/object branches the app never uses), and assignable to it at the mutation boundary.
 */
interface TrackRef {
  type: 'tracks'
  id: string
  $pivot?: { position: number; weight: number }
}

/** The query key of a playlist's related ordered-tracks read (what we patch optimistically). */
function orderedTracksKey(playlistId: string) {
  return reads.playlists.related(playlistId, 'orderedTracks').queryKey
}

/** Read the current cached ordered tracks (or an empty array when nothing is cached yet). */
function currentOrdered(playlistId: string): OrderedTrackLike[] {
  const data = queryClient.getQueryData(orderedTracksKey(playlistId))
  return Array.isArray(data) ? (data as OrderedTrackLike[]) : []
}

/**
 * Renumber a list's `$pivot.position` (and matching `weight`) to its 1-based index — the canonical
 * playlist order. `weight` tracks `position` so the server's `weight >= position` rule always holds.
 */
function renumbered(tracks: OrderedTrackLike[]): OrderedTrackLike[] {
  return tracks.map((track, i) => ({
    ...track,
    $pivot: { ...track.$pivot, position: i + 1, weight: i + 1 },
  }))
}

/**
 * Optimistically write the cached ordered tracks and return a rollback. The mutation lifecycle wires
 * this: `onMutate` applies + snapshots, `onError` restores. The factory's own `onSettled` then
 * invalidates so a refetch reconciles against the server.
 */
function applyOptimistic(playlistId: string, next: OrderedTrackLike[]): () => void {
  const key = orderedTracksKey(playlistId)
  const previous = queryClient.getQueryData(key)
  queryClient.setQueryData(key, renumbered(next))
  return () => queryClient.setQueryData(key, previous)
}

/**
 * Wrap a relationship `MutationOptions` with an optimistic `onMutate`/`onError`, preserving the
 * factory's `onSettled` (which invalidates the relations subtree so the read reconciles). The
 * factory's `onSettled` ignores its arguments, so we invoke it argument-free.
 */
function withOptimism<TVars>(
  base: MutationOptions<unknown, TVars>,
  computeNext: (vars: TVars) => OrderedTrackLike[],
  playlistId: string,
): MutationOptions<unknown, TVars, { rollback: () => void }> {
  const settle = base.onSettled
  return {
    mutationFn: base.mutationFn,
    onMutate: (vars) => ({ rollback: applyOptimistic(playlistId, computeNext(vars)) }),
    onError: (_error, _vars, context) => context?.rollback(),
    onSettled: (_d, _e, vars) => settle?.(undefined, null, vars, undefined),
  }
}

/**
 * Add-mutation options whose VARIABLE is the full catalogue track (so the optimistic patch can
 * append the real resource, not just a bare id) — the wire add still sends only its linkage ref.
 * Drives `useMutation` directly: `useMutation(addTrackMutation(id)).mutate(track)`.
 */
export function addTrackMutation(
  playlistId: string,
): MutationOptions<unknown, OrderedTrackLike, { rollback: () => void }> {
  const base = writes.playlists.id(playlistId).rel('orderedTracks').add()
  const settle = base.onSettled
  return {
    mutationFn: (track) => {
      // `orderedTracks` requires the writable pivot `position` AND `weight` on a new member (the
      // server rejects a bare identifier with 422). The optimistic onMutate has already appended +
      // renumbered the track, so reuse that position (append = end of the list); `weight = position`
      // satisfies the server's `weight >= position` rule.
      const ordered = currentOrdered(playlistId)
      const position =
        ordered.find((t) => t.id === track.id)?.$pivot?.position ?? ordered.length + 1
      return base.mutationFn([
        { type: 'tracks', id: track.id, $pivot: { position, weight: position } },
      ])
    },
    onMutate: (track) => ({
      rollback: applyOptimistic(playlistId, [
        ...currentOrdered(playlistId).filter((t) => t.id !== track.id),
        track,
      ]),
    }),
    onError: (_error, _track, context) => context?.rollback(),
    onSettled: (_d, _e, track) =>
      settle?.(undefined, null, [{ type: 'tracks', id: track.id }], undefined),
  }
}

/**
 * Remove-mutation options whose variable is the track id. Drives `useMutation` directly:
 * `useMutation(removeTrackMutation(id)).mutate(trackId)`.
 */
export function removeTrackMutation(
  playlistId: string,
): MutationOptions<unknown, string, { rollback: () => void }> {
  const base = writes.playlists.id(playlistId).rel('orderedTracks').remove()
  const settle = base.onSettled
  return {
    mutationFn: (trackId) => base.mutationFn([{ type: 'tracks', id: trackId }]),
    onMutate: (trackId) => ({
      rollback: applyOptimistic(
        playlistId,
        currentOrdered(playlistId).filter((t) => t.id !== trackId),
      ),
    }),
    onError: (_error, _trackId, context) => context?.rollback(),
    onSettled: (_d, _e, trackId) =>
      settle?.(undefined, null, [{ type: 'tracks', id: trackId }], undefined),
  }
}

/**
 * Reorder a playlist's ordered tracks via a wholesale `replace` carrying each member's writable
 * pivot `position` (`$pivot`). The variables are the fully ordered refs; the optimistic patch maps
 * each ref back to its cached track in that order.
 */
export function reorderTracksMutation(playlistId: string) {
  return withOptimism<readonly TrackRef[]>(
    writes.playlists.id(playlistId).rel('orderedTracks').replace(),
    (refs) => {
      const byId = new Map(currentOrdered(playlistId).map((t) => [t.id, t]))
      return refs.flatMap((ref) => {
        const track = byId.get(ref.id)
        return track ? [track] : []
      })
    },
    playlistId,
  )
}

/**
 * Build the ordered `replace` refs for a reorder: each member's
 * `{ type, id, $pivot: { position, weight } }`, positioned by its index (`weight = position` to
 * satisfy `weight >= position`). The client lifts `$pivot` onto the wire identifier's `meta.pivot`.
 */
export function orderedRefs(tracks: readonly { id: string }[]): TrackRef[] {
  return tracks.map((track, i) => ({
    type: 'tracks',
    id: track.id,
    $pivot: { position: i + 1, weight: i + 1 },
  }))
}
