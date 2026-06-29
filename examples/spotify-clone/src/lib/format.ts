/** Small presentation helpers shared across views. */

/** Format a track duration (seconds) as `m:ss`. */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Format an ISO date/time as a plain year (the catalogue only ever shows release years). */
export function formatYear(iso: string | null | undefined): string {
  if (!iso) return ''
  const year = new Date(iso).getFullYear()
  return Number.isNaN(year) ? '' : String(year)
}

/**
 * A stable, well-distributed 32-bit hash of a string (FNV-1a). Used to derive deterministic
 * gradient hues from a resource id/title so the same resource always renders the same art.
 */
export function hashString(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
