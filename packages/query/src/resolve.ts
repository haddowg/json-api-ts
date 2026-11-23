/**
 * Resolving a member for a destination (design B1a): the copy of `type:id` that fits the shape the
 * destination promises, from what the caller passed or from the richest cached copy.
 *
 * Internal groundwork for optimistic drafts and read coherence; nothing here is public API.
 *
 * @internal
 */
import type { ApiDescriptor } from '@haddowg/json-api-client'
import type { QueryClient } from '@tanstack/query-core'
import { cacheView, describeCached } from './cache-index'
import { addresses } from './identity'
import { fits, type ViewShape } from './view-shape'

/** Where {@link resolveMember} looks, besides the cache. */
export interface ResolveOptions {
  /** The scope whose cached queries are searched; `undefined` searches unscoped queries only. */
  scope?: string | undefined
  /**
   * Members the caller already holds (a write's variables), tried before the cache. The first one
   * addressing `type:id` that fits wins.
   */
  candidates?: readonly unknown[] | undefined
}

/**
 * The copy of `type:id` that fits `shape`, or `undefined` when none does.
 *
 * 1. A caller-supplied candidate addressing `type:id` that fits wins, in the order given.
 * 2. Otherwise every cached copy in a query of the binding in `scope` (and only that scope) is
 *    tried, found through the cache index (./cache-index.ts), so per-edge views, included members
 *    and every page of an infinite query are seen, from the most recently updated query
 *    (`state.dataUpdatedAt`) to the least, and in walk order within a query. The first fitting copy
 *    is returned. Any fitting copy is rich enough, and the newest query's copy is the
 *    likeliest to hold current values.
 *
 * The copy returned is a cached object, possibly a per-edge view carrying its own edge's `$pivot`:
 * a caller placing it in another slot builds its own view over it rather than inserting it as is.
 *
 * @internal
 */
export function resolveMember(
  queryClient: QueryClient,
  type: string,
  id: string,
  shape: ViewShape,
  descriptor: ApiDescriptor,
  options: ResolveOptions = {},
): unknown {
  for (const candidate of options.candidates ?? []) {
    if (addresses(candidate, { type, id }) && fits(candidate, shape, descriptor)) {
      return candidate
    }
  }
  const view = cacheView(queryClient, options.scope, descriptor)
  const queries = view
    .ordered(view.holding(type, id))
    .filter((query) => {
      const description = describeCached(query, descriptor)
      return (
        description !== undefined &&
        !description.skipped &&
        description.scope === options.scope &&
        query.state.data !== undefined &&
        query.state.data !== null
      )
    })
    // `filter` returns a fresh array, so sorting it in place mutates nothing shared; `toSorted` is
    // ES2023, outside the ES2022 lib this package targets. The sort is stable, so queries updated
    // at once keep the cache's order.
    // oxlint-disable-next-line no-array-sort
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
  for (const query of queries) {
    for (const visit of view.visits(query, type, id)) {
      if (visit.first && fits(visit.node, shape, descriptor)) {
        return visit.node
      }
    }
  }
  return undefined
}
