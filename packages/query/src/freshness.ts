/**
 * Freshness stamps: which of two responses carrying the same resource is the newer.
 *
 * The client stamps every result it returns with the moment its request started (its
 * `requestStampOf`), and the normalizer (./normalize.ts) lets data with a later stamp win over data
 * with an earlier one, whatever order the responses arrive in. Any client result competes that way:
 * a factory's read or write, and a query an app builds around a client call alike. The stamp is the
 * client's per-process counter, which this module shares (`nextStamp`), so a stamp taken here orders
 * against every request the client made. A counter means nothing outside the process that issued
 * it, which is the rule for data that crossed one: a value hydrated from a server render or
 * restored from storage carries no stamp, and is treated as the oldest possible
 * ({@link UNKNOWN_STAMP}), so any read made in this process replaces it.
 *
 * This module also records stamps of its own, in a `WeakMap` keyed by the result's materialised
 * value, and they take precedence over the client's: a list a membership edit derived from a result
 * carries that result's stamp, data an app writes with `setQueryData` is stamped when it is written
 * (the app asserts it is current now), and a result that no request stamped is stamped at its
 * arrival.
 *
 * @internal
 */

import { nextRequestStamp, requestStampOf } from '@haddowg/json-api-client'

/** The stamp of data whose request time is unknown: older than any request made here. */
export const UNKNOWN_STAMP = 0

/** A new stamp, later than every stamp handed out before it, the client's included. */
export const nextStamp: () => number = nextRequestStamp

/** The stamp this module gave each result, keyed by its materialised value. */
const resultStamps = new WeakMap<object, number>()

/** Record `stamp` as the request start of `result`, when it is an object. */
export function stampResult(result: unknown, stamp: number): void {
  if (typeof result === 'object' && result !== null) {
    resultStamps.set(result, stamp)
  }
}

/** Record `result` as of unknown age, unless it already carries a stamp. */
export function stampUnknown(result: object): void {
  if (peekStamp(result) === undefined) {
    resultStamps.set(result, UNKNOWN_STAMP)
  }
}

/**
 * Record `result` as current now: data the app wrote itself (`setQueryData`), whatever request
 * produced it.
 */
export function stampNow(result: object): void {
  resultStamps.set(result, nextStamp())
}

/**
 * The stamp `result` carries: the one recorded here, else the client's request stamp, else
 * `undefined` when nothing stamped it yet.
 */
export function peekStamp(result: object): number | undefined {
  return resultStamps.get(result) ?? requestStampOf(result)
}

/**
 * The stamp of `result`. A result nothing stamped, such as a value an app's own query function
 * built rather than a client call returned, is stamped now, at its arrival, which keeps the order
 * responses arrive in for data that never said when it was requested. That stamp is recorded, so
 * normalising the same result again doesn't make it newer.
 */
export function stampOf(result: object): number {
  const known = peekStamp(result)
  if (known !== undefined) {
    return known
  }
  const stamp = nextStamp()
  resultStamps.set(result, stamp)
  return stamp
}

/**
 * `request()`, with what it resolves to stamped with the moment it was called, unless the client
 * stamped it with the start of its own request. A mutation's result that a client call returned
 * keeps the client's stamp; any other value it resolves to is as old as the mutation's start.
 */
export function stampedUnlessClient<R>(request: () => Promise<R>): Promise<R> {
  const stamp = nextStamp()
  return request().then((result) => {
    if (typeof result === 'object' && result !== null && requestStampOf(result) === undefined) {
      stampResult(result, stamp)
    }
    return result
  })
}
