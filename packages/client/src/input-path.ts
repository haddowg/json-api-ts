/**
 * The flat input-path key format: `.` between names, `[n]` for a to-many member's index, as in
 * `orderedTracks[0].$pivot.position`. `byPath()` and `fieldErrors()` key errors by it.
 */
export function joinInputPath(segments: readonly (string | number)[]): string {
  return segments
    .map((segment, i) =>
      typeof segment === 'number' ? `[${segment}]` : i === 0 ? segment : `.${segment}`,
    )
    .join('')
}

/** The segments of a flat input-path key: `a[0].b` is `['a', 0, 'b']`. */
export function splitInputPath(key: string): (string | number)[] {
  return Array.from(key.matchAll(/([^.[\]]+)|\[(\d+)\]/g), ([, name, index]) =>
    index === undefined ? name! : Number(index),
  )
}
