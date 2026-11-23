/**
 * Resolving a member for a destination (design B1a): the copy of `type:id` that fits the shape the
 * destination promises, from what the caller passed or from the richest cached copy.
 *
 * Internal groundwork for optimistic drafts and read coherence; nothing here is public API.
 *
 * @internal
 */
import { type ApiDescriptor, edgeViewOf, identifierViewOf } from '@haddowg/json-api-client'
import type { QueryClient } from '@tanstack/query-core'
import { type CacheView, cacheView, describeCached } from './cache-index'
import { addresses } from './identity'
import { adoptRecord } from './normalize'
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
  /**
   * The scope's cache index, when the caller holds one taken during the same synchronous pass: it is
   * brought up to date rather than taken again.
   */
  view?: CacheView | undefined
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
  const view = options.view ?? cacheView(queryClient, options.scope, descriptor)
  options.view?.update()
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

/**
 * `edge` as it enters a slot of `shape`: an identifier view, or a per-edge view over the copy
 * {@link resolveMember} finds (trying `candidates()` first, and reading `index` when given) that keeps
 * only what the shape selects, holding that copy's server record; `undefined` when no copy fits.
 *
 * @internal
 */
export function memberViewFor(
  queryClient: QueryClient,
  edge: { readonly type: string; readonly id: string; readonly meta?: Record<string, unknown> },
  shape: ViewShape,
  descriptor: ApiDescriptor,
  scope: string | undefined,
  candidates: () => readonly unknown[],
  index?: CacheView,
): object | undefined {
  if (shape.kind === 'identifiers') {
    return identifierViewOf(edge)
  }
  const found = resolveMember(queryClient, edge.type, edge.id, shape, descriptor, {
    scope,
    candidates: candidates(),
    view: index,
  })
  if (typeof found !== 'object' || found === null) {
    return undefined
  }
  const attributes = shape.attributes.get(edge.type)
  const relations = shape.rendered.get(edge.type)
  const view = edgeViewOf(
    found,
    edge,
    (key) => attributes?.has(key) === true || relations?.has(key) === true,
  )
  adoptRecord(view, found)
  return view
}
