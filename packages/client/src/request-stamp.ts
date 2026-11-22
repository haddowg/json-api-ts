/**
 * Request stamps: when the request behind a result started, relative to every other request made in
 * this process.
 *
 * The client takes a stamp as each request starts and records it on the top-level value it
 * materialises from the response: a read's resource, collection or linkage (`$next()`/`$prev()`
 * pages included), a write's returned resource, and an atomic batch's results. A cache can then
 * tell which of two results carrying the same resource is the newer, whatever order their
 * responses arrived in.
 *
 * The stamp is a per-process counter rather than `Date.now()`: two requests started in the same
 * millisecond still get distinct, ordered stamps, and a clock change can't reorder them. It means
 * nothing outside the process that issued it, so a value that crossed one (through JSON on a server
 * render, or storage) carries none. Stamps live in a `WeakMap` keyed by the result, so the result
 * keeps its shape and nothing is added to it.
 *
 * @internal
 */

/** The last stamp handed out; `0` is older than any request (no request is ever stamped `0`). */
let clock = 0

/**
 * A new stamp, later than every stamp handed out before it. The client takes one as each request
 * starts; anything ordering its own events against the client's requests takes them here too.
 * @internal
 */
export function nextRequestStamp(): number {
  clock += 1
  return clock
}

const stamps = new WeakMap<object, number>()

/**
 * Record `stamp` as the start of the request `value` was materialised from, when it is an object.
 * Returns `value`.
 * @internal
 */
export function stampRequest<T>(value: T, stamp: number): T {
  if (typeof value === 'object' && value !== null) {
    stamps.set(value, stamp)
  }
  return value
}

/**
 * The stamp of the request `value` was materialised from: a top-level result the client returned.
 * `undefined` for anything else, such as a plain copy of a result, a nested resource, or data the
 * client never returned.
 * @internal
 */
export function requestStampOf(value: unknown): number | undefined {
  return typeof value === 'object' && value !== null ? stamps.get(value) : undefined
}
