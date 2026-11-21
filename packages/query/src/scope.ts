/**
 * Scopes: several servers sharing one QueryClient (docs/tanstack-query.md, "Several servers").
 *
 * A scope prefixes every key a server's reads and writes carry with a `{ $scope }` segment, so its
 * cached queries, its normalisation and its mutations' upkeep stay apart from another server's,
 * even where both name a type `users`. The bound APIs take a `scope` option; {@link withScope}
 * scopes the options of any standalone factory.
 */
import { scopedKey } from './keys'
import { JSON_API_PLAN, planOf } from './upkeep'

/** The scope option the bound APIs and `installNormalization` take. */
export interface ScopeOption {
  /**
   * The scope a server's reads and writes are cached in, when several servers share one
   * QueryClient. Every key the factories build is led by `{ $scope: scope }`. Omit for one server.
   */
  scope?: string | undefined
}

/**
 * The options of a read or mutation factory, scoped: its `queryKey` or `mutationKey` led by the
 * `{ $scope }` segment (replacing any scope it had), and a mutation's plan carrying the scope, so its
 * upkeep runs against that scope's descriptor and queries. `undefined` leaves the options unscoped.
 *
 * ```ts
 * useQuery(withScope('admin', listQueryOptions(adminClient, 'users')))
 * useMutation(withScope('admin', updateMutationOptions(queryClient, adminClient, admin, 'users', id)))
 * ```
 */
export function withScope<O extends object>(scope: string | undefined, options: O): O {
  const record = options as Record<string, unknown>
  let out: Record<string, unknown> = record
  if (Array.isArray(record['queryKey'])) {
    out = { ...out, queryKey: scopedKey(record['queryKey'] as readonly unknown[], scope) }
  }
  if (Array.isArray(record['mutationKey'])) {
    out = { ...out, mutationKey: scopedKey(record['mutationKey'] as readonly unknown[], scope) }
    const plan = planOf(record['meta'])
    if (plan !== undefined) {
      const { scope: _previous, ...rest } = plan
      out = {
        ...out,
        meta: {
          ...(record['meta'] as object),
          [JSON_API_PLAN]: scope === undefined ? rest : { ...rest, scope },
        },
      }
    }
  }
  return out as O
}

/** True when a value is a factory's options (it carries a query or mutation key). */
const isOptions = (value: object): boolean =>
  Array.isArray((value as { queryKey?: unknown }).queryKey) ||
  Array.isArray((value as { mutationKey?: unknown }).mutationKey)

/**
 * A bound API whose every factory returns scoped options: each function's result is scoped when it
 * is a factory's options, and wrapped again when it is a further accessor (a handle, a relation).
 * `undefined` returns the API itself.
 *
 * @internal
 */
export function scopeApi<T>(api: T, scope: string | undefined): T {
  return scope === undefined ? api : (scoped(api, scope) as T)
}

function scoped(value: unknown, scope: string): unknown {
  if (typeof value === 'function') {
    return (...args: unknown[]) => scoped((value as (...a: unknown[]) => unknown)(...args), scope)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  if (isOptions(value)) {
    return withScope(scope, value)
  }
  return new Proxy(value, {
    get: (target, prop) => scoped(Reflect.get(target, prop), scope),
  })
}
