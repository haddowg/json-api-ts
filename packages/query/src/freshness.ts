/**
 * Freshness stamps: which of two responses carrying the same resource is the newer.
 *
 * A read's or a write's result is stamped with the moment its request started, and the normalizer
 * (./normalize.ts) lets data with a later stamp win over data with an earlier one, whatever order
 * the responses arrive in. The stamp is a per-process counter rather than `Date.now()`: two
 * requests started in the same millisecond still get distinct, ordered stamps, and a clock change
 * can't reorder them. A counter means nothing outside the process that issued it, which is the
 * rule for data that crossed one anyway: a value hydrated from a server render or restored from
 * storage carries no stamp, and is treated as the oldest possible ({@link UNKNOWN_STAMP}), so any
 * read made in this process replaces it.
 *
 * Stamps live in a `WeakMap` keyed by the result's materialised value, so a result keeps its shape
 * and accessors and nothing is added to it.
 *
 * @internal
 */

/** The stamp of data whose request time is unknown: older than any request made here. */
export const UNKNOWN_STAMP = 0

/** The last stamp handed out. */
let clock = UNKNOWN_STAMP

/** A new stamp, later than every stamp handed out before it. */
export function nextStamp(): number {
  clock += 1
  return clock
}

/** The stamp each result was given, keyed by its materialised value. */
const resultStamps = new WeakMap<object, number>()

/** Record `stamp` as the request start of `result`, when it is an object. */
export function stampResult(result: unknown, stamp: number): void {
  if (typeof result === 'object' && result !== null) {
    resultStamps.set(result, stamp)
  }
}

/** Record `result` as of unknown age, unless it already carries a stamp. */
export function stampUnknown(result: object): void {
  if (!resultStamps.has(result)) {
    resultStamps.set(result, UNKNOWN_STAMP)
  }
}

/**
 * The stamp of `result`. A result nothing stamped, such as one an app's own query function
 * resolved, is stamped now, at its arrival, which keeps the order responses arrive in for data
 * that never said when it was requested. That stamp is recorded, so normalising the same result
 * again doesn't make it newer.
 */
export function stampOf(result: object): number {
  const known = resultStamps.get(result)
  if (known !== undefined) {
    return known
  }
  const stamp = nextStamp()
  resultStamps.set(result, stamp)
  return stamp
}

/**
 * `request()`, with what it resolves to stamped with the moment it was called: the start of the
 * request, however long the response takes.
 */
export function stamped<R>(request: () => Promise<R>): Promise<R> {
  const stamp = nextStamp()
  return request().then((result) => {
    stampResult(result, stamp)
    return result
  })
}
