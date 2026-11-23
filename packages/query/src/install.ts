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
import { type ReadOperation, scopeOf } from './keys'
import { isMaterialisedData, normalize } from './normalize'
import { jsonApiRetry } from './read'
import type { ScopeOption } from './scope'
import { planOf } from './upkeep'

const READ_OPERATIONS: ReadonlySet<unknown> = new Set<ReadOperation>([
  'fetchMany',
  'fetchOne',
  'fetchRelated',
  'fetchRelationship',
])

/**
 * True when a key has the binding's shape: `[type, readOperation, …]`, or the same led by a
 * `{ $scope }` segment. Only the browser-side hydration check reads it, since a hydrated query's
 * stripped data can't be told apart from plain data; the server-side dehydrate predicate judges a
 * query by its data instead.
 */
function isBindingKey(queryKey: readonly unknown[]): boolean {
  const at = scopeOf(queryKey) === undefined ? 0 : 1
  return typeof queryKey[at] === 'string' && READ_OPERATIONS.has(queryKey[at + 1])
}

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
 *     (q) => defaultShouldDehydrateQuery(q) || q.state.status === 'pending',
 *   ),
 * })
 * ```
 *
 * It judges a query by its data, not its key, so it needs no descriptor and no scope: a query you
 * build yourself around a client call is left out like the binding's own reads, infinite reads
 * and scoped reads included, and a query holding plain data is passed to `next` whatever its key.
 * A query still pending has no data to judge, so it too is passed to `next`. A pending binding
 * read dehydrated that way resolves in the browser without its accessors, and
 * {@link installNormalization}'s hydration check refetches it there.
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

/** True when a binding query holds data that isn't a materialised value: it lost its accessors. */
const isStripped = (query: Query): boolean =>
  isBindingKey(query.queryKey) &&
  query.state.data !== undefined &&
  query.state.data !== null &&
  !isMaterialisedData(query.state.data)

/** Tear down an installed normalization subscription. Idempotent. */
export type Teardown = () => void

/**
 * Which descriptor is installed for each scope of a QueryClient (`undefined` for unscoped), and how
 * many installs hold it. The normalizer patches a cached query by walking it with the *patch's*
 * descriptor and matching on `type:id`, so two descriptors patching the same queries (e.g. a
 * `default` + an `admin` server whose `users` carry different attribute sets) would
 * cross-contaminate: a read from one would overwrite the other's cached node with foreign
 * attributes. Each descriptor therefore patches only the queries keyed in its scope, and the
 * contract is ONE descriptor per scope of a QueryClient; this registry enforces it. A `WeakMap` so
 * a discarded QueryClient (and its install record) is garbage-collected.
 */
const installed = new WeakMap<
  QueryClient,
  Map<string | undefined, { descriptor: ApiDescriptor; count: number }>
>()

/**
 * The descriptor {@link installNormalization} installed for `scope` on `queryClient`, if any.
 * Internal: the mutation cache reads it to run a mutation's upkeep.
 *
 * @internal
 */
export function installedDescriptor(
  queryClient: QueryClient,
  scope?: string,
): ApiDescriptor | undefined {
  return installed.get(queryClient)?.get(scope)?.descriptor
}

/**
 * The client-wide defaults installed on each QueryClient, and how many installs (of any scope)
 * share them: the first install sets them, the last teardown removes them.
 */
const defaults = new WeakMap<QueryClient, { count: number; remove: () => void }>()

/**
 * Install the client-wide defaults the binding relies on, each only where the app set none: a
 * `dehydrate` predicate that leaves out every query holding a client result, and
 * {@link jsonApiRetry} as `queries.retry`. Returns the function that removes them while they are
 * still the installed value.
 */
function installDefaults(queryClient: QueryClient): () => void {
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

  return () => {
    if (queryClient.getDefaultOptions().dehydrate?.shouldDehydrateQuery === shouldDehydrateQuery) {
      withDehydrate(previousDehydrate)
    }
    if (installsRetry && queryClient.getDefaultOptions().queries?.retry === jsonApiRetry) {
      withRetry(undefined)
    }
  }
}

/**
 * Subscribe the normalizer to a QueryClient's query + mutation caches: each time a query or
 * mutation settles successfully, the freshly-resolved data is indexed by `type:id` and patched
 * across every cached query in place (preserving edge-local `$pivot`/`$edge`).
 *
 * `options.scope` installs the descriptor for one scope, for a server sharing the QueryClient with
 * another: it normalises only the queries whose key carries that scope (as `createQueryApi(client,
 * { scope })` builds them), and runs the upkeep of mutations planned in it. An unscoped install
 * normalises only unscoped keys.
 *
 * A scope of a QueryClient may host only ONE descriptor (see {@link installed}): installing a
 * *second*, different descriptor for the same scope throws, because the normalizer cannot safely
 * tell which descriptor a given `type:id` belongs to once two descriptors overlap. Give each server
 * its own scope. Re-installing the *same* descriptor is allowed (idempotent-friendly): it just
 * adds another subscription pair with its own teardown.
 *
 * It also installs the client's defaults the binding relies on, each only where the app set none,
 * and removes them when the last install on the QueryClient, of any scope, is torn down, while
 * they are still the installed value: a `dehydrate` predicate that leaves out every query holding a
 * client result, and {@link jsonApiRetry} as `queries.retry`, so a read failing with a 4xx JSON:API error or a
 * non-JSON:API response isn't retried.
 *
 * Re-entrancy is guarded: the patch pass itself sets data on other queries (firing further
 * `success` events), so while a pass runs we ignore the events it generates — otherwise a
 * single response would cascade into a loop. Returns a {@link Teardown} that removes both
 * subscriptions (and releases the install record once its last install is torn down).
 */
export function installNormalization(
  queryClient: QueryClient,
  descriptor: ApiDescriptor,
  options: ScopeOption = {},
): Teardown {
  const { scope } = options
  const scopes =
    installed.get(queryClient) ??
    new Map<string | undefined, { descriptor: ApiDescriptor; count: number }>()
  const existing = scopes.get(scope)
  if (existing !== undefined && existing.descriptor !== descriptor) {
    throw new Error(
      `installNormalization: this QueryClient already has a different descriptor installed ${
        scope === undefined ? 'unscoped' : `in scope "${scope}"`
      }. A scope may host only one descriptor — give each client/server its own scope ` +
        '(installNormalization(queryClient, descriptor, { scope })) so a normalize pass cannot ' +
        'leak one descriptor’s attributes into another’s cached resources.',
    )
  }
  scopes.set(scope, { descriptor, count: (existing?.count ?? 0) + 1 })
  installed.set(queryClient, scopes)

  const shared = defaults.get(queryClient) ?? { count: 0, remove: () => {} }
  if (shared.count === 0) {
    shared.remove = installDefaults(queryClient)
  }
  shared.count += 1
  defaults.set(queryClient, shared)

  let normalizing = false

  const run = (data: unknown): void => {
    if (normalizing || data === undefined || data === null) {
      return
    }
    normalizing = true
    try {
      normalize(queryClient, data, descriptor, scope)
    } finally {
      normalizing = false
    }
  }

  // Refetch a query that lost its accessors (deferred, so not inside `hydrate`'s loop).
  const reset = (query: Query): void => {
    queueMicrotask(() => {
      void queryClient.resetQueries({ queryKey: query.queryKey, exact: true })
    })
  }

  // Binding queries added pending with no query function: what `hydrate` builds for a query
  // dehydrated while pending, before it settles with the streamed promise's result.
  const awaitingHydration = new WeakSet<Query>()

  const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
    // Hydration check: a binding query added with data that isn't a materialised value lost its
    // accessors on the way through JSON, so refetch it (deferred, so not inside `hydrate`'s loop).
    if (event.type === 'added') {
      const { query } = event
      if (scopeOf(query.queryKey) !== scope) {
        return
      }
      if (isStripped(query)) {
        warnOnce(queryClient, query)
        reset(query)
      } else if (
        isBindingKey(query.queryKey) &&
        query.state.status === 'pending' &&
        query.options.queryFn === undefined
      ) {
        awaitingHydration.add(query)
      }
      return
    }
    if (
      event.type === 'updated' &&
      event.action.type === 'success' &&
      scopeOf(event.query.queryKey) === scope
    ) {
      const { query } = event
      // A pending binding read dehydrated on the server hydrates as a promise and settles here,
      // its first time, with the result stripped by JSON: refetch it. Only that first settle is
      // checked (`setQueryData`, being `manual`, doesn't count), so a fetch the client runs is
      // never reset, and the refetch can't loop.
      if (event.action.manual !== true && awaitingHydration.delete(query) && isStripped(query)) {
        warnOnce(queryClient, query)
        reset(query)
        return
      }
      // Patch on a settled success — the query's data is the freshest copy of its resources.
      run(query.state.data)
    }
  })

  const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
    // A write that returns a resource (create/update) carries the freshest attributes; index +
    // patch them. A mutation that resolves nothing (a `204` delete) has no data — `run` no-ops.
    // A JSON:API mutation is normalised by its scope's install; any other by the unscoped one.
    if (
      event.type === 'updated' &&
      event.action.type === 'success' &&
      planOf(event.mutation.options.meta)?.scope === scope
    ) {
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
    // The last install on the QueryClient removes the client-wide defaults.
    shared.count -= 1
    if (shared.count === 0) {
      shared.remove()
      defaults.delete(queryClient)
    }
    // Release the scope's record once its last install is torn down, so a different descriptor can
    // be installed for it afterwards.
    const record = scopes.get(scope)
    if (record !== undefined && record.descriptor === descriptor) {
      record.count -= 1
      if (record.count === 0) {
        scopes.delete(scope)
      }
    }
  }
}
