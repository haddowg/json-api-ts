/**
 * {@link JsonApiMutationCache}: the mutation cache that runs every JSON:API mutation's cache upkeep.
 *
 * A mutation factory describes its upkeep as a plain-data plan in the options' `meta`, and its
 * closures (an optimistic function, an explicit placement, what a custom write invalidates) on the
 * options under a symbol, and sets no lifecycle callbacks of its own, so the callbacks an app adds
 * alongside the factory's options are entirely the app's. The cache's config hooks, which TanStack
 * awaits before the mutation's own callbacks, carry the plan out (design B3).
 */
import { type ApiDescriptor, isAccepted } from '@haddowg/json-api-client'
import { hashKey, type Mutation, MutationCache, type QueryClient } from '@tanstack/query-core'
import { installedDescriptor } from './install'
import { lifecycleOf, openDraft, type OptimisticDraft } from './draft'
import { keyHasPrefix, type QueryKey } from './keys'
import {
  applyOptimistic,
  fetchingTargets,
  hooksOf,
  JSON_API_PLAN,
  type JsonApiMutationPlan,
  normalizeResult,
  ownReadKeys,
  planKeys,
  planOf,
  prepareCreateId,
  swapTempId,
  targetIdOf,
  tempIdOf,
  warnIfPlacedNowhere,
} from './upkeep'

/**
 * The config a `MutationCache` is constructed with (query-core doesn't export its name): the
 * `onMutate`/`onSuccess`/`onError`/`onSettled` hooks run for every mutation.
 */
export type MutationCacheConfig = NonNullable<ConstructorParameters<typeof MutationCache>[0]>

/** How optimistic the JSON:API writes on a QueryClient are unless a write says otherwise. */
export interface OptimisticDefaults {
  /** Whether every write is optimistic unless its factory says `optimistic: false`. Default `true`. */
  enabled?: boolean | undefined
  /**
   * Whether an addition is placed automatically in a view that is unfiltered, unsorted and
   * complete. Default `true`; `false` places only through `into`.
   */
  autoPlace?: boolean | undefined
}

/** The config of a {@link JsonApiMutationCache}: a `MutationCache`'s, plus the optimism default. */
export type JsonApiMutationCacheConfig = MutationCacheConfig & {
  /**
   * Optimism for every JSON:API write on the QueryClient (D5): `true` makes each write optimistic
   * unless its factory says `optimistic: false`; an object does too (unless `enabled: false`) and
   * sets how drafts place additions. Default `false`: a write is optimistic only when its factory
   * says so.
   */
  optimistic?: boolean | OptimisticDefaults | undefined
}

/** The plan of a JSON:API mutation, or `undefined` for any other mutation. */
const planOfMutation = (mutation: Mutation<unknown, unknown, unknown>) =>
  planOf(mutation.options.meta)

/** The descriptor installed on `queryClient`, or a loud error naming the fix. */
function descriptorOf(queryClient: QueryClient, plan: JsonApiMutationPlan): ApiDescriptor {
  const descriptor = installedDescriptor(queryClient, plan.scope)
  if (descriptor === undefined) {
    const what =
      plan.verb === 'atomic'
        ? 'an atomic batch'
        : plan.verb === 'custom'
          ? 'a custom write'
          : `a ${plan.verb} of ${plan.type}`
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

/** What the cache holds for one pending JSON:API mutation. */
interface Pending {
  readonly scope: string | undefined
  /** The keys its settle invalidates: its plan's, its draft's candidates and what it cancelled. */
  readonly keys: Map<string, QueryKey>
  /** Keys an overlapping write that settled first handed on, for this one to invalidate. */
  readonly inherited: Map<string, QueryKey>
  /** Set when the write was accepted for later processing (`202`): it invalidates none of its own. */
  skipOwn: boolean
  /** The draft holding its optimistic change. */
  draft: OptimisticDraft | undefined
}

const add = (keys: Map<string, QueryKey>, key: QueryKey): void => {
  keys.set(hashKey(key), key)
}

/** Whether two keys overlap: one is a prefix of the other. */
const overlap = (a: QueryKey, b: QueryKey): boolean => keyHasPrefix(a, b) || keyHasPrefix(b, a)

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
 *  - `onMutate`: for an optimistic write, cancel the in-flight reads its change could be
 *    overwritten by, then apply the change through a draft (its built-in policy, or the app's
 *    `optimistic` function), keeping the draft;
 *  - `onError`: roll the draft back;
 *  - `onSuccess`: swap a create's temporary id for the server's, normalize the result across the
 *    cache (its values winning over any read that landed meanwhile on a field the draft predicted),
 *    and remove a deleted resource's own reads;
 *  - `onSettled`: invalidate every query the write may have changed, unless another JSON:API write
 *    touching an overlapping key is still pending, which then invalidates them for both when it
 *    settles; return the promise, so the mutation stays pending until the refetch has finished;
 *    then commit the draft, clearing its markers.
 *
 * A write resolving to a `202 Accepted` job (no `wait`) keeps its optimistic change and invalidates
 * nothing of its own: the server hasn't done the work yet. Its markers clear when it settles.
 *
 * TanStack awaits each of these before the mutation's own callback of the same name, so the
 * `onMutate`/`onSuccess`/`onError`/`onSettled` an app adds to the options run after the upkeep,
 * against an already-reconciled cache. A mutation whose `meta` carries no plan is left alone.
 *
 * `config.optimistic` sets the default optimism of every write (D5). The rest of `config` is
 * chained: each of its hooks runs after the upkeep of the same name, for every mutation.
 */
export class JsonApiMutationCache extends MutationCache {
  constructor(options: JsonApiMutationCacheConfig = {}) {
    const { optimistic: defaults, ...config } = options
    const byDefault =
      defaults === true ||
      (typeof defaults === 'object' && defaults !== null && defaults.enabled !== false)
    const autoPlace =
      typeof defaults === 'object' && defaults !== null ? defaults.autoPlace : undefined
    // Each pending JSON:API mutation's upkeep state, and the pending ones per QueryClient and scope.
    // Held here rather than in the mutation's context, which belongs to the app's own `onMutate`.
    const pending = new WeakMap<Mutation<unknown, unknown, unknown>, Pending>()
    const live = new WeakMap<QueryClient, Set<Pending>>()

    const track = (queryClient: QueryClient, entry: Pending): void => {
      const set = live.get(queryClient) ?? new Set<Pending>()
      set.add(entry)
      live.set(queryClient, set)
    }

    /**
     * Invalidate what `entry`'s write may have changed, or, while another write touching an
     * overlapping key is pending, hand the keys to it: the last one to settle invalidates for all.
     */
    const reconcile = async (queryClient: QueryClient, entry: Pending): Promise<void> => {
      const own = live.get(queryClient)
      own?.delete(entry)
      const keys = new Map(entry.skipOwn ? [] : entry.keys)
      for (const [hash, key] of entry.inherited) {
        keys.set(hash, key)
      }
      if (keys.size === 0) {
        return
      }
      const all = [...keys.values()]
      const later = [...(own ?? [])].filter(
        (other) =>
          other.scope === entry.scope &&
          [...other.keys.values()].some((key) => all.some((mine) => overlap(key, mine))),
      )
      if (later.length > 0) {
        for (const other of later) {
          for (const [hash, key] of keys) {
            other.inherited.set(hash, key)
          }
        }
        return
      }
      // One pass, so a query several keys reach is invalidated (and refetched) once.
      await queryClient.invalidateQueries({
        predicate: (query) => all.some((key) => keyHasPrefix(query.queryKey as QueryKey, key)),
      })
    }

    super({
      onMutate: async (variables, mutation, context) => {
        const plan = planOfMutation(mutation)
        if (plan !== undefined) {
          const queryClient = context.client
          const descriptor = descriptorOf(queryClient, plan)
          const hooks = hooksOf(mutation.options)
          const entry: Pending = {
            scope: plan.scope,
            keys: new Map(),
            inherited: new Map(),
            skipOwn: false,
            draft: undefined,
          }
          pending.set(mutation, entry)
          track(queryClient, entry)
          for (const key of planKeys(plan, variables, queryClient, descriptor, hooks)) {
            add(entry.keys, key)
          }
          // A custom write has no built-in change: only its own function makes it optimistic.
          const optimistic =
            plan.verb === 'atomic'
              ? false
              : plan.verb === 'custom'
                ? hooks.optimistic !== undefined && plan.optimistic !== false
                : (plan.optimistic ?? byDefault)
          if (optimistic) {
            const createdId =
              plan.verb === 'create'
                ? prepareCreateId(plan, variables, descriptor, hooks)
                : undefined
            // Cancel the reads in flight that could land over the change (or revert over it, when
            // cancelled later), and refetch them at settle.
            const fetching = fetchingTargets(plan, variables, queryClient, descriptor, [
              ...entry.keys.values(),
            ])
            for (const query of fetching) {
              add(entry.keys, query.queryKey as QueryKey)
            }
            if (fetching.length > 0) {
              await queryClient.cancelQueries({ predicate: (query) => fetching.includes(query) })
            }
            const draft = openDraft(queryClient, descriptor, {
              scope: plan.scope,
              autoPlace,
              // A create's `into` is for its insert alone; every other write's places its adds.
              into: plan.verb === 'create' ? undefined : hooks.into,
            })
            entry.draft = draft
            try {
              const builtIn = draft.batch(() =>
                applyOptimistic(plan, variables, draft, hooks, createdId),
              )
              if (plan.verb === 'create' && builtIn && createdId !== undefined) {
                warnIfPlacedNowhere(plan, queryClient, descriptor, draft, hooks, createdId)
              }
            } finally {
              for (const key of lifecycleOf(draft as never).reconcileKeys()) {
                add(entry.keys, key)
              }
            }
          }
        }
        return config.onMutate?.(variables, mutation, context)
      },
      onError: async (error, variables, onMutateResult, mutation, context) => {
        try {
          pending.get(mutation)?.draft?.rollback()
        } finally {
          await config.onError?.(error, variables, onMutateResult, mutation, context)
        }
      },
      onSuccess: async (data, variables, onMutateResult, mutation, context) => {
        const plan = planOfMutation(mutation)
        const entry = pending.get(mutation)
        if (plan !== undefined && entry !== undefined) {
          const queryClient = context.client
          const descriptor = descriptorOf(queryClient, plan)
          const draft = entry.draft
          const lifecycle = draft === undefined ? undefined : lifecycleOf(draft as never)
          if (isAccepted(data)) {
            // Accepted for later processing (D9): the server hasn't done the work, so the
            // optimistic change stays and nothing of this write's is refetched.
            entry.skipOwn = true
            lifecycle?.confirm()
          } else {
            const wins = lifecycle?.claimedFields()
            lifecycle?.confirm()
            if (plan.verb === 'create') {
              const temp = tempIdOf(variables)
              const id = (data as { id?: unknown } | null | undefined)?.id
              if (temp !== undefined && typeof id === 'string') {
                swapTempId(queryClient, descriptor, plan, draft, temp, id)
              }
            }
            normalizeResult(plan, data, queryClient, descriptor, wins)
            if (plan.verb === 'delete') {
              const id = targetIdOf(plan, variables)
              if (id !== undefined) {
                // Its own reads would refetch into a 404 (D8).
                for (const queryKey of ownReadKeys(plan.type, id, plan.scope)) {
                  queryClient.removeQueries({ queryKey })
                }
              }
            }
          }
        }
        return config.onSuccess?.(data, variables, onMutateResult, mutation, context)
      },
      onSettled: async (data, error, variables, onMutateResult, mutation, context) => {
        const entry = pending.get(mutation)
        pending.delete(mutation)
        if (entry !== undefined) {
          try {
            await reconcile(context.client, entry)
          } finally {
            entry.draft?.commit()
          }
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
