/**
 * Auto-subscribe the Strategy-2 normalizer to a QueryClient.
 *
 * {@link installNormalization} wires {@link normalize} to fire on every successful query AND
 * mutation, so a fresh response patches the same `type:id` everywhere it is cached with no
 * per-call `onSuccess` plumbing. The returned function tears the subscription down again.
 *
 * Callers who prefer explicit control can skip this and call {@link normalize} from an option
 * factory's `onSuccess` instead — both routes do the same write-through patch. This module adds
 * no runtime dependency (it uses only the QueryClient's own cache-subscription seam).
 */
import type { ApiDescriptor } from '@haddowg/json-api-client'
import { defaultShouldDehydrateQuery, type Query, type QueryClient } from '@tanstack/query-core'
import type { ReadOperation } from './keys'
import { isMaterialisedData, normalize } from './normalize'
import { jsonApiRetry } from './read'

const READ_OPERATIONS: ReadonlySet<unknown> = new Set<ReadOperation>([
  'fetchMany',
  'fetchOne',
  'fetchRelated',
  'fetchRelationship',
])

/**
 * The key's first two segments, when it has the binding's shape: `[type, readOperation, …]`. Only
 * the browser-side hydration check reads it, since a hydrated query's stripped data can't be told
 * apart from plain data; the server-side dehydrate predicate judges a query by its data instead.
 */
const isBindingKey = (queryKey: readonly unknown[]): boolean =>
  typeof queryKey[0] === 'string' && READ_OPERATIONS.has(queryKey[1])

type ShouldDehydrate = (query: Query) => boolean

/**
 * A `shouldDehydrateQuery` predicate that leaves out every query holding a materialised client
 * result and otherwise defers to `next` (TanStack's `defaultShouldDehydrateQuery` when omitted). A
 * materialised result loses its `$`-accessors through `dehydrate` and JSON, so those queries are
 * fetched in the browser instead. {@link installNormalization} installs this as the client's
 * default; use it directly when passing explicit options to `dehydrate()`, which override the
 * defaults:
 *
 * ```ts
 * dehydrate(queryClient, {
 *   shouldDehydrateQuery: jsonApiShouldDehydrateQuery(
 *     (q) => defaultShouldDehydrateQuery(q) && q.queryKey[0] !== 'session',
 *   ),
 * })
 * ```
 *
 * It judges a query by its data, not its key, so it needs no descriptor: a query you build
 * yourself around a client call is left out like the binding's own reads, infinite reads
 * included, and a query holding plain data is passed to `next` whatever its key. A query still
 * pending has no data to judge, so it too is passed to `next`: including pending queries sends a
 * pending client read's result through JSON without its accessors.
 */
export function jsonApiShouldDehydrateQuery(next: ShouldDehydrate = defaultShouldDehydrateQuery) {
  return (query: Query): boolean => !isMaterialisedData(query.state.data) && next(query)
}

/** Hashes of queries already warned about, per client, so each warns once. */
const warned = new WeakMap<QueryClient, Set<string>>()

function warnOnce(queryClient: QueryClient, query: Query): void {
  const seen = warned.get(queryClient) ?? new Set<string>()
  warned.set(queryClient, seen)
  if (seen.has(query.queryHash)) {
    return
  }
  seen.add(query.queryHash)
  if (globalThis.process?.env?.NODE_ENV === 'production') {
    return
  }
  console.warn(
    `@haddowg/json-api-query: the query ${query.queryHash} arrived without its accessors ` +
      '(its data was dehydrated and hydrated, which strips them). Server-side rendering is not ' +
      'supported, so the query was refetched. See the "Server-side rendering" section of the ' +
      'TanStack Query docs.',
  )
}

/** Tear down an installed normalization subscription. Idempotent. */
export type Teardown = () => void

/**
 * Which descriptor is currently installed on a given QueryClient. The normalizer patches a cached
 * query by walking it with the *patch's* descriptor and matching on `type:id`, so two descriptors
 * sharing one QueryClient (e.g. a `default` + an `admin` server whose `users` carry different
 * attribute sets — one client per server) would cross-contaminate: a read from one would
 * overwrite the other's cached node with foreign attributes. The supported contract is therefore
 * ONE descriptor per QueryClient; this registry enforces it for the auto-install entry point.
 * A `WeakMap` so a discarded QueryClient (and its install record) is garbage-collected.
 */
const installed = new WeakMap<QueryClient, ApiDescriptor>()

/**
 * Subscribe the normalizer to a QueryClient's query + mutation caches: each time a query or
 * mutation settles successfully, the freshly-resolved data is indexed by `type:id` and patched
 * across every cached query in place (preserving edge-local `$pivot`/`$edge`).
 *
 * A QueryClient may host only ONE descriptor (see {@link installed}): installing a *second*,
 * different descriptor on the same QueryClient throws, because the normalizer cannot safely tell
 * which descriptor a given `type:id` belongs to once two descriptors overlap. Use one QueryClient
 * per typed client/server. Re-installing the *same* descriptor is allowed (idempotent-friendly):
 * it just adds another subscription pair with its own teardown.
 *
 * It also installs the client's defaults the binding relies on, each only where the app set none,
 * and removes them on teardown while they are still the installed value: a `dehydrate`
 * predicate that leaves out every query holding a client result, and {@link jsonApiRetry} as `queries.retry`, so a
 * read failing with a 4xx JSON:API error or a non-JSON:API response isn't retried.
 *
 * Re-entrancy is guarded: the patch pass itself sets data on other queries (firing further
 * `success` events), so while a pass runs we ignore the events it generates — otherwise a
 * single response would cascade into a loop. Returns a {@link Teardown} that removes both
 * subscriptions (and clears the install record when this was the active install).
 */
export function installNormalization(
  queryClient: QueryClient,
  descriptor: ApiDescriptor,
): Teardown {
  const existing = installed.get(queryClient)
  if (existing !== undefined && existing !== descriptor) {
    throw new Error(
      'installNormalization: this QueryClient already has a different descriptor installed. ' +
        'A QueryClient may host only one descriptor — use a separate QueryClient per client/server ' +
        'so a normalize pass cannot leak one descriptor’s attributes into another’s cached resources.',
    )
  }
  installed.set(queryClient, descriptor)

  // Dehydrate default: queries holding a client result are fetched in the browser instead.
  const previousDehydrate = queryClient.getDefaultOptions().dehydrate?.shouldDehydrateQuery
  const shouldDehydrateQuery = jsonApiShouldDehydrateQuery(
    previousDehydrate ?? defaultShouldDehydrateQuery,
  )
  const withDehydrate = (fn: ShouldDehydrate | undefined) => {
    const current = queryClient.getDefaultOptions()
    const { shouldDehydrateQuery: _replaced, ...rest } = current.dehydrate ?? {}
    queryClient.setDefaultOptions({
      ...current,
      dehydrate: fn === undefined ? rest : { ...rest, shouldDehydrateQuery: fn },
    })
  }
  withDehydrate(shouldDehydrateQuery)

  // Retry default: the JSON:API policy, only when the app configured no `retry` of its own.
  const installsRetry = queryClient.getDefaultOptions().queries?.retry === undefined
  const withRetry = (retry: typeof jsonApiRetry | undefined) => {
    const current = queryClient.getDefaultOptions()
    const { retry: _replaced, ...rest } = current.queries ?? {}
    queryClient.setDefaultOptions({
      ...current,
      queries: retry === undefined ? rest : { ...rest, retry },
    })
  }
  if (installsRetry) {
    withRetry(jsonApiRetry)
  }

  let normalizing = false

  const run = (data: unknown): void => {
    if (normalizing || data === undefined || data === null) {
      return
    }
    normalizing = true
    try {
      normalize(queryClient, data, descriptor)
    } finally {
      normalizing = false
    }
  }

  const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
    // Hydration check: a binding query added with data that isn't a materialised value lost its
    // accessors on the way through JSON, so refetch it (deferred, so not inside `hydrate`'s loop).
    if (event.type === 'added') {
      const { query } = event
      if (
        isBindingKey(query.queryKey) &&
        query.state.data !== undefined &&
        !isMaterialisedData(query.state.data)
      ) {
        warnOnce(queryClient, query)
        queueMicrotask(() => {
          void queryClient.resetQueries({ queryKey: query.queryKey, exact: true })
        })
      }
      return
    }
    // Patch on a settled success — the query's data is the freshest copy of its resources.
    if (event.type === 'updated' && event.action.type === 'success') {
      run(event.query.state.data)
    }
  })

  const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
    // A write that returns a resource (create/update) carries the freshest attributes; index +
    // patch them. A mutation that resolves nothing (a `204` delete) has no data — `run` no-ops.
    if (event.type === 'updated' && event.action.type === 'success') {
      run(event.mutation.state.data)
    }
  })

  let torn = false
  return () => {
    if (torn) {
      return
    }
    torn = true
    unsubscribeQueries()
    unsubscribeMutations()
    if (queryClient.getDefaultOptions().dehydrate?.shouldDehydrateQuery === shouldDehydrateQuery) {
      withDehydrate(previousDehydrate)
    }
    if (installsRetry && queryClient.getDefaultOptions().queries?.retry === jsonApiRetry) {
      withRetry(undefined)
    }
    // Release the install record so a different descriptor can be installed afterwards (only when
    // ours is still the active record — a same-descriptor re-install left it pointing at the same
    // descriptor, so clearing it is correct either way).
    if (installed.get(queryClient) === descriptor) {
      installed.delete(queryClient)
    }
  }
}
