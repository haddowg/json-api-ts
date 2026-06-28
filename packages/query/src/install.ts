/**
 * Auto-subscribe the Strategy-2 normalizer to a QueryClient (ADR 0003).
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
import type { QueryClient } from '@tanstack/query-core'
import { normalize } from './normalize'

/** Tear down an installed normalization subscription. Idempotent. */
export type Teardown = () => void

/**
 * Which descriptor is currently installed on a given QueryClient. The normalizer patches a cached
 * query by walking it with the *patch's* descriptor and matching on `type:id`, so two descriptors
 * sharing one QueryClient (e.g. a `default` + an `admin` server whose `users` carry different
 * attribute sets — CONTEXT.md's multi-client case) would cross-contaminate: a read from one would
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
    // Release the install record so a different descriptor can be installed afterwards (only when
    // ours is still the active record — a same-descriptor re-install left it pointing at the same
    // descriptor, so clearing it is correct either way).
    if (installed.get(queryClient) === descriptor) {
      installed.delete(queryClient)
    }
  }
}
