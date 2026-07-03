/**
 * Playlist ordered-track ref builders for the relationship-mutation factories.
 *
 * The optimism itself is now the library's job: `writes.playlists.id(id).rel('orderedTracks')
 * .{add,remove,replace}({ optimistic: true })` patches the parent's cached related/relationship
 * reads BY KEY PREFIX (every page variant), snapshots, and rolls back on error — so the app no
 * longer reconstructs the page-coupled query key, snapshots by hand, or fabricates `onSettled` args
 * (D35b). All that remains here is the DOMAIN shape: `orderedTracks` declares two writable pivot
 * fields — `position` (required) and `weight` (constrained `weight >= position`) — so the app sends
 * `weight = position` (always valid, robust across later moves), and passes the full hydrated track
 * as the ref so the optimistic row renders its title immediately (the client sends only linkage on
 * the wire; the settle refetch reconciles).
 */

/** The minimal shape the ref builders need — any object addressable by `id` (a hydrated track). */
export type OrderedTrackLike = { id: string }

/**
 * A to-many linkage ref the app sends: the full hydrated track PLUS the writable pivot fields. It is
 * both the wire ref (the client extracts `type`/`id` + `meta.pivot`) and the optimistic array member
 * (the library preserves its extra props, so the row shows the real title before the refetch).
 */
export type TrackRef<T extends OrderedTrackLike = OrderedTrackLike> = T & {
  type: 'tracks'
  $pivot: { position: number; weight: number }
}

/** Build one positioned ref: the track carrying `$pivot.{position,weight}` (`weight = position`). */
export function trackRef<T extends OrderedTrackLike>(track: T, position: number): TrackRef<T> {
  return { ...track, type: 'tracks', id: track.id, $pivot: { position, weight: position } }
}

/**
 * Build the ordered `replace` refs for a reorder: each member positioned by its 1-based index
 * (`weight = position` to satisfy `weight >= position`). The client lifts each `$pivot` onto the
 * wire identifier's `meta.pivot`, and the optimistic patch renders the rows in this new order.
 */
export function orderedRefs<T extends OrderedTrackLike>(tracks: readonly T[]): TrackRef<T>[] {
  return tracks.map((track, i) => trackRef(track, i + 1))
}
