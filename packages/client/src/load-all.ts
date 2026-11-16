import type { Collection } from './result-types'

/** Options for {@link loadAll}. */
export interface LoadAllOptions {
  /** Stops the walk, rejecting with the signal's reason. */
  signal?: AbortSignal
  /** Stop after this many pages, as a guard against an unexpectedly large collection. */
  maxPages?: number
}

/**
 * Follow `next` links from a first page until the last, and return every member in one plain
 * array. It takes any collection: a list, a related read, or a to-many relationship of a resource
 * you read, which holds only its first page of members when the server renders its linkage:
 *
 * ```ts
 * const album = await client.albums.get('1', { include: ['tracks'] })
 * const tracks = await loadAll(album.tracks)
 * ```
 */
export async function loadAll<T>(
  first: Collection<T> | PromiseLike<Collection<T>>,
  options: LoadAllOptions = {},
): Promise<T[]> {
  const { signal, maxPages = Number.POSITIVE_INFINITY } = options
  let page: Collection<T> | undefined = await first
  const all: T[] = []
  let count = 0
  while (page !== undefined && count < maxPages) {
    all.push(...page)
    count++
    if (count >= maxPages) {
      break
    }
    signal?.throwIfAborted()
    page = await page.$next(signal !== undefined ? { signal } : undefined)
  }
  return all
}
