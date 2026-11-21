/**
 * Playlist ordered-track ref builders for the relationship-mutation factories.
 *
 * The optimism is the library's, so none of it is here: the page passes `{ optimistic: true }` to
 * `writes.playlists.id(id).rel('orderedTracks').{add,remove,replace}()` and the mutation cache
 * applies, marks and rolls back the change through its draft. What remains is the DOMAIN shape of
 * the refs the page sends. `orderedTracks` declares two writable pivot fields, `position`
 * (required) and `weight` (constrained `weight >= position`), so the app sends `weight = position`
 * (always valid, robust across later moves). It passes the whole hydrated track as the ref, which
 * the draft places as a row where the view's fieldset is satisfied by it, and defers (`$pending`)
 * where it isn't. The client sends only linkage on the wire.
 */

/** The minimal shape the ref builders need: any object addressable by `id` (a hydrated track). */
export type OrderedTrackLike = { id: string }

/**
 * A to-many linkage ref the app sends: the full hydrated track PLUS the writable pivot fields. It is
 * both the wire ref (the client extracts `type`/`id` + `meta.pivot`) and the member the draft
 * places (it keeps the extra props, so a row can show the real title before the refetch).
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
 * wire identifier's `meta.pivot`, and the draft renders the rows in this new order.
 */
export function orderedRefs<T extends OrderedTrackLike>(tracks: readonly T[]): TrackRef<T>[] {
  return tracks.map((track, i) => trackRef(track, i + 1))
}
