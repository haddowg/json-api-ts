/**
 * Pagination: resolving which strategy answers a read (runtime) and typing a read's `page`
 * parameter and `$page` from the descriptor (compile time). Both follow the paginator the
 * server advertises: a bare kind (canonical wire keys), a strategy with renamed keys, or a
 * MultiPaginator menu the client picks from by `kind`.
 */
import type {
  MenuDescriptor,
  PaginatorDescriptor,
  PaginatorKind,
  PaginatorRole,
  PaginatorStrategy,
  StrategyDescriptor,
} from './descriptor'

/** The wire key for each role when the server keeps the default names. */
export const CANONICAL_PAGE_KEYS = {
  page: { number: 'number', size: 'size' },
  offset: { offset: 'offset', limit: 'limit' },
  cursor: { after: 'after', before: 'before', size: 'size' },
  fixed: { number: 'number' },
  none: {},
} as const satisfies Record<PaginatorKind, Partial<Record<PaginatorRole, string>>>

/** Role -> wire key for the strategy that answered. */
export type PageKeys = Readonly<Partial<Record<PaginatorRole, string>>>

/** The strategy that answers one read, with its wire keys and, for a menu pick, the arm's `kind`. */
export interface ResolvedPaginator {
  kind: PaginatorKind
  keys: PageKeys
  /** The menu arm the request picked with `page[kind]`. Absent when it picked none (the default). */
  arm?: string
}

/**
 * Resolve the strategy that answers a read from the endpoint's paginator and the `page` the
 * request sends. A menu answers with the arm named by `page.kind`, else its `default`.
 */
export function resolvePaginator(
  paginator: PaginatorDescriptor | undefined,
  page?: Readonly<Record<string, unknown>>,
): ResolvedPaginator {
  if (paginator === undefined) {
    return { kind: 'none', keys: {} }
  }
  if (typeof paginator === 'string') {
    return { kind: paginator, keys: CANONICAL_PAGE_KEYS[paginator] }
  }
  if (paginator.strategy !== 'multi') {
    return { kind: paginator.strategy, keys: paginator.keys }
  }
  const picked = page?.['kind']
  const arm =
    typeof picked === 'string' && Object.hasOwn(paginator.arms, picked) ? picked : undefined
  const resolved = resolvePaginator(paginator.arms[arm ?? paginator.default])
  return arm === undefined ? resolved : { ...resolved, arm }
}

/** Navigation links by relation (`first`/`prev`/`next`/`last`), when present. */
export interface PageLinks {
  first?: string
  prev?: string
  next?: string
  last?: string
}

/** Normalised pagination state on a collection, as the runtime builds it; count-free-safe. */
export interface Page {
  kind: PaginatorKind
  /** Role -> wire key for the strategy that answered. */
  keys: PageKeys
  /** The menu arm the request picked with `page[kind]`, when it picked one. */
  arm?: string
  /** The raw `meta.page` block, when present (shape varies by kind). */
  meta?: Record<string, unknown>
  links: PageLinks
}

/**
 * The `meta.page` block each built-in strategy renders. `total`/`lastPage` (and `to` on an empty
 * page) are absent when the server does not count.
 */
export type PageMeta<K extends PaginatorKind> = K extends 'page'
  ? {
      currentPage: number
      perPage: number
      from: number
      to?: number
      total?: number
      lastPage?: number
    }
  : K extends 'fixed'
    ? { currentPage: number; total?: number; lastPage?: number }
    : K extends 'offset'
      ? { offset: number; limit: number; from: number; to?: number; total?: number }
      : K extends 'cursor'
        ? { perPage: number; from?: string; to?: string; hasMore: boolean }
        : Record<string, unknown>

/** `$page` typed by the strategy `K` that answers, its wire keys and the picked menu arm. */
export type TypedPage<
  K extends PaginatorKind,
  Keys extends PageKeys,
  Arm extends string | undefined = undefined,
> = {
  kind: K
  keys: Keys
  meta?: PageMeta<K>
  links: PageLinks
} & (Arm extends string ? { arm: Arm } : { arm?: never })

/** A non-menu paginator entry as `{ strategy, keys }` (a bare kind takes the canonical keys). */
type StrategyOf<P> = P extends PaginatorKind
  ? { strategy: P; keys: (typeof CANONICAL_PAGE_KEYS)[P] }
  : P extends StrategyDescriptor
    ? P
    : never

/** Cursors are opaque strings; every other role is a count. */
type RoleValue<R> = R extends 'after' | 'before' ? string : number

/** The page members one strategy accepts, keyed by their wire names. */
type StrategyParams<S> = S extends { keys: infer K }
  ? { -readonly [R in keyof K as K[R] extends string ? K[R] : never]?: RoleValue<R> }
  : never

/** True when `P` is the loose `PaginatorDescriptor` union rather than a generated literal. */
type IsLoose<P> = [PaginatorKind] extends [P] ? true : false

type ArmName<M extends MenuDescriptor> = Extract<keyof M['arms'], string>

type ArmParams<M extends MenuDescriptor, A> =
  A extends ArmName<M> ? { kind: A } & StrategyParams<StrategyOf<M['arms'][A]>> : never

type KeysOfUnion<U> = U extends unknown ? keyof U : never

/**
 * The default arm's members without `kind`. Members only another arm reads are `never`: the
 * server would select that arm by them, while the response is typed as the default.
 */
type DefaultArmParams<M extends MenuDescriptor> = StrategyParams<
  StrategyOf<M['arms'][M['default']]>
> & { kind?: undefined } & {
  [X in Exclude<
    KeysOfUnion<StrategyParams<StrategyOf<M['arms'][ArmName<M>]>>>,
    keyof StrategyParams<StrategyOf<M['arms'][M['default']]>>
  >]?: never
}

/**
 * The `page` parameter an endpoint with paginator `P` accepts: its strategy's members under
 * their wire keys (numbers, cursors as strings). A menu takes one arm tagged by `kind`, or the
 * default arm's members untagged. `never` for an unpaginated endpoint; a loose record when the
 * descriptor is not a generated literal.
 */
export type PageParams<P> =
  IsLoose<P> extends true
    ? Readonly<Record<string, unknown>>
    : P extends 'none'
      ? never
      : P extends MenuDescriptor
        ? ArmParams<P, ArmName<P>> | DefaultArmParams<P>
        : StrategyParams<StrategyOf<P>>

/** The member of page parameter union `P` that argument `Q` selects by its `kind`, if any. */
type SelectedArm<Q, P> = Q extends { kind: infer K }
  ? Extract<P, { kind: K }>
  : Extract<P, { kind?: undefined }>

/**
 * A page argument `Q` with any member outside the arm it selects turned into `never`, so a typo,
 * or another arm's member, is an error.
 */
export type ExactPageParams<Q, P> = Q & {
  [K in Exclude<
    keyof Q,
    KeysOfUnion<[SelectedArm<Q, P>] extends [never] ? P : SelectedArm<Q, P>>
  >]: never
}

type StrategyPage<S, Arm extends string | undefined = undefined> = S extends {
  strategy: infer K extends PaginatorStrategy
  keys: infer Keys extends PageKeys
}
  ? TypedPage<K, Keys, Arm>
  : Page

type MenuPage<M extends MenuDescriptor, Q> = [Q] extends [never]
  ? StrategyPage<StrategyOf<M['arms'][M['default']]>>
  : Q extends { kind: infer A extends ArmName<M> }
    ? StrategyPage<StrategyOf<M['arms'][A]>, A>
    : StrategyPage<StrategyOf<M['arms'][M['default']]>>

/**
 * The `$page` a read on an endpoint with paginator `P` carries, given the `page` argument `Q`
 * it sent: the picked menu arm's strategy, the default's when it picked none, else the
 * endpoint's own strategy.
 */
export type PageOf<P, Q = undefined> =
  IsLoose<P> extends true
    ? Page
    : P extends MenuDescriptor
      ? MenuPage<P, Q>
      : P extends 'none'
        ? TypedPage<'none', Record<never, never>>
        : StrategyPage<StrategyOf<P>>

/**
 * The `page` argument that reads another page from the strategy that answered `P` (a `$page`):
 * its members under their wire keys, tagged with the menu arm it picked. A loose record for an
 * untyped `Page`.
 */
export type PageParamsOf<P extends Page> = PaginatorKind extends P['kind']
  ? Readonly<Record<string, string | number>>
  : StrategyParams<{ keys: P['keys'] }> &
      (P extends { arm: infer A extends string } ? { kind: A } : unknown)
