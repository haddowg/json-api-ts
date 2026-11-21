/**
 * {@link JsonApiMutationCache}: the mutation cache that runs every JSON:API mutation's cache upkeep.
 *
 * A mutation factory describes its upkeep as a plain-data plan in the options' `meta` and sets no
 * lifecycle callbacks of its own, so the callbacks an app adds alongside the factory's options are
 * entirely the app's. The cache's config hooks, which TanStack awaits before the mutation's own
 * callbacks, carry the plan out: the optimistic change before the write, its rollback on error,
 * normalization on success and invalidation on settle.
 */
import type { ApiDescriptor } from '@haddowg/json-api-client'
import { type Mutation, MutationCache, type QueryClient } from '@tanstack/query-core'
import { installedDescriptor } from './install'
import type { Snapshot } from './normalize'
import {
  applyOptimistic,
  invalidateFor,
  JSON_API_PLAN,
  type JsonApiMutationPlan,
  normalizeResult,
  planOf,
} from './upkeep'

/**
 * The config a `MutationCache` is constructed with (query-core doesn't export its name): the
 * `onMutate`/`onSuccess`/`onError`/`onSettled` hooks run for every mutation.
 */
export type MutationCacheConfig = NonNullable<ConstructorParameters<typeof MutationCache>[0]>

/** The plan of a JSON:API mutation, or `undefined` for any other mutation. */
const planOfMutation = (mutation: Mutation<unknown, unknown, unknown>) =>
  planOf(mutation.options.meta)

/** The descriptor installed on `queryClient`, or a loud error naming the fix. */
function descriptorOf(queryClient: QueryClient, plan: JsonApiMutationPlan): ApiDescriptor {
  const descriptor = installedDescriptor(queryClient, plan.scope)
  if (descriptor === undefined) {
    const what = plan.verb === 'atomic' ? 'an atomic batch' : `a ${plan.verb} of ${plan.type}`
    const where =
      plan.scope === undefined
        ? 'with no descriptor installed'
        : `with no descriptor installed in scope "${plan.scope}"`
    const install =
      plan.scope === undefined
        ? 'installNormalization(queryClient, descriptor)'
        : `installNormalization(queryClient, descriptor, { scope: '${plan.scope}' })`
    throw new Error(
      `@haddowg/json-api-query: ${what} ran on a QueryClient ${where}, so its cache upkeep ` +
        `cannot run. Call ${install} on the QueryClient built with ` +
        'new QueryClient({ mutationCache: new JsonApiMutationCache() }).',
    )
  }
  return descriptor
}

/**
 * The mutation cache that runs a JSON:API mutation's cache upkeep. Build the QueryClient with it
 * and install the descriptor:
 *
 * ```ts
 * const queryClient = new QueryClient({ mutationCache: new JsonApiMutationCache() })
 * installNormalization(queryClient, descriptor)
 * ```
 *
 * Its config hooks read the plan a mutation factory put in the mutation's `meta` and carry it out:
 *
 *  - `onMutate`: apply the optimistic change, keeping the snapshot that undoes it;
 *  - `onError`: restore that snapshot;
 *  - `onSuccess`: normalize the result across the cache;
 *  - `onSettled`: invalidate what the write changed, returning the promise so the mutation stays
 *    pending until the invalidation (and any refetch it starts) has finished.
 *
 * TanStack awaits each of these before the mutation's own callback of the same name, so the
 * `onMutate`/`onSuccess`/`onError`/`onSettled` an app adds to the options run after the upkeep,
 * against an already-reconciled cache. A mutation whose `meta` carries no plan is left alone.
 *
 * The `config` it is constructed with is chained: each of its hooks runs after the upkeep of the
 * same name, for every mutation.
 */
export class JsonApiMutationCache extends MutationCache {
  constructor(config: MutationCacheConfig = {}) {
    // The snapshot to roll back to, per in-flight optimistic mutation. Held here rather than in
    // the mutation's context, which belongs to the app's own `onMutate`.
    const snapshots = new WeakMap<Mutation<unknown, unknown, unknown>, Snapshot>()
    super({
      onMutate: async (variables, mutation, context) => {
        const plan = planOfMutation(mutation)
        if (plan !== undefined) {
          // Applied before any await, so the optimistic change is visible as soon as `mutate()`
          // returns, as it is from a mutation's own synchronous `onMutate`.
          const snapshot = applyOptimistic(
            plan,
            variables,
            context.client,
            descriptorOf(context.client, plan),
          )
          if (snapshot !== undefined) {
            snapshots.set(mutation, snapshot)
          }
        }
        return config.onMutate?.(variables, mutation, context)
      },
      onError: async (error, variables, onMutateResult, mutation, context) => {
        const snapshot = snapshots.get(mutation)
        snapshots.delete(mutation)
        try {
          snapshot?.restore()
        } finally {
          await config.onError?.(error, variables, onMutateResult, mutation, context)
        }
      },
      onSuccess: async (data, variables, onMutateResult, mutation, context) => {
        const plan = planOfMutation(mutation)
        snapshots.delete(mutation)
        if (plan !== undefined) {
          normalizeResult(plan, data, context.client, descriptorOf(context.client, plan))
        }
        return config.onSuccess?.(data, variables, onMutateResult, mutation, context)
      },
      onSettled: async (data, error, variables, onMutateResult, mutation, context) => {
        const plan = planOfMutation(mutation)
        snapshots.delete(mutation)
        if (plan !== undefined) {
          await invalidateFor(plan, context.client)
        }
        return config.onSettled?.(data, error, variables, onMutateResult, mutation, context)
      },
    })
  }
}

/**
 * Throw, from a JSON:API mutation's `mutationFn`, when the mutation runs where its upkeep can't: on a
 * QueryClient whose mutation cache isn't a {@link JsonApiMutationCache}, or with its plan dropped
 * from `meta` (an app's own `meta` replacing the factory's rather than merging with it).
 *
 * @internal
 */
export function assertUpkeepRuns(context: unknown): void {
  const ctx = context as { client?: QueryClient; meta?: unknown } | undefined
  if (!(ctx?.client?.getMutationCache() instanceof JsonApiMutationCache)) {
    throw new Error(
      '@haddowg/json-api-query: this mutation ran on a QueryClient whose mutation cache is not a ' +
        'JsonApiMutationCache, so its normalization, invalidation and optimistic rollback would be ' +
        'skipped. Build the client with new QueryClient({ mutationCache: new JsonApiMutationCache() }) ' +
        'and call installNormalization(queryClient, descriptor).',
    )
  }
  if (planOf(ctx.meta) === undefined) {
    throw new Error(
      `@haddowg/json-api-query: this mutation's meta has no "${JSON_API_PLAN}" plan, so its cache ` +
        'upkeep would be skipped. Merge your own meta with the factory’s ' +
        '({ ...options, meta: { ...options.meta, mine } }) rather than replacing it.',
    )
  }
}
