/**
 * The optimistic draft (design B1, B1a, B1b and B5): one typed transaction over the normalised
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
 * - **Markers.** Every resource a draft touched reports `$optimistic === 'pending'` until the draft
 *   commits or rolls back, and a parent's `$count(rel)` moves by the members added and removed.
 *
 * Publishing: an operation edits the cached objects as it runs, and each query it touched is
 * published (its data set once, under a new root) when the operation returns, or, inside
 * {@link OptimisticDraft.batch}, once when the batch returns. A transaction run as one batch
 * therefore notifies each observer once.
 */
import {
  type ApiDescriptor,
  type CreateInput,
  edgeViewOf,
  type FilterQuery,
  identifierViewOf,
  type MaterialisedOverlay,
  type RelatedQueryParam,
  type RelatedReadRelatedQuery,
  type RelationFilterQuery,
  type RelationName,
  type RelationSortQuery,
  type ResourceIdentifier,
  setMaterialisedOverlay,
  type SortQuery,
  type TypeName,
} from '@haddowg/json-api-client'
import type { Query, QueryClient } from '@tanstack/query-core'
import type { QueryKey } from './keys'
import type { UpdateVariables } from './mutate'
import {
  adoptRecord,
  descends,
  isInfiniteValue,
  partsOf,
  publishData,
  queriesIn,
  type Snapshot,
  targetOf,
  walkResources,
  withMembers,
  writable,
} from './normalize'
import { resolveMember } from './resolve'
import {
  describeQuery,
  isComplete,
  isUnfilteredUnsorted,
  type QueryDescription,
  type QueryParams,
  slotShape,
  viewShape,
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
 */
export interface DraftMember<TType extends string = string> {
  readonly type: TType
  readonly id: string
  readonly $pivot?: Readonly<Record<string, unknown>> | undefined
  readonly [key: string]: unknown
}

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
 * Explicit placement (design B1b): consulted for every candidate view the automatic placement
 * didn't cover, with the view's decoded query `Q` and the member `M` that would enter it. An
 * operation types both: `insert('albums', …)` passes an albums collection read and an albums
 * member, and a relationship verb any {@link DraftQuery} and a member of the relation's types.
 */
export type Into<
  D extends ApiDescriptor = ApiDescriptor,
  Q = DraftQuery<D>,
  M = DraftMember<TypeName<D>>,
> = {
  // Declared as a method so its parameters are bivariant: a typed `into` can be held where any
  // descriptor's is (an option or a plan typed loosely), while an inline one is typed in context.
  into(query: Q, member: M): Placement<M>
}['into']

/** The {@link Into} an operation on relation `R` of type `T` takes. */
export type RelationInto<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = Into<D, DraftQuery<D>, DraftMember<RelatedTypeName<D, T, R>>>

/** The {@link Into} an insert of type `T` takes. */
export type InsertInto<D extends ApiDescriptor, T extends TypeName<D>> = Into<
  D,
  string extends TypeName<D> ? QueryDescription : ListDraftQuery<D, T>,
  DraftMember<T>
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

/** The members a draft deferred for one relation of one parent: placed nowhere they fit yet. */
export interface DeferredMembers {
  readonly type: string
  /** The parent's id, `undefined` for a singleton addressed by type alone. */
  readonly id: string | undefined
  readonly rel: string
  readonly members: readonly ResourceIdentifier[]
}

/**
 * A typed transaction over the normalised cache of one scope of a QueryClient (design B1). Open
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
   * A list whose fieldset or includes the resource doesn't fill is left alone.
   */
  insert<T extends TypeName<D>>(
    type: T,
    resource: CreateInput<D, W, T> & { readonly id: string },
    into?: InsertInto<D, T>,
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
  readonly pending: Map<string, Map<string, ResourceIdentifier>>
  /** The count adjustment per relation. */
  readonly counts: Map<string, number>
}

/** The marks on each materialised resource value (keyed by the value behind any root). */
const resourceMarks = new WeakMap<object, Set<Mark>>()
/** The marks on each to-many array, with the relation each counts. */
const arrayMarks = new WeakMap<object, Map<Mark, string>>()

const NONE: readonly ResourceIdentifier[] = Object.freeze([])

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
  pending: (targets, name) => {
    const found = new Map<string, ResourceIdentifier>()
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

/** Where a member list or a to-one value lives: a query's data (or one page), or a node's slot. */
type Loc =
  | { readonly kind: 'top'; readonly query: Query; readonly page: number | undefined }
  | {
      readonly kind: 'slot'
      readonly query: Query
      readonly node: Record<string, unknown>
      readonly rel: string
    }

/** One inverse operation, replayed by a rollback. */
type Undo =
  | {
      readonly kind: 'attribute'
      readonly query: Query
      readonly node: Record<string, unknown>
      readonly key: string
      readonly had: boolean
      readonly prior: unknown
      readonly wrote: unknown
    }
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
}

const keyOf = (type: string, id: string | undefined): string => `${type}:${id ?? ''}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The `{ type, id }` a value carries, when both are strings. */
function identityOf(value: unknown): { type: string; id: string } | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const { type, id } = value
  return typeof type === 'string' && typeof id === 'string' ? { type, id } : undefined
}

const addresses = (value: unknown, ref: { type: string; id: string }): boolean => {
  const identity = identityOf(value)
  return identity !== undefined && identity.type === ref.type && identity.id === ref.id
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

const toRefs = (values: readonly unknown[]): Ref[] =>
  values.map(toRef).filter((ref): ref is Ref => ref !== undefined)

/** Whether a member list shows the first page: no `prev` link on its `$page`. */
function firstPage(list: unknown): boolean {
  const page = (list as { $page?: { links?: { prev?: unknown } } } | undefined)?.$page
  return typeof page?.links?.prev !== 'string'
}

/**
 * Whether a parent's relation slot is links-only: nothing is known of its membership. A to-one is
 * `undefined`; a to-many the response sent no linkage for still materialises as an empty array,
 * which its `$rel()` tells apart.
 */
function linksOnly(node: Record<string, unknown>, rel: string, slot: unknown): boolean {
  if (slot === undefined) {
    return true
  }
  if (!Array.isArray(slot)) {
    return false
  }
  const $rel = node['$rel']
  if (typeof $rel !== 'function') {
    return false
  }
  const view = ($rel as (name: string) => unknown).call(node, rel)
  return isRecord(view) && !('data' in view)
}

// ── The draft ──────────────────────────────────────────────────────────────────────────────

class Draft {
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
  private readonly keys = new Map<string, QueryKey>()

  constructor(
    private readonly queryClient: QueryClient,
    private readonly descriptor: ApiDescriptor,
    options: DraftOptions,
  ) {
    this.scope = options.scope
    this.autoPlace = options.autoPlace !== false
    this.into = options.into
    this.markers = options.markers !== false
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

  /** Publish every query staged since the last flush, once each. */
  private flush(): void {
    const staged = [...this.staged]
    this.staged.clear()
    for (const [query, { data, nodes }] of staged) {
      const changed = new Set<object>()
      if (nodes.size > 0) {
        for (const part of partsOf(data)) {
          if (typeof part !== 'object' || part === null) {
            continue
          }
          let holds = false
          walkResources(part, this.descriptor, (node) => {
            holds ||= nodes.has(targetOf(node))
          })
          if (holds) {
            changed.add(targetOf(part))
          }
        }
      }
      publishData(query, data, changed)
    }
  }

  private stage(query: Query): Staged {
    let entry = this.staged.get(query)
    if (entry === undefined) {
      entry = { data: query.state.data, nodes: new Set() }
      this.staged.set(query, entry)
    }
    this.keys.set(query.queryHash, query.queryKey as QueryKey)
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
    const data = this.current(loc.query)
    if (loc.page === undefined) {
      return data
    }
    return isInfiniteValue(data) ? data.pages[loc.page] : undefined
  }

  private write(loc: Loc, value: unknown): void {
    if (loc.kind === 'slot') {
      loc.node[loc.rel] = value
      this.stage(loc.query).nodes.add(targetOf(loc.node))
      return
    }
    const entry = this.stage(loc.query)
    if (loc.page === undefined) {
      entry.data = value
      return
    }
    const data = entry.data
    if (!isInfiniteValue(data)) {
      return
    }
    const pages = [...data.pages]
    pages[loc.page] = value
    entry.data = { ...data, pages }
  }

  /** The cached queries of the scope this draft can read, with their descriptions. */
  private candidates(): Candidate[] {
    const out: Candidate[] = []
    for (const query of queriesIn(this.queryClient, this.scope)) {
      const description = describeQuery(query, this.descriptor)
      // A to-one read may hold `null`; a query that holds nothing yet has nothing to edit.
      if (description !== undefined && !description.skipped && this.current(query) !== undefined) {
        out.push({ query, description })
      }
    }
    return out
  }

  /** Visit every resource in a candidate's data with the shape of the slot it sits in. */
  private walk(
    candidate: Candidate,
    visit: (node: Record<string, unknown>, shape: ViewShape | undefined) => void,
  ): void {
    const shape = viewShape(candidate.description, this.descriptor)
    const seen = new Set<object>()
    for (const part of partsOf(this.current(candidate.query))) {
      walkShaped(part, shape, this.descriptor, visit, seen)
    }
  }

  private matchesId(id: string | undefined, candidate: string | undefined): boolean {
    return id === undefined || candidate === undefined || id === candidate
  }

  // ── Markers ──

  private markFor(type: string, id: string | undefined): Mark {
    const key = keyOf(type, id)
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
    for (const candidate of this.candidates()) {
      this.walk(candidate, (node) => {
        if (node['type'] !== type || !this.matchesId(id, node['id'] as string | undefined)) {
          return
        }
        this.register(candidate.query, node, mark)
        const slot = rel === undefined ? undefined : node[rel]
        if (rel !== undefined && Array.isArray(slot)) {
          this.register(candidate.query, slot, mark, rel)
        }
        this.stage(candidate.query).nodes.add(targetOf(node))
      })
    }
  }

  private defer(type: string, id: string | undefined, rel: string, ref: Ref): void {
    const mark = this.markFor(type, id)
    const members = mark.pending.get(rel) ?? new Map<string, ResourceIdentifier>()
    members.set(keyOf(ref.type, ref.id), { type: ref.type, id: ref.id })
    mark.pending.set(rel, members)
  }

  private adjustCount(type: string, id: string | undefined, rel: string, delta: number): void {
    if (delta === 0) {
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
        this.stage(query).nodes.add(value)
      }
    }
    this.registered.length = 0
    this.marks.clear()
  }

  // ── Members ──

  /**
   * The value `ref` enters a destination of `shape` as: an identifier view, or a per-edge view of
   * the copy that fits (the caller's, else the richest cached), keeping only the members the shape
   * selects; `undefined` when no copy fits.
   */
  private memberFor(ref: Ref, shape: ViewShape): object | undefined {
    const meta = ref.pivot === undefined ? undefined : { pivot: { ...ref.pivot } }
    const edge = { type: ref.type, id: ref.id, ...(meta === undefined ? {} : { meta }) }
    if (shape.kind === 'identifiers') {
      return identifierViewOf(edge)
    }
    const found = resolveMember(this.queryClient, ref.type, ref.id, shape, this.descriptor, {
      scope: this.scope,
      candidates: [ref.source],
    })
    if (typeof found !== 'object' || found === null) {
      return undefined
    }
    const attributes = shape.attributes.get(ref.type)
    const relations = shape.rendered.get(ref.type)
    const view = edgeViewOf(
      found,
      edge,
      (key) => attributes?.has(key) === true || relations?.has(key) === true,
    )
    adoptRecord(view, found)
    return view
  }

  /** What {@link Into} sees of `ref` entering a destination of `shape`. */
  private preview(ref: Ref, shape: ViewShape): { member: DraftMember; value: object | undefined } {
    const value = this.memberFor(ref, shape)
    const member = (value ??
      (isRecord(ref.source)
        ? ref.source
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
        const shape = viewShape(description, this.descriptor)
        if (cardinality === 'many' && (isInfiniteValue(data) || Array.isArray(data))) {
          const locs: Loc[] = isInfiniteValue(data)
            ? data.pages.map((_, page) => ({ kind: 'top', query, page }))
            : [{ kind: 'top', query, page: undefined }]
          many.push({
            query,
            description,
            locs,
            shape,
            auto: isUnfilteredUnsorted(description) && isComplete(data),
          })
        } else if (cardinality === 'one' && !Array.isArray(data) && !isInfiniteValue(data)) {
          one.push({ query, description, loc: { kind: 'top', query, page: undefined }, shape })
        }
        continue
      }
      // The relation's slot on every cached copy of the parent.
      this.walk(candidate, (node, at) => {
        if (node['type'] !== type || !this.matchesId(id, node['id'] as string | undefined)) {
          return
        }
        this.consider(query)
        const slot = node[rel]
        if (linksOnly(node, rel, slot)) {
          return
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
      })
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
  private insertAt(view: ManyView, at: { list: number; index: number }, member: object): void {
    const loc = view.locs[at.list]!
    const list = this.read(loc)
    if (!Array.isArray(list)) {
      return
    }
    const members = [...list]
    members.splice(at.index, 0, member)
    const produced = withMembers(list, members)
    this.write(loc, produced)
    this.undo.push({ kind: 'added', loc, produced, member })
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
    this.run(() => {
      const resource = this.descriptor[type]
      if (resource === undefined || !isRecord(change)) {
        return
      }
      const attributes = Object.entries(change).filter(([key]) => key in resource.attributes)
      if (attributes.length > 0) {
        const mark = this.markFor(type, id)
        for (const candidate of this.candidates()) {
          this.walk(candidate, (node, shape) => {
            if (node['type'] !== type || !this.matchesId(id, node['id'] as string | undefined)) {
              return
            }
            let touched = false
            for (const [key, value] of attributes) {
              if (!writable(node, key, shape)) {
                continue
              }
              touched = true
              const had = Object.hasOwn(node, key)
              const prior = node[key]
              if (had && prior === value) {
                continue
              }
              node[key] = value
              this.undo.push({
                kind: 'attribute',
                query: candidate.query,
                node,
                key,
                had,
                prior,
                wrote: value,
              })
            }
            if (touched) {
              this.consider(candidate.query)
              this.stage(candidate.query).nodes.add(targetOf(node))
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
    })
  }

  link(
    type: string,
    id: string | undefined,
    rel: string,
    ref: DraftRef | null,
    options: PlaceOptions = {},
  ): void {
    this.run(() => {
      const next = ref === null ? null : toRef(ref)
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
    this.run(() => {
      const options = typeof at === 'string' ? { at } : at
      const added = toRefs(refs)
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
    this.run(() => {
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
    this.run(() => {
      const next = toRefs(refs)
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
        return identity === undefined ? [] : [keyOf(identity.type, identity.id)]
      }),
    })
    for (const member of added) {
      this.undo.push({ kind: 'added', loc, produced, member })
    }
  }

  /** The count a cached copy of the parent reports for `rel`, when one carries a count. */
  private countOf(type: string, id: string | undefined, rel: string): number | undefined {
    let count: number | undefined
    for (const candidate of this.candidates()) {
      this.walk(candidate, (node) => {
        if (
          count !== undefined ||
          node['type'] !== type ||
          !this.matchesId(id, node['id'] as string | undefined)
        ) {
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

  insert(type: string, resource: unknown, into?: Into): void {
    this.run(() => {
      const ref = toRef(isRecord(resource) ? { ...resource, type } : undefined)
      const place = into ?? this.into
      if (ref === undefined) {
        return
      }
      for (const candidate of this.candidates()) {
        const { query, description } = candidate
        if (description.operation !== 'fetchMany' || description.type !== type) {
          continue
        }
        this.consider(query)
        if (place === undefined) {
          continue
        }
        const data = this.current(query)
        const shape = viewShape(description, this.descriptor)
        const view: ManyView = {
          query,
          description,
          locs: isInfiniteValue(data)
            ? data.pages.map((_, page) => ({ kind: 'top', query, page }))
            : [{ kind: 'top', query, page: undefined }],
          shape,
          auto: false,
        }
        if (this.holds(view, ref)) {
          continue
        }
        const { member, value } = this.preview(ref, shape)
        const position = this.position(view, place(description as DraftQuery, member))
        if (position === undefined || value === undefined) {
          continue
        }
        this.insertAt(view, position, value)
        this.register(query, value, this.markFor(type, ref.id))
      }
    })
  }

  evict(type: string, id: string): void {
    this.run(() => {
      const evicted = { type, id }
      const parents = new Map<string, { type: string; id: string | undefined; rel: string }>()
      for (const candidate of this.candidates()) {
        const { query, description } = candidate
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
        if (description.collection && (Array.isArray(data) || isInfiniteValue(data))) {
          const locs: Loc[] = isInfiniteValue(data)
            ? data.pages.map((_, page) => ({ kind: 'top', query, page }))
            : [{ kind: 'top', query, page: undefined }]
          if (this.removeFrom(locs, [evicted]) > 0) {
            held = true
            if (description.rel !== undefined) {
              const key = `${keyOf(description.type, description.id)}:${description.rel}`
              parents.set(key, { type: description.type, id: description.id, rel: description.rel })
            }
          }
        } else if (description.rel !== undefined && addresses(data, evicted)) {
          const loc: Loc = { kind: 'top', query, page: undefined }
          this.write(loc, null)
          this.undo.push({ kind: 'linked', loc, prior: data, wrote: null })
          held = true
        }
        // Every relation slot holding it, on every resource the query holds.
        const slots: { node: Record<string, unknown>; rel: string }[] = []
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
        for (const { node, rel } of slots) {
          const loc: Loc = { kind: 'slot', query, node, rel }
          const slot = node[rel]
          if (Array.isArray(slot)) {
            this.removeFrom([loc], [evicted])
            const parentId = node['id'] as string
            const key = `${keyOf(node['type'] as string, parentId)}:${rel}`
            parents.set(key, { type: node['type'] as string, id: parentId, rel })
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
    for (const candidate of this.candidates()) {
      this.walk(candidate, (node) => {
        if (node['type'] !== type || node['id'] !== id) {
          return
        }
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
    this.run(() => {
      for (let step = this.undo.length - 1; step >= 0; step--) {
        this.revert(this.undo[step]!)
      }
      this.undo.length = 0
      this.clearMarks()
    })
    this.closed = true
  }

  commit(): void {
    if (this.closed) {
      return
    }
    this.run(() => {
      this.undo.length = 0
      this.clearMarks()
    })
    this.closed = true
  }

  /** Replay one inverse operation, compare-and-swap. */
  private revert(step: Undo): void {
    switch (step.kind) {
      case 'attribute': {
        if (step.node[step.key] !== step.wrote) {
          return
        }
        if (step.had) {
          step.node[step.key] = step.prior
        } else {
          delete step.node[step.key]
        }
        this.stage(step.query).nodes.add(targetOf(step.node))
        return
      }
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
            identity === undefined ? -1 : step.order.indexOf(keyOf(identity.type, identity.id))
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
    return [...this.keys.values()]
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
  if (!overlayInstalled) {
    setMaterialisedOverlay(overlay)
    overlayInstalled = true
  }
  return new Draft(
    queryClient,
    descriptor,
    options as unknown as DraftOptions,
  ) as unknown as OptimisticDraft<D, W>
}

/**
 * Apply an optimistic attribute patch to one `type:id` across every cached query of the scope, and
 * return the {@link Snapshot} that undoes it. A draft's `patch`, without markers.
 */
export function applyOptimisticPatch(
  queryClient: QueryClient,
  type: string,
  id: string,
  attributes: Record<string, unknown>,
  descriptor: ApiDescriptor,
  scope?: string,
): Snapshot {
  const draft = openDraft(queryClient, descriptor, { scope, markers: false })
  draft.patch(type, id, attributes as never)
  return {
    restore() {
      draft.rollback()
    },
  }
}
