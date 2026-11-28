/**
 * The optimistic draft: one typed transaction over the normalised
 * cache, through which every optimistic change goes, built-in or written by an app.
 *
 * A draft edits the cached materialised values of one scope of a QueryClient in place:
 *
 * - **Candidates.** Each operation finds every cached query it might affect by decoding the cached
 *   keys ({@link describeQuery}) and walking their data for copies of the resource it addresses:
 *   a parent's relation reads (related and relationship, plain and infinite), and the relation's
 *   slot on every cached copy of the parent, per-edge views and infinite pages included.
 * - **Placement.** Removals ({@link OptimisticDraft.detach}, {@link OptimisticDraft.evict},
 *   `link(…, null)`) apply to every candidate. Additions apply automatically only to a view that
 *   is unfiltered, unsorted and complete, at its end (or start); every other candidate is offered
 *   to {@link Into}. {@link OptimisticDraft.insert} places only through {@link Into}.
 * - **Fit.** A member enters a destination only in the shape the destination promises: a slot or
 *   read of identifiers takes `{ type, id }` (and the ref's `$pivot`); one of resources takes only
 *   a copy that holds every attribute its fieldset selects and every relation it includes, from
 *   what the caller passed or the richest cached copy, as a per-edge view carrying this edge's
 *   `$pivot`. A member that fits nowhere it was to go is **deferred**: the view keeps its members,
 *   and the parent reports it through `$pending(rel)`.
 * - **Rollback** replays inverse operations in reverse, each compare-and-swap, so a value written
 *   since, by a response or another draft, is never discarded.
 * - **Creates.** {@link OptimisticDraft.insert} completes the new row before trying each list: the
 *   values the caller supplies for the attributes only the server sets, `null` for each such
 *   attribute the descriptor says may be `null`, and each included relation resolved from the cache
 *   by the input's ref. A list the completed row still doesn't fit, where `into` placed it, takes it
 *   as a **pending entry** (`list.$pending()`) instead of a member.
 * - **Markers.** Every resource a draft touched reports `$optimistic === 'pending'` until the draft
 *   commits or rolls back, a parent's `$count(rel)` moves by the members added and removed, and a
 *   list's total by the creates placed in it, as members or pending entries.
 *
 * Publishing: an operation edits the cached objects as it runs, and each query it touched is
 * published (its data set once, under a new root) when the operation returns, or, inside
 * {@link OptimisticDraft.batch}, once when the batch returns. A transaction run as one batch
 * therefore notifies each observer once.
 */
import {
  type ApiDescriptor,
  type CreateInput,
  type FilterQuery,
  type MaterialisedOverlay,
  type PendingCreate,
  type PendingMember,
  type PendingPivotOf,
  type PendingPlacement,
  type PivotFieldsOf,
  type RelatedQueryParam,
  type RelatedReadRelatedQuery,
  type RelationFilterQuery,
  type RelationName,
  type RelationSortQuery,
  setMaterialisedOverlay,
  type SortQuery,
  type TypeName,
  type WritePivotOf,
} from '@haddowg/json-api-client'
import type { Query, QueryClient } from '@tanstack/query-core'
import {
  type CacheView,
  cacheView,
  describeCached,
  renameNode,
  shapeOfCached,
  touchNode,
} from './cache-index'
import {
  addresses,
  carriesData,
  identityKey,
  identityOf,
  isRecord,
  relationIdentityKey,
} from './identity'
import { type QueryKey, scopeOf } from './keys'
import type { UpdateVariables } from './mutate'
import {
  addClaim,
  descends,
  type FieldClaim,
  fieldKey,
  type InfiniteValue,
  isInfiniteValue,
  lineageOf,
  partsOf,
  publishData,
  queriesIn,
  recordSlot,
  removeClaim,
  serverValueOf,
  showClaim,
  type Snapshot,
  targetOf,
  topClaim,
  withMembers,
  writable,
} from './normalize'
import {
  addSlotClaim,
  invalidate,
  linksOnly,
  recordOnClaim,
  removeSlotClaim,
  type SlotClaim,
  topSlotClaim,
} from './relationships'
import { memberViewFor } from './resolve'
import {
  firstPage,
  isComplete,
  isUnfilteredUnsorted,
  type QueryDescription,
  type QueryParams,
  slotShape,
  type ViewShape,
  walkShaped,
} from './view-shape'

// ── Public types ───────────────────────────────────────────────────────────────────────────

/**
 * A member an operation names: a resource identifier, optionally carrying this edge's `$pivot`, or
 * any resource value (a row the user picked from a list), which is then the first copy tried when
 * the member must fill a slot of resources. A ref without an `id` (an atomic batch's `lid`) has no
 * cache identity and is skipped.
 */
export type DraftRef = {
  readonly type: string
  readonly id?: string | undefined
  readonly $pivot?: Readonly<Record<string, unknown>> | undefined
  /** A resource value's attributes and relations, when the ref is one. */
  readonly [member: string]: unknown
}

/**
 * A member as {@link Into} sees it: the value that would enter the view (a per-edge view of the
 * resolved copy, or an identifier view), or, when no copy fits, the ref the caller passed. `TType`
 * is the type it can be: the inserted type, or a relation's related types.
 *
 * `Pivot` types its `$pivot`: on a relation with a pivot, the read pivot (`PivotFieldsOf`) for a
 * member already in the view and the write pivot (`WritePivotOf`) for the member entering it, each
 * `| undefined`, as the client's own per-edge `$pivot` is (a slot holds only what its document
 * rendered, and a ref may be added without one); `never` where there is no pivot (an insert, or a
 * relation without one), which leaves `$pivot` `undefined`. Over the base descriptor it is a loose
 * record that may be absent.
 *
 * `PendingPivot` is the `$pivot` of a loaded member a write still holds pending, where it differs
 * from `Pivot`: the member is then a union on `$optimistic`, and checking that it isn't `'pending'`
 * gives `Pivot`, as on the client's own members.
 */
export type DraftMember<
  TType extends string = string,
  Pivot = Readonly<Record<string, unknown>> | undefined,
  PendingPivot = never,
> = {
  readonly type: TType
  readonly id: string
  readonly [key: string]: unknown
} & ([PendingPivot] extends [never]
  ? PivotSlot<Pivot>
  :
      | (PivotSlot<Pivot> & { readonly $optimistic?: undefined })
      | (PivotSlot<PendingPivot> & { readonly $optimistic: 'pending' }))

/** The `$pivot` member of a {@link DraftMember} whose pivot is `Pivot`. */
type PivotSlot<Pivot> = [Pivot] extends [never]
  ? { readonly $pivot?: undefined }
  : undefined extends Pivot
    ? { readonly $pivot?: Pivot }
    : { readonly $pivot: Pivot }

/** Whether relation `R` of type `T` carries pivot data on its members. */
type HasPivot<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = D[T]['relations'][R] extends { readPivot: object } | { pivotFields: object } | { pivot: true }
  ? true
  : false

/**
 * The `$pivot` a {@link DraftMember} of relation `R` carries: `Side` (the read or write pivot) or
 * `undefined` on a relation with a pivot, `never` on one without, and the loose record over the base
 * descriptor.
 *
 * @internal
 */
export type DraftPivot<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
  Side,
> =
  string extends TypeName<D>
    ? Readonly<Record<string, unknown>> | undefined
    : HasPivot<D, T, R> extends true
      ? Side | undefined
      : never

/**
 * The `$pivot` a loaded {@link DraftMember} of relation `R` carries while a write holds it pending:
 * only the pivot the write sent, so every field the write pivot doesn't require is optional, or
 * `undefined`. `never` where that types the same as a confirmed member's pivot, and over the base
 * descriptor.
 *
 * @internal
 */
export type DraftPendingPivot<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> =
  string extends TypeName<D>
    ? never
    : HasPivot<D, T, R> extends true
      ? PendingPivotOf<D, T, R> extends PivotFieldsOf<D, T, R>
        ? never
        : PendingPivotOf<D, T, R> | undefined
      : never

/**
 * The params a candidate view was read with, as {@link DraftQuery} carries them: `filter`, `sort`
 * and `relatedQuery` typed as the read's query types them (`never` where the read takes none), the
 * rest as the key records them.
 */
export type DraftParams<Filter, Sort, Related> = Omit<
  QueryParams,
  'filter' | 'sort' | 'relatedQuery'
> & {
  readonly filter?: Readonly<Filter>
  readonly sort?: Sort
  readonly relatedQuery?: Related
}

/** What every {@link DraftQuery} carries beside its read, address and params. */
type DescribedView = Omit<QueryDescription, 'type' | 'operation' | 'id' | 'rel' | 'params'>

/**
 * A candidate view that is a collection read of type `T` (`fetchMany`), its `filter` keys, `sort`
 * tokens and `relatedQuery` typed by `T`'s collection read query.
 */
export type ListDraftQuery<D extends ApiDescriptor, T extends TypeName<D>> = DescribedView & {
  readonly operation: 'fetchMany'
  readonly type: T
  readonly id?: never
  readonly rel?: never
  readonly params: DraftParams<
    FilterQuery<D, T>,
    SortQuery<D, T>,
    RelatedQueryParam<D, T, 'fetchMany'>
  >
}

/**
 * A candidate view that is a single-resource read of type `T` (`fetchOne`, a singleton's without an
 * id), which takes no `filter` or `sort`: its included relations' are under `relatedQuery`.
 */
export type ResourceDraftQuery<D extends ApiDescriptor, T extends TypeName<D>> = DescribedView & {
  readonly operation: 'fetchOne'
  readonly type: T
  readonly id?: string
  readonly rel?: never
  readonly params: DraftParams<never, never, RelatedQueryParam<D, T, 'fetchOne'>>
}

/**
 * A candidate view that is relation `R` of type `T`'s related or relationship read, its `filter`
 * and `sort` typed as the relation's reads take them.
 */
export type RelationDraftQuery<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> =
  | (DescribedView & {
      readonly operation: 'fetchRelated'
      readonly type: T
      readonly id?: string
      readonly rel: R
      readonly params: DraftParams<
        RelationFilterQuery<D, T, R>,
        RelationSortQuery<D, T, R>,
        RelatedReadRelatedQuery<D, T, R>
      >
    })
  | (DescribedView & {
      readonly operation: 'fetchRelationship'
      readonly type: T
      readonly id?: string
      readonly rel: R
      readonly params: DraftParams<RelationFilterQuery<D, T, R>, RelationSortQuery<D, T, R>, never>
    })

/** Every read of type `T` a view can be: its collection, a resource, and each relation's reads. */
type TypeDraftQuery<D extends ApiDescriptor, T extends TypeName<D>> =
  | ListDraftQuery<D, T>
  | ResourceDraftQuery<D, T>
  | { [R in RelationName<D, T>]: RelationDraftQuery<D, T, R> }[RelationName<D, T>]

/**
 * The decoded description of a candidate query, as {@link Into} receives it: its operation, its
 * type, id and relation, and the params it was read with. Over a typed descriptor it is a union
 * discriminated by `type`, `operation` and `rel`, each member's `params.filter` keys, `params.sort`
 * tokens and `params.relatedQuery` typed by that read's query types, so narrowing on `q.type` (and
 * `q.rel`) types its params. Over the base `ApiDescriptor` it is the loose description.
 *
 * A relationship verb's candidates include the relation's slot on every cached copy of the parent,
 * which any read can hold, so its `into` receives this whole union; an insert's receives only its
 * type's collection reads ({@link ListDraftQuery}).
 */
export type DraftQuery<D extends ApiDescriptor = ApiDescriptor> =
  string extends TypeName<D>
    ? QueryDescription
    : { [T in TypeName<D>]: TypeDraftQuery<D, T> }[TypeName<D>]

/** The types relation `R` of type `T` relates, or `string` where the descriptor doesn't say. */
export type RelatedTypeName<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> =
  string extends TypeName<D> ? string : Extract<D[T]['relations'][R]['types'][number], TypeName<D>>

/**
 * Where {@link Into} places a member in a view:
 *
 * - `'start'`: first, honoured only on a view showing the first page;
 * - `'end'`: last, honoured only on a complete view (no `next` link; for an infinite query, its
 *   last loaded page carries none);
 * - an index into the loaded members (across an infinite query's pages), clamped to them;
 * - a function of the loaded members returning such an index, where a negative index (such as
 *   `findIndex` finding nothing) places after the last loaded member;
 * - `false`: leave the view alone.
 */
export type Placement<M = DraftMember> =
  | 'start'
  | 'end'
  | number
  // A method's parameters are bivariant, so a typed placement fits where a loose one is held.
  | { place(members: readonly M[]): number }['place']
  | false

/**
 * Explicit placement: consulted for every candidate view the automatic placement
 * didn't cover, with the view's decoded query `Q`, the member `M` that would enter it, and, for a
 * placement function, the view's loaded members `Members`. An operation types all three:
 * `insert('albums', …)` passes an albums collection read and albums members, and a relationship
 * verb any {@link DraftQuery} and members of the relation's types, each `$pivot` typed from the
 * relation's pivot.
 */
export type Into<
  D extends ApiDescriptor = ApiDescriptor,
  Q = DraftQuery<D>,
  M = DraftMember<TypeName<D>>,
  Members = M,
> = {
  // Declared as a method so its parameters are bivariant: a typed `into` can be held where any
  // descriptor's is (an option or a plan typed loosely), while an inline one is typed in context.
  into(query: Q, member: M): Placement<Members>
}['into']

/**
 * The {@link Into} an operation on relation `R` of type `T` takes. On a relation with a pivot, the
 * entering member's `$pivot` is the write pivot the caller sent (`WritePivotOf`), and each loaded
 * member's the read pivot its document rendered (`PivotFieldsOf`), either `undefined` when absent.
 * A loaded member a write still holds pending has only the pivot that write sent
 * (`PendingPivotOf`), told apart by `$optimistic`.
 */
export type RelationInto<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = Into<
  D,
  DraftQuery<D>,
  DraftMember<RelatedTypeName<D, T, R>, DraftPivot<D, T, R, WritePivotOf<D, T, R>>>,
  DraftMember<
    RelatedTypeName<D, T, R>,
    DraftPivot<D, T, R, PivotFieldsOf<D, T, R>>,
    DraftPendingPivot<D, T, R>
  >
>

/** The {@link Into} an insert of type `T` takes: list rows carry no `$pivot`. */
export type InsertInto<D extends ApiDescriptor, T extends TypeName<D>> = Into<
  D,
  string extends TypeName<D> ? QueryDescription : ListDraftQuery<D, T>,
  DraftMember<T, never>
>

/** How an adding operation places its members; `I` is the {@link Into} it takes. */
export interface PlaceOptions<D extends ApiDescriptor = ApiDescriptor, I = Into<D>> {
  /** Where automatic placement puts a member: `'end'` (the default) or `'start'`. */
  at?: 'start' | 'end'
  /** Explicit placement for the views automatic placement didn't cover; the draft's by default. */
  into?: I | undefined
}

/** How {@link openDraft} opens a draft. */
export interface DraftOptions<D extends ApiDescriptor = ApiDescriptor> {
  /** The scope whose cached queries the draft edits; `undefined` for unscoped queries. */
  scope?: string | undefined
  /**
   * Whether an addition is placed automatically in a view that is unfiltered, unsorted and
   * complete. Default `true`; `false` places only through {@link Into}.
   */
  autoPlace?: boolean | undefined
  /** The explicit placement every adding operation of the draft uses unless it passes its own. */
  into?: Into<D> | undefined
  /**
   * Whether what the draft touches reports `$optimistic` and `$pending()`, and its `$count` moves.
   * Default `true`.
   */
  markers?: boolean | undefined
}

/**
 * The members a draft deferred for one relation of one parent: placed nowhere they fit yet. Each
 * carries the member the caller supplied, under `member`, when it supplied more than an identifier.
 */
export interface DeferredMembers {
  readonly type: string
  /** The parent's id, `undefined` for a singleton addressed by type alone. */
  readonly id: string | undefined
  readonly rel: string
  readonly members: readonly PendingMember[]
}

/** How {@link OptimisticDraft.insert} completes a new resource. */
export interface InsertOptions {
  /**
   * Values for the read attributes the create's input lacks (those only the server sets, and
   * optional ones it left out), filling the keys the input doesn't hold before the row is tried
   * against each list. Each attribute the descriptor lists
   * as server-only and nullable that is still missing completes to `null` on its own.
   */
  complete?: Readonly<Record<string, unknown>> | undefined
}

/**
 * A typed transaction over the normalised cache of one scope of a QueryClient. Open
 * one with {@link openDraft}.
 *
 * Operations are typed against the descriptor `D` (type, relation and attribute names) and, for
 * `patch` and `insert`, the write-types map `W`. A singleton is addressed by `undefined` for its
 * id. Every operation throws once the draft has committed or rolled back.
 */
export interface OptimisticDraft<D extends ApiDescriptor = ApiDescriptor, W = unknown> {
  /** The scope the draft edits. */
  readonly scope: string | undefined
  /**
   * Predict an update: each attribute in `change` is written onto every cached copy of `type:id`
   * that holds it or whose view's fieldset selects it, and each relation in `change` is applied as
   * {@link link} (to-one) or {@link replaceMembers} (to-many).
   */
  patch<T extends TypeName<D>>(
    type: T,
    id: string | undefined,
    change: UpdateVariables<D, W, T>,
  ): void
  /**
   * Point a to-one relation at `ref`, or clear it with `null`, in the relation's reads and its slot
   * on every cached copy of the parent. Clearing applies everywhere; linking follows the placement
   * and fit rules (a slot of resources the member doesn't fit keeps its value, the member deferred).
   */
  link<T extends TypeName<D>, R extends RelationName<D, T>>(
    type: T,
    id: string | undefined,
    rel: R,
    ref: DraftRef | null,
    options?: PlaceOptions<D, RelationInto<D, T, R>>,
  ): void
  /**
   * Add members to a to-many relation: its reads (infinite pages included) and its slot on every
   * cached copy of the parent, where placement and fit allow. A member already present is left.
   * `at` is where automatic placement puts them.
   */
  attach<T extends TypeName<D>, R extends RelationName<D, T>>(
    type: T,
    id: string | undefined,
    rel: R,
    refs: readonly DraftRef[],
    at?: 'start' | 'end' | PlaceOptions<D, RelationInto<D, T, R>>,
  ): void
  /** Remove members from a to-many relation, from every view of it. */
  detach<T extends TypeName<D>>(
    type: T,
    id: string | undefined,
    rel: RelationName<D, T>,
    refs: readonly DraftRef[],
  ): void
  /**
   * Make `refs` a to-many relation's members: every other member leaves every view, and the new
   * ones are placed as {@link attach} places them. A view placed automatically takes `refs`' order.
   */
  replaceMembers<T extends TypeName<D>, R extends RelationName<D, T>>(
    type: T,
    id: string | undefined,
    rel: R,
    refs: readonly DraftRef[],
    options?: PlaceOptions<D, RelationInto<D, T, R>>,
  ): void
  /**
   * Insert a new resource into the cached lists of `type` that `into` places it in (never
   * automatically: whether it belongs in a filtered, sorted or paged list only the server knows).
   *
   * The row is completed first: `options.complete`'s values, then `null` for each attribute the
   * descriptor lists as server-only and nullable that is still missing, and each relation a list
   * includes resolved from the cache by the ref the resource gives. A list the completed row fits
   * takes it as a member; one it still doesn't fit takes it as a pending entry, reported by the
   * list's `$pending()`. Either way the list's total moves by one.
   */
  insert<T extends TypeName<D>>(
    type: T,
    resource: CreateInput<D, W, T> & { readonly id: string },
    into?: InsertInto<D, T>,
    options?: InsertOptions,
  ): void
  /**
   * Remove `type:id` from every list, related read, relationship read, to-many slot and infinite
   * page; to-one slots and reads holding it become `null`. Its own reads are left alone.
   */
  evict<T extends TypeName<D>>(type: T, id: string): void
  /** The richest cached copy of `type:id` in the scope, else its identifier. */
  resolve<T extends TypeName<D>>(type: T, id: string): DraftMember
  /**
   * Run `fn`'s operations as one transaction: each query they touch is published once, when `fn`
   * returns. `fn` must be synchronous.
   */
  batch<R>(fn: () => R): R
  /**
   * Undo every operation, most recent first, each compare-and-swap: a member is re-added only if
   * still absent, an added one removed only if still present, an attribute or to-one restored only
   * if it still holds what this draft wrote. Clears the draft's markers and deferred members.
   */
  rollback(): void
  /** Keep the changes, drop the undo state, and clear the draft's markers and deferred members. */
  commit(): void
  /**
   * The keys of every query the draft touched or considered as a candidate, for the lifecycle to
   * cancel before and invalidate after the write.
   */
  touchedKeys(): readonly QueryKey[]
  /** The members deferred so far, per parent relation. */
  deferred(): readonly DeferredMembers[]
}

// ── Markers: the registry the client's overlay reads ───────────────────────────────────────

/** What one draft records about one resource it touched. */
interface Mark {
  readonly type: string
  readonly id: string | undefined
  /** Deferred members per relation, keyed by `type:id`. */
  readonly pending: Map<string, Map<string, PendingMember>>
  /** The count adjustment per relation. */
  readonly counts: Map<string, number>
}

/** The marks on each materialised resource value (keyed by the value behind any root). */
const resourceMarks = new WeakMap<object, Set<Mark>>()
/** The marks on each to-many array, with the relation each counts. */
const arrayMarks = new WeakMap<object, Map<Mark, string>>()

/**
 * What one draft records about one list (or one page of an infinite list) it placed a create in:
 * the creates pending there, by `type:id`, and how far the list's total moves.
 */
interface ListMark {
  readonly entries: Map<string, PendingCreate>
  readonly delta: number
}

/** The list marks on each collection array (keyed by the array behind any root). */
const listMarks = new WeakMap<object, Set<ListMark>>()

/** The list marks on `targets` and every array each was derived from. */
function listMarksOf(targets: readonly object[]): Set<ListMark> {
  const out = new Set<ListMark>()
  for (const target of targets) {
    for (const value of lineageOf(target)) {
      for (const mark of listMarks.get(value) ?? []) {
        out.add(mark)
      }
    }
  }
  return out
}

const NONE: readonly PendingMember[] = Object.freeze([])
const NO_CREATES: readonly PendingCreate[] = Object.freeze([])

function marksOf(targets: readonly object[]): Set<Mark> {
  const out = new Set<Mark>()
  for (const target of targets) {
    for (const mark of resourceMarks.get(targetOf(target)) ?? []) {
      out.add(mark)
    }
  }
  return out
}

const overlay: MaterialisedOverlay = {
  optimistic: (targets) => (marksOf(targets).size > 0 ? 'pending' : undefined),
  creates: (targets) => {
    const found = new Map<string, PendingCreate>()
    for (const mark of listMarksOf(targets)) {
      for (const [key, entry] of mark.entries) {
        found.set(key, entry)
      }
    }
    return found.size === 0 ? NO_CREATES : [...found.values()]
  },
  total: (targets, raw) => {
    let delta = 0
    for (const mark of listMarksOf(targets)) {
      delta += mark.delta
    }
    return Math.max(0, raw + delta)
  },
  pending: (targets, name) => {
    const found = new Map<string, PendingMember>()
    for (const mark of marksOf(targets)) {
      for (const [key, member] of mark.pending.get(name) ?? []) {
        found.set(key, member)
      }
    }
    return found.size === 0 ? NONE : [...found.values()]
  },
  count: (targets, name, raw) => {
    if (raw === undefined) {
      return undefined
    }
    let delta = 0
    if (name === undefined) {
      const seen = new Set<Mark>()
      for (const target of targets) {
        for (const [mark, rel] of arrayMarks.get(targetOf(target)) ?? []) {
          if (!seen.has(mark)) {
            seen.add(mark)
            delta += mark.counts.get(rel) ?? 0
          }
        }
      }
    } else {
      for (const mark of marksOf(targets)) {
        delta += mark.counts.get(name) ?? 0
      }
    }
    return Math.max(0, raw + delta)
  },
}

let overlayInstalled = false

// ── Internals ──────────────────────────────────────────────────────────────────────────────

/** A member an operation places, with the value the caller passed for it. */
interface Ref {
  readonly type: string
  readonly id: string
  readonly pivot: Readonly<Record<string, unknown>> | undefined
  /** What the caller passed, tried first when the member must fill a slot of resources. */
  readonly source: unknown
}

/** A resource a draft inserted: the input the caller gave, and the row completed from it. */
interface Created {
  readonly input: Readonly<Record<string, unknown>>
  readonly completed: Readonly<Record<string, unknown>>
}

/** What a caller's ref carries beyond its identifier, as a deferred member's `member`, if any. */
const memberData = (source: unknown): Readonly<Record<string, unknown>> | undefined =>
  isRecord(source) && carriesData(source) ? source : undefined

/** Where a member list or a to-one value lives: one of a query's parts, or a node's slot. */
type Loc =
  | { readonly kind: 'top'; readonly query: Query; readonly page: number }
  | {
      readonly kind: 'slot'
      readonly query: Query
      readonly node: Record<string, unknown>
      readonly rel: string
    }

/** One inverse operation, replayed by a rollback. */
type Undo =
  | {
      readonly kind: 'added'
      readonly loc: Loc
      readonly produced: object
      readonly member: object
    }
  | {
      readonly kind: 'removed'
      readonly loc: Loc
      readonly produced: object
      readonly member: object
      readonly index: number
    }
  | {
      readonly kind: 'ordered'
      readonly loc: Loc
      readonly produced: object
      readonly order: readonly string[]
    }
  | { readonly kind: 'linked'; readonly loc: Loc; readonly prior: unknown; readonly wrote: unknown }

/** A to-many view of the relation an operation edits: its member lists and how to place in it. */
interface ManyView {
  readonly query: Query
  readonly description: QueryDescription
  /** The member lists: one, or an infinite query's pages in order. */
  readonly locs: readonly Loc[]
  /** The shape a member must fit, or `undefined` when the view doesn't describe the slot. */
  readonly shape: ViewShape | undefined
  /** Whether automatic placement applies: unfiltered, unsorted and complete. */
  readonly auto: boolean
}

/** A to-one view of the relation an operation edits. */
interface OneView {
  readonly query: Query
  readonly description: QueryDescription
  readonly loc: Loc
  readonly shape: ViewShape | undefined
}

/** A cached query of the scope with the description its key decodes to. */
interface Candidate {
  readonly query: Query
  readonly description: QueryDescription
}

/** The data a draft has staged for a query, and what it edited in place inside it. */
interface Staged {
  data: unknown
  readonly nodes: Set<object>
  /** Parts (a list, or an infinite query's page) whose accessors changed, to publish anew. */
  readonly parts: Set<object>
}

/** A caller's ref as a {@link Ref}, or `undefined` when it carries no cache identity. */
function toRef(value: unknown): Ref | undefined {
  if (!isRecord(value) || typeof value['type'] !== 'string' || typeof value['id'] !== 'string') {
    return undefined
  }
  const pivot = value['$pivot']
  return {
    type: value['type'],
    id: value['id'],
    pivot: isRecord(pivot) ? pivot : undefined,
    source: value,
  }
}

/** A create's input as a pending entry carries it: without the `id`, which the entry carries. */
function withoutId(resource: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const { id: _id, ...input } = resource
  return input
}

const toRefs = (values: readonly unknown[]): Ref[] =>
  values.map(toRef).filter((ref): ref is Ref => ref !== undefined)

/** The member lists of `query`'s own data: one, or an infinite query's pages in order. */
const topLocs = (query: Query, data: unknown): Loc[] =>
  partsOf(data).map((_, page) => ({ kind: 'top', query, page }))

/** Whether a query's data is a member list: a collection or an infinite query's pages. */
const isListData = (data: unknown): boolean => Array.isArray(data) || isInfiniteValue(data)

/** Whether page `at` of `data` is the cached page there, behind any root. */
const keptPage = (data: InfiniteValue, cached: InfiniteValue, at: number): boolean => {
  const page = data.pages[at]
  return (
    at < cached.pages.length &&
    typeof page === 'object' &&
    page !== null &&
    targetOf(page) === targetOf(cached.pages[at] as object)
  )
}

// ── The draft ──────────────────────────────────────────────────────────────────────────────

/** The drafts open on each QueryClient: neither committed, rolled back nor confirmed. */
const openDrafts = new WeakMap<QueryClient, Set<Draft>>()

class Draft implements OptimisticDraft, DraftLifecycle {
  readonly scope: string | undefined
  private readonly autoPlace: boolean
  private readonly into: Into | undefined
  private readonly markers: boolean
  private depth = 0
  private closed = false
  private readonly staged = new Map<Query, Staged>()
  private readonly undo: Undo[] = []
  private readonly marks = new Map<string, Mark>()
  private readonly registered: { query: Query; value: object; mark: Mark; array: boolean }[] = []
  /** The list marks the draft registered, with the array each is on. */
  private readonly listed: { query: Query; value: object; mark: ListMark }[] = []
  /** The resources the draft inserted, by `type:id`. */
  private readonly created = new Map<string, Created>()
  private readonly keys = new Map<string, QueryKey>()
  /** The keys of the queries only an attribute prediction touched. */
  private readonly patchedKeys = new Map<string, QueryKey>()
  /** The attribute predictions the draft holds. */
  private claims: FieldClaim[] = []
  /** The relations the draft edited, whose slots a read leaves alone while it is open. */
  private readonly owned = new Map<string, SlotClaim>()
  /** Every operation run so far, to run again on a query whose data a read replaces. */
  private log: (() => void)[] = []
  private opDepth = 0
  private replaying = false
  /** While replaying, the one query the draft edits. */
  private only: Query | undefined
  /** While replaying, the cache index, kept current for {@link only} alone. */
  private replayView: CacheView | undefined
  private confirmed = false

  constructor(
    private readonly queryClient: QueryClient,
    private readonly descriptor: ApiDescriptor,
    options: DraftOptions,
  ) {
    this.scope = options.scope
    this.autoPlace = options.autoPlace !== false
    this.into = options.into
    this.markers = options.markers !== false
    const open = openDrafts.get(queryClient) ?? new Set<Draft>()
    open.add(this)
    openDrafts.set(queryClient, open)
  }

  /** Run a public operation, recording it (when it isn't nested in another, or a replay) for replay. */
  private op(entry: () => void): void {
    const top = this.opDepth === 0 && !this.replaying
    this.opDepth += 1
    try {
      this.run(entry)
    } finally {
      this.opDepth -= 1
    }
    if (top) {
      this.log.push(entry)
    }
  }

  /** Stop replaying and leave the registry of open drafts. */
  private close(): void {
    this.log = []
    openDrafts.get(this.queryClient)?.delete(this)
  }

  // ── Transactions ──

  batch<R>(fn: () => R): R {
    return this.run(fn)
  }

  private run<R>(fn: () => R): R {
    if (this.closed) {
      throw new Error(
        '@haddowg/json-api-query: this optimistic draft has already committed or rolled back.',
      )
    }
    return this.publishing(fn)
  }

  /** Publish every query staged since the last flush, once each. */
  private flush(): void {
    const staged = [...this.staged]
    this.staged.clear()
    let view: CacheView | undefined
    for (const [query, { data, nodes, parts }] of staged) {
      const changed = new Set<object>()
      for (const part of partsOf(data)) {
        if (typeof part === 'object' && part !== null && parts.has(targetOf(part))) {
          changed.add(targetOf(part))
        }
      }
      if (nodes.size > 0 && data !== query.state.data) {
        // Data this draft replaced isn't the cache's yet: walk what it replaced, and read the pages
        // of an infinite query it kept from the cache index.
        const cached = query.state.data
        const infinite =
          isInfiniteValue(data) && isInfiniteValue(cached) ? { data, cached } : undefined
        const kept =
          infinite === undefined ? undefined : (view ??= this.view()).partsHolding(query, nodes)
        for (const [at, part] of partsOf(data).entries()) {
          if (typeof part !== 'object' || part === null) {
            continue
          }
          if (infinite !== undefined && keptPage(infinite.data, infinite.cached, at)) {
            if (kept?.has(at) === true) {
              changed.add(targetOf(part))
            }
            continue
          }
          let holds = false
          walkShaped(part, undefined, this.descriptor, (node) => {
            holds ||= nodes.has(targetOf(node))
          })
          if (holds) {
            changed.add(targetOf(part))
          }
        }
      } else if (nodes.size > 0) {
        view ??= this.view()
        const pages = partsOf(data)
        for (const at of view.partsHolding(query, nodes)) {
          const part = pages[at]
          if (typeof part === 'object' && part !== null) {
            changed.add(targetOf(part))
          }
        }
      }
      publishData(query, data, changed)
    }
  }

  private stage(query: Query): Staged {
    this.consider(query)
    return this.stageQuiet(query)
  }

  /** Stage `query` for publishing without counting it among the queries a write reconciles. */
  private stageQuiet(query: Query): Staged {
    let entry = this.staged.get(query)
    if (entry === undefined) {
      entry = { data: query.state.data, nodes: new Set(), parts: new Set() }
      this.staged.set(query, entry)
    }
    return entry
  }

  /** The data a query holds as this draft sees it: what it staged, else the cached data. */
  private current(query: Query): unknown {
    return this.staged.has(query) ? this.staged.get(query)?.data : query.state.data
  }

  private consider(query: Query): void {
    this.keys.set(query.queryHash, query.queryKey as QueryKey)
  }

  private read(loc: Loc): unknown {
    if (loc.kind === 'slot') {
      return loc.node[loc.rel]
    }
    return partsOf(this.current(loc.query))[loc.page]
  }

  private write(loc: Loc, value: unknown): void {
    if (loc.kind === 'slot') {
      loc.node[loc.rel] = value
      touchNode(this.queryClient, loc.node)
      this.stage(loc.query).nodes.add(targetOf(loc.node))
      return
    }
    const entry = this.stage(loc.query)
    const data = entry.data
    if (!isInfiniteValue(data)) {
      entry.data = value
      return
    }
    const pages = [...data.pages]
    pages[loc.page] = value
    entry.data = { ...data, pages }
  }

  /** The cached queries of the scope this draft can read, with their descriptions. */
  private candidates(): Candidate[] {
    const out: Candidate[] = []
    for (const query of this.only === undefined
      ? queriesIn(this.queryClient, this.scope)
      : this.replayed(this.only)) {
      const description = describeCached(query, this.descriptor)
      // A to-one read may hold `null`; a query that holds nothing yet has nothing to edit.
      if (description !== undefined && !description.skipped && this.current(query) !== undefined) {
        out.push({ query, description })
      }
    }
    return out
  }

  /** `query`, the one a replay edits, while it is a cached query of the scope. */
  private replayed(query: Query): Query[] {
    const cached = this.queryClient.getQueryCache().get(query.queryHash) === query
    return cached && scopeOf(query.queryKey) === this.scope ? [query] : []
  }

  /** Visit every resource in a candidate's data with the shape of the slot it sits in. */
  private walk(
    candidate: Candidate,
    visit: (node: Record<string, unknown>, shape: ViewShape | undefined) => void,
  ): void {
    const shape = shapeOfCached(candidate.query, this.descriptor)
    const seen = new Set<object>()
    for (const part of partsOf(this.current(candidate.query))) {
      walkShaped(part, shape, this.descriptor, visit, seen)
    }
  }

  /** The scope's cache index, brought up to date. */
  private view(): CacheView {
    const { replayView: view, only } = this
    if (view === undefined || only === undefined) {
      return cacheView(this.queryClient, this.scope, this.descriptor)
    }
    // A replay reads no query but the one it edits.
    if (this.replayed(only).length > 0 && !view.current(only)) {
      view.refresh(only)
    }
    return view
  }

  /**
   * Whether `query` is walked rather than read from the cache index: its data as this draft sees it
   * is data the draft staged in place of the cache's, or the draft is replaying into an infinite
   * query, which one walk visits across pages differently from the index's walk of each page.
   */
  private walksDirectly(query: Query): boolean {
    return (
      (this.staged.has(query) && this.staged.get(query)?.data !== query.state.data) ||
      (this.only !== undefined && isInfiniteValue(query.state.data))
    )
  }

  /**
   * The candidates holding a copy of `type:id` (any id of `type` when `id` is `undefined`), each
   * with a visitor of its copies, in the order a walk of every candidate would visit them.
   */
  private holders(
    type: string,
    id: string | undefined,
  ): {
    candidate: Candidate
    each: (visit: (node: Record<string, unknown>, shape: ViewShape | undefined) => void) => void
  }[] {
    const view = this.view()
    const holding = view.holding(type, id)
    const out: ReturnType<Draft['holders']> = []
    for (const candidate of this.candidates()) {
      if (this.walksDirectly(candidate.query) || holding.has(candidate.query)) {
        out.push({
          candidate,
          each: (visit) => this.copiesIn(view, candidate, type, id, visit),
        })
      }
    }
    return out
  }

  /**
   * Visit each copy of `type:id` (any id of `type` when `id` is `undefined`) in a candidate's data as
   * this draft sees it, in walk order, each with the shape of its slot: from the cache index, else,
   * for an infinite query some of whose pages the draft replaced, from the index for the pages it
   * kept and a walk of those it replaced, else from a walk of the whole.
   */
  private copiesIn(
    view: CacheView,
    candidate: Candidate,
    type: string,
    id: string | undefined,
    visit: (node: Record<string, unknown>, shape: ViewShape | undefined) => void,
  ): void {
    const { query } = candidate
    const matches = (node: Record<string, unknown>): boolean =>
      node['type'] === type && this.matchesId(id, node['id'] as string | undefined)
    if (!this.walksDirectly(query)) {
      if (!view.current(query)) {
        view.refresh(query)
      }
      for (const copy of view.visits(query, type, id)) {
        if (copy.first) {
          visit(copy.node, copy.shape)
        }
      }
      return
    }
    const data = this.current(query)
    const cached = query.state.data
    if (this.only !== undefined || !isInfiniteValue(data) || !isInfiniteValue(cached)) {
      this.walk(candidate, (node, shape) => {
        if (matches(node)) {
          visit(node, shape)
        }
      })
      return
    }
    if (!view.current(query)) {
      view.refresh(query)
    }
    const kept = (page: number): boolean => keptPage(data, cached, page)
    const shape = shapeOfCached(query, this.descriptor)
    // What the pages this draft replaced reach, for the pages after them.
    const walked = new Map<number, Set<object>>()
    const earlier = (node: object, page: number): boolean =>
      view.partsReaching(query, node).some((part) => part < page && kept(part)) ||
      [...walked].some(([part, nodes]) => part < page && nodes.has(node))
    const copies = view.visits(query, type, id)
    data.pages.forEach((page, at) => {
      if (kept(at)) {
        for (const copy of copies) {
          if (copy.part === at && !earlier(copy.node, at)) {
            visit(copy.node, copy.shape)
          }
        }
        return
      }
      const nodes = new Set<object>()
      walkShaped(page, shape, this.descriptor, (node, slot) => {
        nodes.add(node)
        if (matches(node) && !earlier(node, at)) {
          visit(node, slot)
        }
      })
      walked.set(at, nodes)
    })
  }

  private matchesId(id: string | undefined, candidate: string | undefined): boolean {
    return id === undefined || candidate === undefined || id === candidate
  }

  // ── Markers ──

  private markFor(type: string, id: string | undefined): Mark {
    const key = identityKey(type, id)
    let mark = this.marks.get(key)
    if (mark === undefined) {
      mark = { type, id, pending: new Map(), counts: new Map() }
      this.marks.set(key, mark)
    }
    return mark
  }

  private register(query: Query, value: object, mark: Mark, rel?: string): void {
    if (!this.markers) {
      return
    }
    const target = targetOf(value)
    if (rel === undefined) {
      const set = resourceMarks.get(target) ?? new Set<Mark>()
      if (set.has(mark)) {
        return
      }
      set.add(mark)
      resourceMarks.set(target, set)
    } else {
      const map = arrayMarks.get(target) ?? new Map<Mark, string>()
      if (map.has(mark)) {
        return
      }
      map.set(mark, rel)
      arrayMarks.set(target, map)
    }
    this.registered.push({ query, value: target, mark, array: rel !== undefined })
  }

  /**
   * Mark every cached copy of `type:id` as touched (and, with `rel`, the relation's slot array on
   * each, for its `$count`), staging each copy's query so the marker change republishes it.
   */
  private markCopies(type: string, id: string | undefined, rel?: string): void {
    if (!this.markers) {
      return
    }
    const mark = this.markFor(type, id)
    for (const { candidate, each } of this.holders(type, id)) {
      each((node) => {
        this.register(candidate.query, node, mark)
        const slot = rel === undefined ? undefined : node[rel]
        if (Array.isArray(slot)) {
          this.register(candidate.query, slot, mark, rel)
        }
        this.stage(candidate.query).nodes.add(targetOf(node))
      })
    }
  }

  private defer(type: string, id: string | undefined, rel: string, ref: Ref): void {
    const mark = this.markFor(type, id)
    const members = mark.pending.get(rel) ?? new Map<string, PendingMember>()
    const created = this.created.get(identityKey(ref.type, ref.id))
    const member = created === undefined ? memberData(ref.source) : memberData(created.input)
    members.set(identityKey(ref.type, ref.id), {
      type: ref.type,
      id: ref.id,
      ...(member === undefined ? {} : { member }),
    })
    mark.pending.set(rel, members)
  }

  /**
   * Record a list mark on `value`, a list (or page) of `query`, staging the query so the list's
   * `$pending()` and total republish.
   */
  private registerList(query: Query, value: object, mark: ListMark): void {
    if (!this.markers) {
      return
    }
    const target = targetOf(value)
    const set = listMarks.get(target) ?? new Set<ListMark>()
    set.add(mark)
    listMarks.set(target, set)
    this.listed.push({ query, value: target, mark })
    this.stageQuiet(query).parts.add(target)
  }

  private adjustCount(type: string, id: string | undefined, rel: string, delta: number): void {
    if (delta === 0 || this.replaying) {
      return
    }
    const mark = this.markFor(type, id)
    mark.counts.set(rel, (mark.counts.get(rel) ?? 0) + delta)
  }

  /** Clear every marker, deferred member and count adjustment, staging their queries. */
  private clearMarks(): void {
    for (const { query, value, mark, array } of this.registered) {
      if (array) {
        const map = arrayMarks.get(value)
        map?.delete(mark)
        if (map?.size === 0) {
          arrayMarks.delete(value)
        }
      } else {
        const set = resourceMarks.get(value)
        set?.delete(mark)
        if (set?.size === 0) {
          resourceMarks.delete(value)
        }
        this.stageQuiet(query).nodes.add(value)
      }
    }
    this.registered.length = 0
    this.marks.clear()
    for (const { query, value, mark } of this.listed) {
      const set = listMarks.get(value)
      set?.delete(mark)
      if (set?.size === 0) {
        listMarks.delete(value)
      }
      this.stageQuiet(query).parts.add(value)
    }
    this.listed.length = 0
  }

  // ── Members ──

  /**
   * `ref` as it enters relation `rel` of `type`: where the relation renders `meta.pivot` on every
   * member, it carries the pivot values the operation sent, or an empty pivot when it sent none,
   * so a pending member has the `$pivot` its slot's type promises.
   */
  private rendered<R extends Ref | undefined>(type: string, rel: string, ref: R): R {
    if (ref === undefined || ref.pivot !== undefined) {
      return ref
    }
    return this.descriptor[type]?.relations[rel]?.pivotRendered === true
      ? ({ ...ref, pivot: {} } as R)
      : ref
  }

  private renderedAll(type: string, rel: string, refs: readonly Ref[]): Ref[] {
    return refs.map((ref) => this.rendered(type, rel, ref))
  }

  /**
   * The value `ref` enters a destination of `shape` as: an identifier view, or a per-edge view of
   * the copy that fits (the caller's, else the richest cached), keeping only the members the shape
   * selects; `undefined` when no copy fits.
   */
  private memberFor(ref: Ref, shape: ViewShape): object | undefined {
    const meta = ref.pivot === undefined ? undefined : { pivot: { ...ref.pivot } }
    const edge = { type: ref.type, id: ref.id, ...(meta === undefined ? {} : { meta }) }
    return memberViewFor(this.queryClient, edge, shape, this.descriptor, this.scope, () => {
      const created = this.created.get(identityKey(ref.type, ref.id))
      return [created === undefined ? ref.source : this.hydrate(ref.type, created.completed, shape)]
    })
  }

  /**
   * A created row as a destination of `shape` would hold it: each relation the shape includes,
   * resolved from the cache by the ref the row gives, as a view keeping what the slot below
   * selects. A ref no cached copy fits is left as it is, so the row doesn't fit.
   */
  private hydrate(
    type: string,
    row: Readonly<Record<string, unknown>>,
    shape: ViewShape,
  ): Readonly<Record<string, unknown>> {
    if (shape.kind === 'identifiers') {
      return row
    }
    const out: Record<string, unknown> = { ...row }
    const rendered = shape.rendered.get(type)
    for (const [rel, below] of shape.relations) {
      if (rendered?.has(rel) !== true) {
        continue
      }
      const value = row[rel]
      if (Array.isArray(value)) {
        const members = value.map((member) => this.resolveFor(member, below))
        if (members.every((member) => member !== undefined)) {
          out[rel] = members
        }
      } else if (isRecord(value)) {
        const member = this.resolveFor(value, below)
        if (member !== undefined) {
          out[rel] = member
        }
      }
    }
    return out
  }

  /** A view of the copy of `ref` that fits `shape`: the ref itself when it does, else the cache's. */
  private resolveFor(ref: unknown, shape: ViewShape): object | undefined {
    const identity = identityOf(ref)
    if (identity === undefined) {
      return undefined
    }
    return memberViewFor(this.queryClient, identity, shape, this.descriptor, this.scope, () => [
      ref,
    ])
  }

  /** What {@link Into} sees of `ref` entering a destination of `shape`. */
  private preview(ref: Ref, shape: ViewShape): { member: DraftMember; value: object | undefined } {
    const value = this.memberFor(ref, shape)
    const created = this.created.get(identityKey(ref.type, ref.id))
    const source = created === undefined ? ref.source : { ...created.completed, type: ref.type }
    const member = (value ??
      (isRecord(source)
        ? source
        : { type: ref.type, id: ref.id, $pivot: ref.pivot })) as DraftMember
    return { member, value }
  }

  // ── Views of a relation ──

  private gather(
    type: string,
    id: string | undefined,
    rel: string,
  ): { many: ManyView[]; one: OneView[] } {
    const many: ManyView[] = []
    const one: OneView[] = []
    const cardinality = this.descriptor[type]?.relations[rel]?.cardinality
    const view = this.view()
    const holding = view.holding(type, id)
    for (const candidate of this.candidates()) {
      const { query, description } = candidate
      // The relation's own reads.
      if (
        (description.operation === 'fetchRelated' ||
          description.operation === 'fetchRelationship') &&
        description.type === type &&
        description.rel === rel &&
        this.matchesId(id, description.id)
      ) {
        this.consider(query)
        const data = this.current(query)
        const shape = shapeOfCached(query, this.descriptor)
        if (cardinality === 'many' && isListData(data)) {
          many.push({
            query,
            description,
            locs: topLocs(query, data),
            shape,
            auto: isUnfilteredUnsorted(description) && isComplete(data),
          })
        } else if (cardinality === 'one' && !isListData(data)) {
          one.push({ query, description, loc: { kind: 'top', query, page: 0 }, shape })
        }
        continue
      }
      // The relation's slot on every cached copy of the parent.
      if (!this.walksDirectly(query) && !holding.has(query)) {
        continue
      }
      const copies: [Record<string, unknown>, ViewShape | undefined][] = []
      this.copiesIn(view, candidate, type, id, (node, at) => {
        copies.push([node, at])
      })
      for (const [node, at] of copies) {
        this.consider(query)
        const slot = node[rel]
        if (linksOnly(node, rel, slot)) {
          continue
        }
        const shape = at === undefined ? undefined : slotShape(at, type, rel)
        const loc: Loc = { kind: 'slot', query, node, rel }
        if (cardinality === 'many' && Array.isArray(slot)) {
          many.push({
            query,
            description,
            locs: [loc],
            shape,
            auto: shape !== undefined && isUnfilteredUnsorted(description, rel) && isComplete(slot),
          })
        } else if (cardinality === 'one' && !Array.isArray(slot)) {
          one.push({ query, description, loc, shape })
        }
      }
    }
    return { many, one }
  }

  private lists(view: ManyView): unknown[][] {
    return view.locs.map((loc) => {
      const list = this.read(loc)
      return Array.isArray(list) ? (list as unknown[]) : []
    })
  }

  private holds(view: ManyView, ref: { type: string; id: string }): boolean {
    return this.lists(view).some((list) => list.some((member) => addresses(member, ref)))
  }

  /** Whether `view` is complete: its last list carries no `next` link (an infinite query's last page). */
  private complete(view: ManyView): boolean {
    const data = view.locs[0]?.kind === 'top' ? this.current(view.query) : this.read(view.locs[0]!)
    return isComplete(data)
  }

  /** The list and index a placement resolves to in `view`, or `undefined` to skip the view. */
  private position(
    view: ManyView,
    placement: Placement,
  ): { list: number; index: number } | undefined {
    const lists = this.lists(view)
    const last = lists.length - 1
    if (last < 0 || placement === false) {
      return undefined
    }
    const total = lists.reduce((sum, list) => sum + list.length, 0)
    let flat: number
    if (placement === 'end') {
      if (!this.complete(view)) {
        return undefined
      }
      return { list: last, index: lists[last]!.length }
    } else if (placement === 'start') {
      return firstPage(lists[0]) ? { list: 0, index: 0 } : undefined
    } else if (typeof placement === 'function') {
      const at = placement(lists.flat() as DraftMember[])
      flat = at < 0 ? total : at
    } else {
      flat = placement
    }
    flat = Math.max(0, Math.min(total, Math.trunc(flat)))
    for (let list = 0; list <= last; list++) {
      const length = lists[list]!.length
      if (flat < length || list === last) {
        return { list, index: Math.min(flat, length) }
      }
      flat -= length
    }
    return undefined
  }

  /** Insert `member` at `at` in `view`, recording its inverse. */
  private insertAt(
    view: ManyView,
    at: { list: number; index: number },
    member: object,
  ): object | undefined {
    const loc = view.locs[at.list]!
    const list = this.read(loc)
    if (!Array.isArray(list)) {
      return undefined
    }
    const members = [...list]
    members.splice(at.index, 0, member)
    const produced = withMembers(list, members)
    this.write(loc, produced)
    this.undo.push({ kind: 'added', loc, produced, member })
    return produced
  }

  /** Remove every member of `view` addressing one of `refs`; returns how many it removed. */
  private removeFrom(locs: readonly Loc[], refs: readonly { type: string; id: string }[]): number {
    let removed = 0
    for (const loc of locs) {
      const list = this.read(loc)
      if (!Array.isArray(list)) {
        continue
      }
      const gone: { member: object; index: number }[] = []
      const kept: unknown[] = []
      list.forEach((member, index) => {
        if (refs.some((ref) => addresses(member, ref))) {
          gone.push({ member: member as object, index })
        } else {
          kept.push(member)
        }
      })
      if (gone.length === 0) {
        continue
      }
      const produced = withMembers(list, kept)
      this.write(loc, produced)
      for (const { member, index } of gone) {
        this.undo.push({ kind: 'removed', loc, produced, member, index })
      }
      removed += gone.length
    }
    return removed
  }

  /**
   * Where `ref` goes in `view`: automatically (unfiltered, unsorted, complete, and for `'start'` a
   * first page), else where `into` says, else nowhere. Also returns the value to insert, when one
   * fits.
   */
  private place(
    view: ManyView,
    ref: Ref,
    at: 'start' | 'end',
    into: Into | undefined,
    offset: number,
  ): { at: { list: number; index: number }; value: object | undefined } | undefined {
    if (view.shape === undefined) {
      return undefined
    }
    if (this.autoPlace && view.auto) {
      const position = this.position(view, at)
      if (position !== undefined) {
        return {
          at: at === 'start' ? { list: 0, index: offset } : position,
          value: this.memberFor(ref, view.shape),
        }
      }
    }
    if (into === undefined) {
      return undefined
    }
    const { member, value } = this.preview(ref, view.shape)
    const position = this.position(view, into(view.description as DraftQuery, member))
    return position === undefined ? undefined : { at: position, value }
  }

  // ── Operations ──

  patch(type: string, id: string | undefined, change: unknown): void {
    this.op(() => this.patchNow(type, id, change))
  }

  private patchNow(type: string, id: string | undefined, change: unknown): void {
    const resource = this.descriptor[type]
    if (resource === undefined || !isRecord(change)) {
      return
    }
    const attributes = Object.entries(change).filter(([key]) => key in resource.attributes)
    // A replay leaves attributes to the claims, which a normalisation already showed.
    if (attributes.length > 0 && !this.replaying) {
      const mark = this.markFor(type, id)
      const claims = new Map(
        attributes.map(([key, value]) => [key, this.claim(type, id, key, value)] as const),
      )
      for (const { candidate, each } of this.holders(type, id)) {
        each((node, shape) => {
          let touched = false
          for (const [key, claim] of claims) {
            if (!writable(node, key, shape)) {
              continue
            }
            touched = true
            showClaim(node, key, claim, candidate.query)
          }
          if (touched) {
            this.patchedKeys.set(candidate.query.queryHash, candidate.query.queryKey as QueryKey)
            this.stageQuiet(candidate.query).nodes.add(targetOf(node))
            this.register(candidate.query, node, mark)
          }
        })
      }
    }
    for (const [rel, value] of Object.entries(change)) {
      const relation = resource.relations[rel]
      if (relation === undefined) {
        continue
      }
      if (relation.cardinality === 'many' && Array.isArray(value)) {
        this.replaceMembers(type, id, rel, value)
      } else if (relation.cardinality === 'one' && (value === null || isRecord(value))) {
        this.link(type, id, rel, value as DraftRef | null)
      }
    }
  }

  /** This draft's claim on attribute `key` of `type:id`, made the field's latest prediction. */
  private claim(type: string, id: string | undefined, key: string, value: unknown): FieldClaim {
    let claim = this.claims.find((mine) => mine.type === type && mine.id === id && mine.key === key)
    if (claim === undefined) {
      claim = {
        owner: this,
        scope: this.scope,
        type,
        id,
        key,
        value,
        seq: 0,
        nodes: new Map(),
        adopt: (node, query) => {
          this.register(query, node, this.markFor(type, id))
        },
      }
      this.claims.push(claim)
    }
    claim.value = value
    addClaim(this.queryClient, claim)
    return claim
  }

  /**
   * Own relation `rel` of `type:id`: while the draft is open, a read's linkage for it is recorded
   * for a rollback rather than shown.
   */
  private own(type: string, id: string | undefined, rel: string): void {
    const key = relationIdentityKey(type, id, rel)
    if (this.owned.has(key)) {
      return
    }
    const claim: SlotClaim = {
      owner: this,
      scope: this.scope,
      type,
      id,
      rel,
      seq: 0,
      server: new Map(),
    }
    this.owned.set(key, claim)
    addSlotClaim(this.queryClient, claim)
  }

  /**
   * Give up every relation the draft owns. With `restore`, each slot a read brought newer linkage
   * for while the draft was open shows it (a slot it can't fill has its query invalidated), unless
   * another open draft owns the relation, which then records it instead.
   */
  private releaseSlots(restore: boolean): void {
    const claims = [...this.owned.values()]
    this.owned.clear()
    // The latest first, as a rollback undoes them.
    for (let at = claims.length - 1; at >= 0; at--) {
      const claim = claims[at]!
      removeSlotClaim(this.queryClient, claim)
      if (!restore) {
        continue
      }
      const next = topSlotClaim(this.queryClient, this.scope, claim.type, claim.id, claim.rel)
      for (const value of claim.server.values()) {
        if (next !== undefined) {
          recordOnClaim(next, value)
        } else if (value.fits) {
          this.write(
            { kind: 'slot', query: value.query, node: value.node, rel: claim.rel },
            value.value,
          )
          recordSlot(value.node, claim.rel, value.slot)
        } else {
          invalidate(this.queryClient, value.query)
        }
      }
    }
  }

  link(
    type: string,
    id: string | undefined,
    rel: string,
    ref: DraftRef | null,
    options: PlaceOptions = {},
  ): void {
    this.op(() => {
      this.own(type, id, rel)
      const next = ref === null ? null : this.rendered(type, rel, toRef(ref))
      if (next === undefined) {
        return
      }
      const into = options.into ?? this.into
      const { one } = this.gather(type, id, rel)
      for (const view of one) {
        const current = this.read(view.loc)
        if (next === null) {
          if (current !== null && current !== undefined) {
            this.write(view.loc, null)
            this.undo.push({ kind: 'linked', loc: view.loc, prior: current, wrote: null })
          }
          continue
        }
        if (addresses(current, next) || view.shape === undefined) {
          continue
        }
        const { member, value } = this.preview(next, view.shape)
        if (
          !this.autoPlace &&
          (into === undefined || into(view.description as DraftQuery, member) === false)
        ) {
          continue
        }
        if (value === undefined) {
          this.defer(type, id, rel, next)
          continue
        }
        this.write(view.loc, value)
        this.undo.push({ kind: 'linked', loc: view.loc, prior: current, wrote: value })
        this.register(view.query, value, this.markFor(next.type, next.id))
      }
      this.markCopies(type, id, rel)
    })
  }

  attach(
    type: string,
    id: string | undefined,
    rel: string,
    refs: readonly DraftRef[],
    at: 'start' | 'end' | PlaceOptions = {},
  ): void {
    this.op(() => {
      this.own(type, id, rel)
      const options = typeof at === 'string' ? { at } : at
      const added = this.renderedAll(type, rel, toRefs(refs))
      const { many } = this.gather(type, id, rel)
      const members = added.filter((ref) => !many.some((view) => this.holds(view, ref)))
      for (const view of many) {
        this.addTo(view, type, id, rel, added, options)
      }
      this.adjustCount(type, id, rel, members.length)
      this.markCopies(type, id, rel)
    })
  }

  /** Place each of `refs` the view doesn't hold, deferring one that fits nowhere it was to go. */
  private addTo(
    view: ManyView,
    type: string,
    id: string | undefined,
    rel: string,
    refs: readonly Ref[],
    options: PlaceOptions,
  ): void {
    const into = options.into ?? this.into
    let offset = 0
    for (const ref of refs) {
      if (this.holds(view, ref)) {
        continue
      }
      const placed = this.place(view, ref, options.at ?? 'end', into, offset)
      if (placed === undefined) {
        continue
      }
      if (placed.value === undefined) {
        this.defer(type, id, rel, ref)
        continue
      }
      this.insertAt(view, placed.at, placed.value)
      this.register(view.query, placed.value, this.markFor(ref.type, ref.id))
      offset += 1
    }
  }

  detach(type: string, id: string | undefined, rel: string, refs: readonly DraftRef[]): void {
    this.op(() => {
      this.own(type, id, rel)
      const removed = toRefs(refs)
      const { many } = this.gather(type, id, rel)
      const members =
        many.length === 0
          ? removed
          : removed.filter((ref) => many.some((view) => this.holds(view, ref)))
      for (const view of many) {
        this.removeFrom(view.locs, removed)
      }
      this.adjustCount(type, id, rel, -members.length)
      this.markCopies(type, id, rel)
    })
  }

  replaceMembers(
    type: string,
    id: string | undefined,
    rel: string,
    refs: readonly DraftRef[],
    options: PlaceOptions = {},
  ): void {
    this.op(() => {
      this.own(type, id, rel)
      const next = this.renderedAll(type, rel, toRefs(refs))
      const { many } = this.gather(type, id, rel)
      const counted = this.countOf(type, id, rel)
      for (const view of many) {
        // Every member not among `refs` leaves the view.
        const leaving = this.lists(view)
          .flat()
          .map(identityOf)
          .filter(
            (member): member is { type: string; id: string } =>
              member !== undefined && !next.some((ref) => addresses(member, ref)),
          )
        this.removeFrom(view.locs, leaving)
        const single = view.locs.length === 1 ? view.locs[0] : undefined
        if (single !== undefined && this.autoPlace && view.auto && view.shape !== undefined) {
          this.replaceInOrder(view, single, type, id, rel, next)
        } else {
          this.addTo(view, type, id, rel, next, options)
        }
      }
      if (counted !== undefined) {
        this.adjustCount(type, id, rel, next.length - counted)
      }
      this.markCopies(type, id, rel)
    })
  }

  /** A complete, automatically placed list becomes exactly `refs`, in their order. */
  private replaceInOrder(
    view: ManyView,
    loc: Loc,
    type: string,
    id: string | undefined,
    rel: string,
    refs: readonly Ref[],
  ): void {
    const list = this.read(loc)
    if (!Array.isArray(list) || view.shape === undefined) {
      return
    }
    const members: unknown[] = []
    const added: object[] = []
    for (const ref of refs) {
      const existing = list.find((member) => addresses(member, ref))
      if (existing !== undefined) {
        members.push(existing)
        continue
      }
      const value = this.memberFor(ref, view.shape)
      if (value === undefined) {
        this.defer(type, id, rel, ref)
        continue
      }
      members.push(value)
      added.push(value)
      this.register(view.query, value, this.markFor(ref.type, ref.id))
    }
    const unchanged =
      members.length === list.length && members.every((member, index) => member === list[index])
    if (unchanged) {
      return
    }
    const produced = withMembers(list, members)
    this.write(loc, produced)
    this.undo.push({
      kind: 'ordered',
      loc,
      produced,
      order: list.flatMap((member) => {
        const identity = identityOf(member)
        return identity === undefined ? [] : [identityKey(identity.type, identity.id)]
      }),
    })
    for (const member of added) {
      this.undo.push({ kind: 'added', loc, produced, member })
    }
  }

  /** The count a cached copy of the parent reports for `rel`, when one carries a count. */
  private countOf(type: string, id: string | undefined, rel: string): number | undefined {
    let count: number | undefined
    for (const { each } of this.holders(type, id)) {
      each((node) => {
        if (count !== undefined) {
          return
        }
        const $count = node['$count']
        if (typeof $count === 'function') {
          const value: unknown = ($count as (name: string) => unknown).call(node, rel)
          count = typeof value === 'number' ? value : undefined
        }
      })
    }
    return count
  }

  insert<T extends string>(
    type: T,
    resource: unknown,
    into?: InsertInto<ApiDescriptor, T>,
    options: InsertOptions = {},
  ): void {
    this.op(() => {
      const ref = toRef(isRecord(resource) ? { ...resource, type } : undefined)
      // The rows `place` is shown are all of type `T`, as `InsertInto` promises.
      const place = (into as Into | undefined) ?? this.into
      if (ref === undefined || !isRecord(resource)) {
        return
      }
      this.created.set(identityKey(type, ref.id), {
        input: resource,
        completed: this.completeRow(type, resource, options.complete),
      })
      for (const candidate of this.candidates()) {
        const { query, description } = candidate
        if (description.operation !== 'fetchMany' || description.type !== type) {
          continue
        }
        this.consider(query)
        if (place === undefined) {
          continue
        }
        const shape = shapeOfCached(query, this.descriptor)
        if (shape === undefined) {
          continue
        }
        const view: ManyView = {
          query,
          description,
          locs: topLocs(query, this.current(query)),
          shape,
          auto: false,
        }
        if (this.holds(view, ref)) {
          continue
        }
        const { member, value } = this.preview(ref, shape)
        const placement = place(description as DraftQuery, member)
        const position = this.position(view, placement)
        if (position === undefined) {
          continue
        }
        const entries = new Map<string, PendingCreate>()
        if (value === undefined) {
          // The completed row still doesn't fit: a pending entry where `into` placed it.
          const at: PendingPlacement =
            placement === 'start' || placement === 'end' ? placement : position.index
          entries.set(identityKey(type, ref.id), {
            type,
            id: ref.id,
            at,
            input: withoutId(resource),
          })
        } else {
          this.insertAt(view, position, value)
          this.register(query, value, this.markFor(type, ref.id))
        }
        // Every page of the list reports the moved total; the entry rides the page it's placed on.
        view.locs.forEach((loc, page) => {
          const list = this.read(loc)
          if (Array.isArray(list)) {
            this.registerList(query, list, {
              entries: page === position.list ? entries : new Map(),
              delta: 1,
            })
          }
        })
      }
    })
  }

  /**
   * `resource` completed for the lists it may enter: the input, then `complete`'s values for the
   * keys the input lacks (an input value always wins), then `null` for each attribute the
   * descriptor lists as server-only and nullable that is still missing.
   */
  private completeRow(
    type: string,
    resource: Readonly<Record<string, unknown>>,
    complete: Readonly<Record<string, unknown>> | undefined,
  ): Readonly<Record<string, unknown>> {
    const out: Record<string, unknown> = { ...complete, ...resource, type, id: resource['id'] }
    const spec = this.descriptor[type]
    const nullable = new Set(spec?.nullable ?? [])
    for (const attribute of spec?.serverOnly ?? []) {
      if (nullable.has(attribute) && !Object.hasOwn(out, attribute)) {
        out[attribute] = null
      }
    }
    return out
  }

  evict(type: string, id: string): void {
    this.op(() => {
      const evicted = { type, id }
      const parents = new Map<string, { type: string; id: string | undefined; rel: string }>()
      const counted = (parent: string, parentId: string | undefined, rel: string): void => {
        parents.set(relationIdentityKey(parent, parentId, rel), { type: parent, id: parentId, rel })
      }
      // Only a query holding the resource has anything to evict.
      const view = this.view()
      const holding = view.holding(type, id)
      for (const candidate of this.candidates()) {
        const { query, description } = candidate
        if (!holding.has(query) && !this.walksDirectly(query)) {
          continue
        }
        const own =
          description.type === type &&
          description.id === id &&
          description.operation !== 'fetchMany'
        if (own) {
          continue
        }
        const data = this.current(query)
        let held = false
        // The query's own member list, or its to-one value.
        if (description.collection && isListData(data)) {
          if (this.removeFrom(topLocs(query, data), [evicted]) > 0) {
            held = true
            if (description.rel !== undefined) {
              counted(description.type, description.id, description.rel)
            }
          }
        } else if (description.rel !== undefined && addresses(data, evicted)) {
          const loc: Loc = { kind: 'top', query, page: 0 }
          this.write(loc, null)
          this.undo.push({ kind: 'linked', loc, prior: data, wrote: null })
          held = true
        }
        // Every relation slot holding it, on every resource the query holds: from the cache index,
        // when the query's data is the cache's and each copy has the one slot the index names.
        const slots: { node: Record<string, unknown>; rel: string }[] = []
        if (!this.walksDirectly(query) && !view.current(query)) {
          view.refresh(query)
        }
        const indexed = this.walksDirectly(query) ? undefined : view.slotsHolding(query, type, id)
        if (indexed === undefined) {
          this.walk(candidate, (node) => {
            if (addresses(node, evicted)) {
              held = true
              return
            }
            const nodeType = node['type'] as string
            for (const rel of Object.keys(this.descriptor[nodeType]?.relations ?? {})) {
              const slot = node[rel]
              if (
                (Array.isArray(slot) && slot.some((member) => addresses(member, evicted))) ||
                addresses(slot, evicted)
              ) {
                slots.push({ node, rel })
              }
            }
          })
        } else {
          if (view.visits(query, type, id).some((copy) => copy.first)) {
            held = true
          }
          for (const [node, rel] of indexed) {
            const last = slots.at(-1)
            if (!addresses(node, evicted) && !(last?.node === node && last.rel === rel)) {
              slots.push({ node, rel })
            }
          }
        }
        for (const { node, rel } of slots) {
          this.own(node['type'] as string, node['id'] as string, rel)
          const loc: Loc = { kind: 'slot', query, node, rel }
          const slot = node[rel]
          if (Array.isArray(slot)) {
            this.removeFrom([loc], [evicted])
            counted(node['type'] as string, node['id'] as string, rel)
          } else {
            this.write(loc, null)
            this.undo.push({ kind: 'linked', loc, prior: slot, wrote: null })
          }
          held = true
        }
        if (held) {
          this.consider(query)
        }
      }
      for (const parent of parents.values()) {
        this.adjustCount(parent.type, parent.id, parent.rel, -1)
        this.markCopies(parent.type, parent.id, parent.rel)
      }
    })
  }

  resolve(type: string, id: string): DraftMember {
    let best: Record<string, unknown> | undefined
    let richness = -1
    for (const { each } of this.holders(type, id)) {
      each((node) => {
        const keys = Object.keys(node).length
        if (keys > richness) {
          best = node
          richness = keys
        }
      })
    }
    return (best ?? { type, id }) as DraftMember
  }

  // ── Ending the transaction ──

  rollback(): void {
    if (this.closed) {
      return
    }
    this.close()
    this.run(() => {
      for (let step = this.undo.length - 1; step >= 0; step--) {
        this.revert(this.undo[step]!)
      }
      this.undo.length = 0
      this.releaseSlots(true)
      for (let at = this.claims.length - 1; at >= 0; at--) {
        this.unclaim(this.claims[at]!)
      }
      this.claims = []
      this.clearMarks()
    })
    this.closed = true
  }

  /**
   * Withdraw one attribute prediction: each node still showing it shows the field's next latest
   * prediction, else the newest server value it records, else what it showed before.
   */
  private unclaim(claim: FieldClaim): void {
    removeClaim(this.queryClient, claim)
    const { key } = claim
    for (const [target, { node, query, had, prior }] of claim.nodes) {
      if (!Object.hasOwn(node, key) || node[key] !== claim.value) {
        continue
      }
      const id = typeof node['id'] === 'string' ? node['id'] : claim.id
      const next = topClaim(this.queryClient, this.scope, claim.type, id, key)
      if (next !== undefined) {
        node[key] = next.value
        if (!next.nodes.has(target)) {
          next.nodes.set(target, { node, query, had, prior })
        }
      } else {
        const server = serverValueOf(node, key)
        if (server !== undefined) {
          node[key] = server.value
        } else if (had) {
          node[key] = prior
        } else {
          delete node[key]
        }
      }
      this.stageQuiet(query).nodes.add(target)
    }
  }

  commit(): void {
    if (this.closed) {
      return
    }
    this.run(() => {
      this.settle()
      this.clearMarks()
    })
    this.closed = true
  }

  /** Leave the open drafts and drop the undo state and every prediction and owned relation. */
  private settle(): void {
    this.close()
    this.undo.length = 0
    this.dropClaims()
    this.releaseSlots(false)
  }

  /** Withdraw every attribute prediction without changing what any node shows. */
  private dropClaims(): void {
    for (const claim of this.claims) {
      removeClaim(this.queryClient, claim, true)
    }
    this.claims = []
  }

  // ── The lifecycle's own steps (see DraftLifecycle) ──

  confirm(): void {
    if (this.closed || this.confirmed) {
      return
    }
    this.confirmed = true
    this.settle()
  }

  claimedFields(): ReadonlySet<string> {
    const out = new Set<string>()
    for (const claim of this.claims) {
      for (const { node } of claim.nodes.values()) {
        if (typeof node['id'] === 'string') {
          out.add(fieldKey(claim.type, node['id'], claim.key))
        }
      }
      if (claim.id !== undefined) {
        out.add(fieldKey(claim.type, claim.id, claim.key))
      }
    }
    return out
  }

  reconcileKeys(): readonly QueryKey[] {
    return [...this.keys.values()]
  }

  reapply(query: Query): void {
    if (this.closed || this.confirmed || this.log.length === 0) {
      return
    }
    const log = [...this.log]
    this.only = query
    this.replaying = true
    this.replayView = cacheView(this.queryClient, this.scope, this.descriptor)
    try {
      this.run(() => {
        for (const entry of log) {
          entry()
        }
      })
    } finally {
      this.only = undefined
      this.replaying = false
      this.replayView = undefined
    }
  }

  swapId(type: string, from: string, to: string): void {
    this.run(() => {
      for (const { candidate, each } of this.holders(type, from)) {
        each((node) => {
          if (node['type'] === type && node['id'] === from) {
            // Reported while the index still holds it under the id it had.
            renameNode(this.queryClient, node)
            node['id'] = to
            this.stageQuiet(candidate.query).nodes.add(targetOf(node))
          }
        })
      }
    })
    for (const draft of openDrafts.get(this.queryClient) ?? []) {
      draft.publishing(() => draft.renamePending(type, from, to))
    }
    this.publishing(() => this.renamePending(type, from, to))
  }

  /** Run `fn` and publish what it staged, whether or not the draft is still open. */
  private publishing<R>(fn: () => R): R {
    this.depth += 1
    try {
      return fn()
    } finally {
      this.depth -= 1
      if (this.depth === 0) {
        this.flush()
      }
    }
  }

  /**
   * Rename a deferred member or pending create `type:from` to `type:to`, wherever this draft
   * recorded it.
   */
  private renamePending(type: string, from: string, to: string): void {
    const before = identityKey(type, from)
    const after = identityKey(type, to)
    for (const mark of this.marks.values()) {
      for (const members of mark.pending.values()) {
        const found = members.get(before)
        if (found !== undefined) {
          members.delete(before)
          const member =
            found.member !== undefined && found.member['id'] === from
              ? { ...found.member, id: to }
              : found.member
          members.set(after, { type, id: to, ...(member === undefined ? {} : { member }) })
        }
      }
    }
    for (const { query, value, mark } of this.listed) {
      const entry = mark.entries.get(before)
      if (entry !== undefined) {
        mark.entries.delete(before)
        mark.entries.set(after, { ...entry, id: to })
        this.stageQuiet(query).parts.add(value)
      }
    }
    const created = this.created.get(before)
    if (created !== undefined) {
      this.created.delete(before)
      this.created.set(after, created)
    }
  }

  shows(type: string, id: string): boolean {
    const key = identityKey(type, id)
    if (this.marks.has(key)) {
      return true
    }
    for (const mark of this.marks.values()) {
      for (const members of mark.pending.values()) {
        if (members.has(key)) {
          return true
        }
      }
    }
    return this.listed.some(({ mark }) => mark.entries.has(key))
  }

  /** Replay one inverse operation, compare-and-swap. */
  private revert(step: Undo): void {
    switch (step.kind) {
      case 'linked': {
        const current = this.read(step.loc)
        const same =
          current === step.wrote ||
          (typeof current === 'object' &&
            current !== null &&
            typeof step.wrote === 'object' &&
            step.wrote !== null &&
            targetOf(current) === targetOf(step.wrote))
        if (same) {
          this.write(step.loc, step.prior)
        }
        return
      }
      case 'added': {
        const list = this.read(step.loc)
        if (!Array.isArray(list) || !descends(list, step.produced)) {
          return
        }
        if (list.includes(step.member)) {
          this.write(
            step.loc,
            withMembers(
              list,
              list.filter((member) => member !== step.member),
            ),
          )
        }
        return
      }
      case 'removed': {
        const list = this.read(step.loc)
        const identity = identityOf(step.member)
        if (
          !Array.isArray(list) ||
          identity === undefined ||
          !descends(list, step.produced) ||
          list.some((member) => addresses(member, identity))
        ) {
          return
        }
        const members = [...list]
        members.splice(Math.min(step.index, list.length), 0, step.member)
        this.write(step.loc, withMembers(list, members))
        return
      }
      case 'ordered': {
        const list = this.read(step.loc)
        if (!Array.isArray(list) || !descends(list, step.produced)) {
          return
        }
        const rank = (member: unknown): number => {
          const identity = identityOf(member)
          const at =
            identity === undefined
              ? -1
              : step.order.indexOf(identityKey(identity.type, identity.id))
          return at < 0 ? step.order.length : at
        }
        const members = list
          .map((member, index) => ({ member, index }))
          // oxlint-disable-next-line no-array-sort
          .sort((a, b) => rank(a.member) - rank(b.member) || a.index - b.index)
          .map(({ member }) => member)
        if (members.some((member, index) => member !== list[index])) {
          this.write(step.loc, withMembers(list, members))
        }
        return
      }
    }
  }

  touchedKeys(): readonly QueryKey[] {
    const all = new Map(this.patchedKeys)
    for (const [hash, key] of this.keys) {
      all.set(hash, key)
    }
    return [...all.values()]
  }

  deferred(): readonly DeferredMembers[] {
    const out: DeferredMembers[] = []
    for (const mark of this.marks.values()) {
      for (const [rel, members] of mark.pending) {
        if (members.size > 0) {
          out.push({ type: mark.type, id: mark.id, rel, members: [...members.values()] })
        }
      }
    }
    return out
  }
}

/**
 * Open an {@link OptimisticDraft} over `queryClient`'s cached queries of one scope (unscoped by
 * default), reading their shapes from `descriptor`.
 *
 * ```ts
 * const draft = openDraft(queryClient, descriptor)
 * draft.batch(() => {
 *   draft.patch('albums', '1', { title: 'Kid A' })
 *   draft.attach('playlists', 'p1', 'tracks', [track])
 * })
 * // …on failure
 * draft.rollback()
 * // …once the server has confirmed it
 * draft.commit()
 * ```
 */
export function openDraft<D extends ApiDescriptor, W = unknown>(
  queryClient: QueryClient,
  descriptor: D,
  options: DraftOptions<D> = {},
): OptimisticDraft<D, W> {
  return openDraftHandle(
    queryClient,
    descriptor,
    options as unknown as DraftOptions,
  ) as unknown as OptimisticDraft<D, W>
}

/**
 * An open draft as the mutation lifecycle holds it: every operation, loosely typed, and the
 * lifecycle's own steps.
 * @internal
 */
export type DraftHandle = Draft

/**
 * {@link openDraft}, returning the {@link DraftHandle}.
 * @internal
 */
export function openDraftHandle(
  queryClient: QueryClient,
  descriptor: ApiDescriptor,
  options: DraftOptions = {},
): DraftHandle {
  if (!overlayInstalled) {
    setMaterialisedOverlay(overlay)
    overlayInstalled = true
  }
  return new Draft(queryClient, descriptor, options)
}

/**
 * The steps of an {@link OptimisticDraft} only the mutation lifecycle takes.
 * @internal
 */
export interface DraftLifecycle {
  /**
   * The write succeeded: drop the undo state and the attribute predictions (nothing will roll back),
   * keeping every change and marker until {@link OptimisticDraft.commit}. Stops replaying.
   */
  confirm(): void
  /** The fields (each a `fieldKey`) the draft predicts, whose value the write's response decides. */
  claimedFields(): ReadonlySet<string>
  /**
   * The queries a settle reconciles: those whose membership or relations the draft edited or
   * considered. An attribute prediction alone doesn't count, as the write's response patches it.
   */
  reconcileKeys(): readonly QueryKey[]
  /** Run every operation again on `query`, whose data a read just replaced. */
  reapply(query: Query): void
  /**
   * Rename `type:from` to `type:to` on every cached copy and in every open draft's deferred members
   * and pending creates (a temporary id swapped for the server's).
   */
  swapId(type: string, from: string, to: string): void
  /** Whether the draft shows `type:id` anywhere: a member, a deferred member or a pending create. */
  shows(type: string, id: string): boolean
}

/**
 * Run every open draft's operations again on `query`, whose data a read just replaced, so what the
 * drafts predict keeps showing there while their writes are pending.
 * @internal
 */
export function reapplyDrafts(
  queryClient: QueryClient,
  scope: string | undefined,
  query: Query,
): void {
  for (const draft of openDrafts.get(queryClient) ?? []) {
    if (draft.scope === scope) {
      draft.reapply(query)
    }
  }
}

/**
 * Apply an optimistic attribute patch to one `type:id` across every cached query of the scope, and
 * return the {@link Snapshot} that undoes it. A draft's `patch`, without markers.
 *
 * @internal
 */
export function applyOptimisticPatch(
  queryClient: QueryClient,
  type: string,
  id: string,
  attributes: Record<string, unknown>,
  descriptor: ApiDescriptor,
  scope?: string,
): Snapshot {
  const draft = openDraftHandle(queryClient, descriptor, { scope, markers: false })
  draft.patch(type, id, attributes)
  return {
    restore() {
      draft.rollback()
    },
  }
}
