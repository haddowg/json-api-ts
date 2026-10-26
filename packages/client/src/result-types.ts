/**
 * The client TYPE layer (Build 3): the static types a materialised read resolves to,
 * driven by the generated descriptor `D` (cardinality/related-type/pivot) and the
 * generated `Attributes` map `A` (the precise per-type attribute interfaces). The
 * runtime that produces these values lives in materialise.ts; this file is the
 * compile-time projection of that runtime onto descriptor + attribute types.
 *
 * Naming mirrors the runtime `$`-accessors (ADR 0002 / CONTEXT.md): the data is
 * flattened as own enumerable props (`type`, `id`, attributes, relations) and the
 * envelope rides non-enumerable `$`-accessors.
 */
import type {
  AtomicCreateHandle,
  AtomicDeleteHandle,
  AtomicHandle,
  AtomicRecorder,
  AtomicResult,
  AtomicResults,
  AtomicUpdateHandle,
} from './atomic'
import type { ActionDescriptor, ApiDescriptor, InputMedia, RawOutputMedia } from './descriptor'
import type {
  ArrayEnvelope,
  DocumentEnvelope,
  Edge,
  NavigateOptions,
  RelationView,
  ResourceLinks,
} from './materialise'
import type { ExactPageParams, Page, PageOf, PageParams } from './pagination'
import type { LocalIdentifier, ResourceIdentifier } from './types'

/**
 * An augmented array (CONTEXT.md "To-many relationship values are augmented arrays"):
 * a real, read-only `T[]` carrying the non-enumerable relationship-level envelope
 * (`$page`/`$links`/`$meta`) plus link-driven `$next()`/`$prev()` navigation. The same
 * model backs top-level collections, related-endpoint collections, and hydrated/linkage
 * to-many relationship values ("one model, three surfaces"). `P` types `$page` by the strategy
 * that answered (see {@link PageOf}); following a link keeps it.
 */
export type Collection<T, P = Page> = ReadonlyArray<T> &
  Omit<ArrayEnvelope, '$page' | '$next' | '$prev'> & {
    readonly $page: P
    $next(options?: NavigateOptions): Promise<Collection<T, P> | undefined>
    $prev(options?: NavigateOptions): Promise<Collection<T, P> | undefined>
  }

/**
 * The edge-local accessors carried by a materialised related VALUE (a per-edge view):
 * `$edge` (this membership's edge meta/links) and `$pivot` (typed sugar over
 * `$edge.meta.pivot`). `$pivot` is graceful: present iff the endpoint rendered
 * `meta.pivot` (relationship/related endpoints), `undefined` otherwise.
 */
export interface EdgeMembers<Pivot = Record<string, unknown>> {
  readonly $edge: Edge | undefined
  readonly $pivot: Pivot | undefined
}

/** The resource-level `$`-accessors on a materialised resource object. */
export interface ResourceAccessors {
  readonly $meta: Record<string, unknown> | undefined
  readonly $links: ResourceLinks | undefined
  readonly $self: string | undefined
  readonly $document: DocumentEnvelope
  readonly $raw: Record<string, unknown>
  $rel(name: string): RelationView | undefined
}

/** Every wire type declared by the descriptor `D`. */
export type TypeName<D extends ApiDescriptor> = Extract<keyof D, string>

/** The relation names declared on type `T` of descriptor `D`. */
export type RelationName<D extends ApiDescriptor, T extends TypeName<D>> = Extract<
  keyof D[T]['relations'],
  string
>

/** The relations of type `T` a response never renders (the descriptor's `writeOnly: true`). */
type WriteOnlyRelationName<D extends ApiDescriptor, T extends TypeName<D>> = {
  [R in RelationName<D, T>]: D[T]['relations'][R] extends { writeOnly: true } ? R : never
}[RelationName<D, T>]

/** The relations of type `T` a response can render: every relation but the write-only ones. */
export type ReadableRelationName<D extends ApiDescriptor, T extends TypeName<D>> = Exclude<
  RelationName<D, T>,
  WriteOnlyRelationName<D, T>
>

/** The attribute object for type `T`, from the generated attributes map `A` (falls back to `{}`). */
type AttributesOf<A, T> = T extends keyof A ? A[T] : Record<string, never>

/**
 * A sparse-fieldset selection map: wire type -> the member names (`fields[type]`) a read
 * requested for that type. Threaded through {@link ResourceObjectView} so an unrequested
 * attribute/relation is statically ABSENT, matching the runtime (the server only emits the
 * requested members). The default `unknown` means "no fieldset narrowing" — every member is
 * present, as it was before.
 */
export type FieldSelectionMap = Readonly<Record<string, readonly string[]>>

/**
 * The selected member names for type `T` from a fieldset map `F`, or the {@link AllFields}
 * sentinel when `F` declares no entry for `T` (so that type's members are all present). The
 * `unknown` map (no `fields` query at all) also resolves to {@link AllFields}. A member of `F`
 * keyed `T` whose value is `readonly string[]` selects exactly those names.
 */
type AllFields = { readonly __allFields: unique symbol }

/** Resolve the selected member-name union for type `T` from fieldset map `F` (or {@link AllFields}). */
type SelectedFields<F, T extends string> = F extends FieldSelectionMap
  ? T extends keyof F
    ? F[T][number]
    : AllFields
  : AllFields

/**
 * Pick only the members of `Obj` selected by `Sel` (a member-name union, or {@link AllFields}
 * to keep them all). When narrowing, a key absent from `Sel` is dropped, so the resulting
 * object's keys are exactly the requested members — the static mirror of a sparse fieldset.
 */
type PickSelected<Obj, Sel> = [Sel] extends [AllFields] ? Obj : Pick<Obj, Extract<keyof Obj, Sel>>

/**
 * The related wire type(s) of relation `R` on type `T`. A union when polymorphic; the
 * member is narrowed to types that actually exist in the descriptor so the hydrated
 * shape composes.
 */
type RelatedType<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = Extract<D[T]['relations'][R]['types'][number], TypeName<D>>

/** True when relation `R` of type `T` is to-many. */
type IsMany<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = D[T]['relations'][R]['cardinality'] extends 'many' ? true : false

/**
 * The paginator relation `R`'s related/relationship endpoints use: the relation's own when it
 * diverges (D6a), else its first related type's collection paginator (as the runtime resolves).
 */
export type RelationPaginator<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = D[T]['relations'][R] extends { paginator: infer P }
  ? P
  : D[T]['relations'][R]['types'][0] extends infer First extends TypeName<D>
    ? D[First]['paginator']
    : 'none'

/** The `$page` of relation `R`'s to-many value read with page argument `Q` (none = the default). */
type RelationPage<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
  Q = undefined,
> = PageOf<RelationPaginator<D, T, R>, Q>

/**
 * The bare resource-identifier shape a non-included (but linked) relation takes,
 * carrying the per-edge `$edge`/`$pivot` accessors the runtime attaches to every
 * materialised related value.
 */
export type IdentifierMember<
  TType extends string,
  Pivot = Record<string, unknown>,
> = ResourceIdentifier<TType> & EdgeMembers<Pivot>

/**
 * A hydrated related resource: a per-edge VIEW — the full `ResourceObjectView` of the
 * related node plus this membership's `$edge`/`$pivot`. Relations one hop deep stay as
 * identifiers (no nested-include narrowing in the read API today). The fieldset map `F`
 * threads through so a sparse fieldset on the included type narrows its attributes/relations.
 * `Pivot` types the per-edge `$pivot` (a `belongsToMany` relation's `meta.pivot`).
 */
export type HydratedMember<
  D extends ApiDescriptor,
  A,
  TType extends TypeName<D>,
  F = unknown,
  Pivot = Record<string, unknown>,
> = ResourceObjectView<D, A, TType, never, F> & EdgeMembers<Pivot>

/** A hydrated related value distributes over a polymorphic union of related types. */
type Hydrated<
  D extends ApiDescriptor,
  A,
  TType extends TypeName<D>,
  F = unknown,
  Pivot = Record<string, unknown>,
> = TType extends TypeName<D> ? HydratedMember<D, A, TType, F, Pivot> : never

/** An identifier related value distributes over a polymorphic union of related types. */
type Identifier<TType extends string, Pivot = Record<string, unknown>> = TType extends string
  ? IdentifierMember<TType, Pivot>
  : never

/**
 * The static value of one relation slot, resolved by cardinality and whether the
 * relation name is present in the read's `include` tuple `Inc`:
 *
 * - to-one, included  -> the hydrated related resource, or `null` (an empty to-one with
 *   `data: null` materialises to `null` even when included);
 * - to-one, excluded  -> `Identifier | null | undefined` (absent/links-only/empty are valid);
 * - to-many, included -> a `Collection` of hydrated members;
 * - to-many, excluded -> a `Collection` of identifier members.
 *
 * (Excluded to-many stays a `Collection`: linkage may still be present, and a lazy
 * to-many materialises as an augmented array regardless — only its members differ.)
 */
type RelationValue<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
  Inc,
  F = unknown,
> = R extends Inc
  ? IsMany<D, T, R> extends true
    ? Collection<Hydrated<D, A, RelatedType<D, T, R>, F>, RelationPage<D, T, R>>
    : Hydrated<D, A, RelatedType<D, T, R>, F> | null
  : IsMany<D, T, R> extends true
    ? Collection<Identifier<RelatedType<D, T, R>>, RelationPage<D, T, R>>
    : Identifier<RelatedType<D, T, R>> | null | undefined

/**
 * The relation slots of type `T`, each typed by cardinality and include-presence, then
 * narrowed to the fieldset selection for `T` (relations are sparse-fieldset members too — an
 * unrequested relation is statically absent). A write-only relation has no slot.
 */
type Relations<D extends ApiDescriptor, A, T extends TypeName<D>, Inc, F = unknown> = PickSelected<
  {
    [R in ReadableRelationName<D, T>]: RelationValue<D, A, T, R, Inc, F>
  },
  SelectedFields<F, T>
>

/**
 * A materialised resource object: flattened `type` + `id` + attributes + relation slots
 * as own enumerable props, intersected with the resource-level `$`-accessors. `Inc` is
 * the union of relation names included by the read (narrows relations to hydrated); `F` is
 * the sparse-fieldset selection map (narrows attributes/relations to the requested members —
 * `type`/`id`/the `$`-accessors are always present). The default `F = unknown` keeps every
 * member (no fieldset narrowing).
 */
export type ResourceObjectView<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  Inc = never,
  F = unknown,
> = {
  type: T
  id: string
} & PickSelected<AttributesOf<A, T>, SelectedFields<F, T>> &
  Relations<D, A, T, Inc, F> &
  ResourceAccessors

/**
 * The element type of the `include` array for type `T`: a path from the descriptor's
 * `includable` enum — the exact set the server advertises, including nested dotted paths
 * (`tracks.album`). `never` when the type advertises nothing includable (so `include` is a
 * compile error, matching the server's `400 INCLUSION_NOT_ALLOWED`). Only the top-level
 * relation of each path drives return-type narrowing (see {@link IncludedRelations}).
 */
export type IncludePath<D extends ApiDescriptor, T extends TypeName<D>> = D[T] extends {
  includable: infer I
}
  ? I extends readonly (infer P)[]
    ? P & string
    : never
  : never

/**
 * The union of top-level relation names present in an `include` tuple (drops dotted children).
 * Mapped element-wise over the tuple (`{ [K in keyof Inc]: ... }[number]`) rather than
 * distributed over `Inc[number]` — a distributive template-literal `infer` collapses the union to
 * a single head when the tuple mixes dotted and plain paths (e.g. `['artist', 'tracks.album']`
 * would drop `tracks`), silently leaving an included relation un-hydrated.
 */
export type IncludedRelations<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[],
> = Extract<
  { [K in keyof Inc]: Inc[K] extends `${infer Head}.${string}` ? Head : Inc[K] }[number],
  RelationName<D, T>
>

/**
 * The `withCount` count tokens type `T` accepts (its `countable.tokens` literal union), or
 * `never` when the type advertises no Countable profile (`withCount` is then unusable). `_self_`
 * counts the collection; a relation name counts that relation per item.
 */
export type CountToken<D extends ApiDescriptor, T extends TypeName<D>> = D[T] extends {
  countable: { tokens: infer Tokens }
}
  ? Tokens extends readonly (infer Token)[]
    ? Token & string
    : never
  : never

/**
 * A sort token type `T`'s COLLECTION read accepts (its `sortable` literal union — signed
 * field names like `title`/`-title`), or `never` when the collection advertises no sorting.
 */
export type SortToken<D extends ApiDescriptor, T extends TypeName<D>> = D[T] extends {
  sortable: infer S
}
  ? S extends readonly (infer Token)[]
    ? Token & string
    : never
  : never

/**
 * A filter key type `T`'s COLLECTION read accepts (its `filterable` literal union), or `never`
 * when the collection advertises no filters.
 */
export type FilterKey<D extends ApiDescriptor, T extends TypeName<D>> = D[T] extends {
  filterable: infer Fl
}
  ? Fl extends readonly (infer Key)[]
    ? Key & string
    : never
  : never

/**
 * The `sort` value for type `T`: one of the advertised tokens or a tuple of them. `never`
 * (so `sort` cannot be supplied at all) when the collection advertises no sorting — a
 * compile-time mirror of the server's `400 SORTING_UNSUPPORTED`.
 */
export type SortQuery<D extends ApiDescriptor, T extends TypeName<D>> = [SortToken<D, T>] extends [
  never,
]
  ? never
  : SortToken<D, T> | readonly SortToken<D, T>[]

/**
 * The `filter` object for type `T`: keys constrained to the advertised filter params (values
 * stay `unknown` — value shapes/operators vary). `never` (so `filter` cannot be supplied) when
 * the collection advertises no filters — a compile-time mirror of `400 FILTERING_UNRECOGNIZED`.
 */
export type FilterQuery<D extends ApiDescriptor, T extends TypeName<D>> = [
  FilterKey<D, T>,
] extends [never]
  ? never
  : Partial<Record<FilterKey<D, T>, unknown>>

/**
 * The element type of the `fields` map for a typed read: a member-name array per wire type,
 * each name constrained to that type's declared attributes/relations. Capturing the literal
 * names (a `const` tuple) drives the sparse-fieldset return-type narrowing.
 */
export type FieldsMap<D extends ApiDescriptor> = {
  [T in TypeName<D>]?: readonly MemberName<D, T>[]
}

/**
 * A selectable sparse-fieldset member of type `T`: an attribute name (the descriptor's
 * `attributes` keys) or a relation a response renders. The descriptor carries the literal member
 * names, so `fields` entries are constrained to real members.
 */
export type MemberName<D extends ApiDescriptor, T extends TypeName<D>> =
  | Extract<keyof D[T]['attributes'], string>
  | ReadableRelationName<D, T>

/** The `page` argument a collection read of type `T` accepts (see {@link PageParams}). */
export type ListPageParams<D extends ApiDescriptor, T extends TypeName<D>> = PageParams<
  D[T]['paginator']
>

/**
 * A read query carrying a typed, narrowing `include`, a typed `fields` (drives sparse-fieldset
 * return narrowing), a `withCount` constrained to the type's count tokens, a `page` typed by the
 * collection's paginator (`Pg` drives the `$page` type), plus the loose JSON:API query families. `Inc`/`F` are inferred (as `const`) at the call site. Used for the
 * COLLECTION read (`list`); the single-resource read (`get`) uses {@link SingleReadQuery}, which
 * drops `withCount` (no `GET /{type}/{id}` endpoint advertises it).
 */
export interface TypedReadQuery<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[],
  F extends FieldsMap<D> = FieldsMap<D>,
  Pg extends ListPageParams<D, T> | undefined = ListPageParams<D, T> | undefined,
> {
  /** The relations to include — drives static narrowing; constrained to the advertised paths. */
  include?: Inc
  /** Filter the collection — keys constrained to the type's advertised `filter[...]` params. */
  filter?: FilterQuery<D, T>
  /** Sort the collection — constrained to the type's advertised (signed) sort tokens. */
  sort?: SortQuery<D, T>
  /** Sparse fieldsets per type — drives return-type narrowing (unrequested members are absent). */
  fields?: F
  /** Relationship-count tokens (the Countable profile) — comma-joined onto `withCount`. */
  withCount?: readonly CountToken<D, T>[]
  /**
   * The page to read, under the paginator's wire keys. On a menu, `kind` picks a strategy;
   * without it the server answers with its default.
   */
  page?: ExactPageParams<Pg, ListPageParams<D, T>>
  /** Cancels the read when signalled (e.g. a superseded request). Not sent to the server. */
  signal?: AbortSignal
}

/**
 * A single-resource read query (`GET /{type}/{id}`): only `include` and sparse `fields`. A
 * single-resource endpoint advertises neither `sort`/`filter`/`page` (no collection to order,
 * filter or page) nor `withCount` — accepting any of them would be a lying type (the server
 * rejects an unrecognised parameter with `400` under strict query-param validation).
 */
export interface SingleReadQuery<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[],
  F extends FieldsMap<D> = FieldsMap<D>,
> {
  /** The relations to include — drives static narrowing; constrained to the advertised paths. */
  include?: Inc
  /** Sparse fieldsets per type — drives return-type narrowing (unrequested members are absent). */
  fields?: F
  /** Cancels the read when signalled (e.g. a superseded request). Not sent to the server. */
  signal?: AbortSignal
}

/**
 * The static return type of a read on type `T` given its `include` tuple and `fields` selection
 * `F` — the resource object with the named relations narrowed to hydrated and its members
 * narrowed to the requested sparse fieldset.
 */
export type ReadResult<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[] = [],
  F = unknown,
> = ResourceObjectView<D, A, T, IncludedRelations<D, T, Inc>, F>

/**
 * A read query for the relationship/related endpoints: loose filter/sort/include/fields/withCount,
 * and a `page` of type `Pg` (typed from the relation's paginator on a typed accessor).
 */
export interface RelationReadQuery<Pg = Readonly<Record<string, unknown>>> {
  filter?: Record<string, unknown>
  sort?: string | readonly string[]
  include?: readonly string[]
  fields?: Record<string, readonly string[]>
  page?: Pg
  /**
   * Relationship-count tokens (`_self_` + the relation's countable relations) — the related/
   * relationship endpoints advertise their own `withCount`, and the client negotiates the
   * relation's Countable profile so a strict server accepts it (D3).
   */
  withCount?: readonly string[]
  /** Cancels the read when signalled (e.g. a superseded request). Not sent to the server. */
  signal?: AbortSignal
}

/** The TS type a descriptor wire-format hint maps to (mirrors the runtime coercion vocabulary). */
type FormatToTs<H> = H extends 'number' | 'integer'
  ? number
  : H extends 'boolean'
    ? boolean
    : H extends 'object'
      ? Record<string, unknown>
      : H extends 'array'
        ? readonly unknown[]
        : H extends 'unknown'
          ? unknown
          : string

/** The string members of a descriptor list, or `never` when it is absent. */
type ListMember<L> = L extends readonly (infer M)[] ? M & string : never

/** The fields of a {@link PivotDescriptor} every member carries (all of them when `required` is absent). */
type RequiredPivotField<P> = P extends { fields: infer Fl }
  ? P extends { required: infer Req }
    ? Extract<keyof Fl, ListMember<Req>>
    : keyof Fl
  : never

/** One pivot field's TS type: its format hint's type, plus `null` when the field is nullable. */
type PivotValue<P, K> = P extends { fields: infer Fl }
  ? K extends keyof Fl
    ?
        | FormatToTs<Fl[K]>
        | (K extends ListMember<P extends { nullable: infer N } ? N : never> ? null : never)
    : never
  : never

/** The fields of a {@link PivotDescriptor}. */
type PivotFieldNames<P> = P extends { fields: infer Fl } ? keyof Fl : never

/** The `meta.pivot` object a {@link PivotDescriptor} describes. */
type PivotObject<P> = {
  readonly [K in PivotFieldNames<P> as K extends RequiredPivotField<P> ? K : never]: PivotValue<
    P,
    K
  >
} & {
  readonly [K in PivotFieldNames<P> as K extends RequiredPivotField<P> ? never : K]?: PivotValue<
    P,
    K
  >
}

/** The legacy hint-only pivot shape: every field present and non-null. */
type LegacyPivot<P> = { readonly [K in keyof P]: FormatToTs<P[K]> }

/**
 * The typed `meta.pivot` a response renders on each member of relation `R`, from the descriptor's
 * `readPivot`, e.g. `{ position: number; weight: number | null; addedAt: string }`. A descriptor
 * with only `pivotFields` types every field present and non-null; one with neither falls back to
 * a loose record (D33).
 */
type PivotFieldsOf<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = D[T]['relations'][R] extends { readPivot: infer P }
  ? PivotObject<P>
  : D[T]['relations'][R] extends { pivotFields: infer P }
    ? LegacyPivot<P>
    : Record<string, unknown>

/**
 * The typed `meta.pivot` a request may send on each member of relation `R`, from the descriptor's
 * `writePivot` (only writable fields, optional unless required). Falls back like
 * {@link PivotFieldsOf} when the descriptor has no `writePivot`.
 */
type WritePivotOf<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = D[T]['relations'][R] extends { writePivot: infer P }
  ? PivotObject<P>
  : D[T]['relations'][R] extends { pivotFields: infer P }
    ? LegacyPivot<P>
    : PivotInput

/**
 * A hydrated related VALUE for relation `R` of type `T`, resolved by cardinality over the
 * (possibly polymorphic) related type(s): a `Collection` of hydrated members for to-many,
 * the hydrated member (or `null`) for to-one. Each member's `$pivot` is typed from the
 * relation's `readPivot` (D33).
 */
type RelatedValue<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
  Q = undefined,
> =
  IsMany<D, T, R> extends true
    ? Collection<
        Hydrated<D, A, RelatedType<D, T, R>, unknown, PivotFieldsOf<D, T, R>>,
        RelationPage<D, T, R, Q>
      >
    : Hydrated<D, A, RelatedType<D, T, R>, unknown, PivotFieldsOf<D, T, R>> | null

/**
 * A linkage VALUE for relation `R` (the `/relationships/{rel}` endpoint, identifiers only):
 * a `Collection` of identifier members for to-many, a single identifier (or `null`) for to-one.
 * Each member's `$pivot` is typed from the relation's `readPivot` (D33).
 */
type LinkageValue<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
  Q = undefined,
> =
  IsMany<D, T, R> extends true
    ? Collection<Identifier<RelatedType<D, T, R>, PivotFieldsOf<D, T, R>>, RelationPage<D, T, R, Q>>
    : Identifier<RelatedType<D, T, R>, PivotFieldsOf<D, T, R>> | null

/** The `page` argument relation `R`'s to-many reads accept; `never` for a to-one. */
export type RelationPageParams<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = IsMany<D, T, R> extends true ? PageParams<RelationPaginator<D, T, R>> : never

/**
 * A relationship accessor off a {@link ResourceHandle} (`client.albums.id('1').tracks`):
 * reads — `.get()` (linkage) / `.related()` (related collection); writes — to-many
 * `.add`/`.remove`/`.replace([refs])` (POST/DELETE/PATCH) and to-one `.set(ref|null)`
 * (PATCH). A read is present only when the relation exposes that endpoint (the descriptor's
 * `related`/`relationship` flags, from the bundle's `withoutRelatedEndpoint()` /
 * `withoutRelationshipEndpoint()`, ADR 0027); a write is present only when the relationship
 * endpoint advertises that verb (the per-relation `mutations` flags, from `cannotAdd`/
 * `cannotRemove`/`cannotReplace`). A suppressed read or forbidden verb is typed `never`, so
 * calling it is a compile error rather than a server round-trip. A write returns the materialised
 * linkage, or `void` when the server replies `204`.
 */
export interface RelationshipAccessor<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> {
  get: ReadsRelationship<D, T, R> extends true
    ? <const Pg extends RelationPageParams<D, T, R> | undefined = undefined>(
        query?: RelationReadQuery<ExactPageParams<Pg, RelationPageParams<D, T, R>>>,
      ) => Promise<LinkageValue<D, T, R, Pg>>
    : never
  related: ExposesRelated<D, T, R> extends true
    ? <const Pg extends RelationPageParams<D, T, R> | undefined = undefined>(
        query?: RelationReadQuery<ExactPageParams<Pg, RelationPageParams<D, T, R>>>,
      ) => Promise<RelatedValue<D, A, T, R, Pg>>
    : never
  add: RelationMutation<D, T, R, 'add', readonly WriteRef<D, T, R>[]>
  remove: RelationMutation<D, T, R, 'remove', readonly LinkageRefOf<RelatedType<D, T, R>>[]>
  replace: RelationMutation<D, T, R, 'replace', readonly WriteRef<D, T, R>[]>
  set: RelationMutation<D, T, R, 'set', LinkageRefOf<RelatedType<D, T, R>> | null>
}

/**
 * A linkage ref for a to-many membership WRITE on relation `R` (`add`/`replace`, or a create or
 * update input), with `$pivot` typed from the relation's `writePivot` — so a `belongsToMany` add
 * carries the precise pivot shape (`{ position, weight?, … }`) instead of a loose record (D33).
 */
type WriteRef<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = LinkageRefOf<RelatedType<D, T, R>> & { $pivot?: WritePivotOf<D, T, R> }

/**
 * True unless relation `R`'s related endpoint is suppressed (`related: false`, the bundle's
 * `withoutRelatedEndpoint()`) or the relation is write-only. Absent flag ⇒ exposed (the default /
 * a hand-written descriptor).
 */
type ExposesRelated<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = D[T]['relations'][R] extends { related: false } | { writeOnly: true } ? false : true

/**
 * True unless relation `R`'s relationship endpoint is suppressed (`relationship: false`, the
 * bundle's `withoutRelationshipEndpoint()`). Absent flag ⇒ exposed (the default).
 */
type ExposesRelationship<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = D[T]['relations'][R] extends { relationship: false } ? false : true

/** Whether relation `R`'s linkage can be read back: exposed, and not write-only. */
type ReadsRelationship<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = D[T]['relations'][R] extends { writeOnly: true } ? false : ExposesRelationship<D, T, R>

/** The mutation verb a relationship accessor method maps to (`add`/`remove`/`replace` to-many, `set` to-one). */
type MutationVerb = 'add' | 'remove' | 'replace' | 'set'

/** The cardinality a mutation verb belongs to (`set` is to-one; the rest are to-many). */
type VerbCardinality<V extends MutationVerb> = V extends 'set' ? 'one' : 'many'

/**
 * True when relation `R` of type `T` advertises mutation verb `V`. The descriptor's
 * `mutations` flags are authoritative when present; when the relation carries no
 * `mutations` block at all (an older/looser descriptor), gating falls back to cardinality
 * alone so the verb stays callable. Crucially, an explicit `mutations: {}` (or one missing
 * the verb's flag) gates the verb OFF.
 */
type AdvertisesVerb<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
  V extends MutationVerb,
> = D[T]['relations'][R] extends { mutations: infer M }
  ? M extends Partial<Record<V, boolean>>
    ? M[V] extends true
      ? true
      : false
    : false
  : true

/**
 * A relationship-mutation method, gated by both cardinality and the per-relation verb
 * capability: present (typed `(refs) => Promise<…>`) only when the relation's cardinality
 * matches the verb's cardinality AND the relation advertises the verb (see
 * {@link AdvertisesVerb}); otherwise `never`, so calling the wrong verb for the cardinality
 * — or a verb the relation forbids (e.g. a to-many lacking `replace`) — is a compile error.
 * The result is the materialised linkage value or `void` (a `204` response).
 */
type RelationMutation<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
  V extends MutationVerb,
  Refs,
> =
  D[T]['relations'][R]['cardinality'] extends VerbCardinality<V>
    ? AdvertisesVerb<D, T, R, V> extends true
      ? (refs: Refs) => Promise<LinkageValue<D, T, R> | void>
      : never
    : never

/** The relationship accessors of type `T`, keyed by relation name. */
type RelationshipAccessors<D extends ApiDescriptor, A, T extends TypeName<D>> = {
  [R in RelationName<D, T>]: RelationshipAccessor<D, A, T, R>
}

// ── Write input types (CONTEXT.md "Write surface — flat input + fluent builder") ──────

/**
 * Writable pivot data carried on a to-many member as `$pivot` (a belongsToMany relation with
 * `pivot: true`), passed through as `meta.pivot`. The loose fallback for a relation whose
 * descriptor has no `writePivot`.
 */
export type PivotInput = Record<string, unknown>

/**
 * A single linkage reference accepted by a relationship-write input: a bare resource
 * identifier `{ type, id }`, a materialised resource object (its `type`/`id` are extracted by
 * the runtime), OR a local identifier `{ type, lid }` — an atomic-transaction `tx.create` handle
 * referencing a resource created earlier in the same batch (the runtime serialises the `lid`).
 * A to-many member may additionally carry `$pivot`.
 */
export type LinkageRef<TType extends string> =
  | (ResourceIdentifier<TType> & { $pivot?: PivotInput })
  | (LocalIdentifier<TType> & { $pivot?: PivotInput })
  | (ResourceObjectView<ApiDescriptor, unknown, TType> & { $pivot?: PivotInput })

/** A linkage ref distributed over a (possibly polymorphic) union of related types. */
type LinkageRefOf<TType extends string> = TType extends string ? LinkageRef<TType> : never

/**
 * The relationship VALUE accepted in a create/update input slot, by cardinality:
 * to-one accepts a single ref or `null` (clear); to-many accepts an array of refs, each with an
 * optional `$pivot` typed from the relation's `writePivot`.
 */
type RelationInput<D extends ApiDescriptor, T extends TypeName<D>, R extends RelationName<D, T>> =
  IsMany<D, T, R> extends true
    ? readonly WriteRef<D, T, R>[]
    : LinkageRefOf<RelatedType<D, T, R>> | null

/**
 * The relationship slots of type `T` as optional write input keys (one per declared relation,
 * write-only ones included).
 */
type RelationInputs<D extends ApiDescriptor, T extends TypeName<D>> = {
  [R in RelationName<D, T>]?: RelationInput<D, T, R>
}

/** The `{ create; update }` write-attribute pair for type `T` (or an open pair when `T` is absent from `W`). */
type WritePair<W, T> = T extends keyof W
  ? W[T]
  : { create: Record<string, unknown>; update: Record<string, unknown> }

/** The create attribute object for type `T` from the write map `W`. */
type CreateAttributesOf<W, T> = WritePair<W, T> extends { create: infer C } ? C : object

/** The update attribute object for type `T` from the write map `W`. */
type UpdateAttributesOf<W, T> = WritePair<W, T> extends { update: infer U } ? U : object

/**
 * The `id` field of a create input, typed by the type's `clientId` policy:
 * `forbidden` -> no `id` key; `optional` -> `id?: string`; `required` -> `id: string`.
 */
type CreateId<D extends ApiDescriptor, T extends TypeName<D>> = D[T]['clientId'] extends 'required'
  ? { id: string }
  : D[T]['clientId'] extends 'optional'
    ? { id?: string }
    : { id?: never }

/**
 * The flat input to `client.<type>.create(input)`: the type's create attributes + relation
 * slots, plus an `id` keyed by the client-id policy. The runtime builds the JSON:API
 * envelope (routing keys to attributes/relationships via the descriptor).
 */
export type CreateInput<D extends ApiDescriptor, W, T extends TypeName<D>> = CreateAttributesOf<
  W,
  T
> &
  RelationInputs<D, T> &
  CreateId<D, T>

/**
 * The flat input to `client.<type>.id(id).update(patch)`: the type's update attributes (all
 * optional) + relation slots. The id rides the handle, never the input.
 */
export type UpdateInput<D extends ApiDescriptor, W, T extends TypeName<D>> = UpdateAttributesOf<
  W,
  T
> &
  RelationInputs<D, T>

/** Options for a create/update write — an optional `include`/`fields` narrowing the materialised response. */
export interface WriteOptions<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[] = [],
  F extends FieldsMap<D> = FieldsMap<D>,
> {
  include?: Inc
  /** Sparse fieldsets per type — narrows the materialised write response. */
  fields?: F
}

// ── Atomic results (CONTEXT.md "Atomic — typed transaction builder") ──────────────────

/**
 * The materialised positional result of a single atomic op handle:
 *
 * - an {@link AtomicCreateHandle}/{@link AtomicUpdateHandle} for type `T` -> the `AtomicResult`
 *   wrapping the materialised resource view of `T` (the same {@link ResourceObjectView} a
 *   standalone create/update read returns — `data` is typed, not `unknown`, plus the optional op
 *   `meta`);
 * - an {@link AtomicDeleteHandle} -> `undefined` (a remove carries no data).
 *
 * Drives the per-op positional typing of {@link AtomicResults} (the callback's returned tuple of
 * handles maps to a tuple of these).
 */
export type AtomicResultOf<D extends ApiDescriptor, A, Handle> = Handle extends AtomicDeleteHandle
  ? undefined
  : Handle extends AtomicCreateHandle<infer T>
    ? T extends TypeName<D>
      ? AtomicResult<ResourceObjectView<D, A, T>>
      : never
    : Handle extends AtomicUpdateHandle<infer T>
      ? T extends TypeName<D>
        ? AtomicResult<ResourceObjectView<D, A, T>>
        : never
      : never

// ── Custom actions (CONTEXT.md "Write surface" — `.actions.<name>`) ────────────────────

/** The custom actions declared on type `T` (the descriptor's `actions` block, or `{}`). */
type ActionsOf<D extends ApiDescriptor, T extends TypeName<D>> = D[T] extends {
  actions: infer Acts
}
  ? Acts
  : Record<string, never>

/** The action names of type `T` declared at scope `Scope` (collection vs resource). */
type ActionNameAtScope<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  Scope extends string,
> = Extract<
  {
    [N in Extract<keyof ActionsOf<D, T>, string>]: ActionsOf<D, T>[N] extends { scope: Scope }
      ? N
      : never
  }[Extract<keyof ActionsOf<D, T>, string>],
  string
>

/**
 * The generated per-action body/result types (CONTEXT.md "Write surface" — a typed action
 * surface). The codegen emits precise `<Type><Action>Input`/`Output` aliases (expanding the
 * referenced JSON:API component) and threads them in keyed `type -> actionName -> { input?;
 * output? }` as the client's fourth type argument. Default `{}` (no codegen, or `createClient`
 * called directly): actions fall back to the loose `Record<string,unknown>` in / `unknown` out.
 * Deliberately an EMPTY object (no index signature) — an index-signatured map would resolve
 * every action's body type to `never`.
 */
export type DefaultActionTypes = Record<never, never>

/** The `{ input?; output? }` body-type entry for action `N` of type `T` from the action map `Act` (empty `{}` when absent). */
type ActionTypesFor<Act, T extends string, N extends string> = T extends keyof Act
  ? N extends keyof Act[T]
    ? Act[T][N]
    : Record<never, never>
  : Record<never, never>

/**
 * The typed body of a `document` action — the generated input type when the map carries one,
 * else a loose JSON:API document. Gated on the literal `'input'` key being present (not
 * structural `infer`) so a missing entry falls back rather than collapsing to `never`.
 */
type ActionInputBody<E> = 'input' extends keyof E ? E['input'] : Record<string, unknown>

/** The materialised result of a `document` action — the generated output type when present, else `unknown`. */
type ActionOutputBody<E> = 'output' extends keyof E ? E['output'] : unknown

/**
 * The static value an action returns, by its declared `output`:
 *
 * - `document` — the MATERIALISED resource view of the action's `outputType` (matching the read
 *   path — `result.title`, not `result.data.attributes.title`), a {@link Collection} when the
 *   output is a collection (`outputCardinality: 'many'`). Falls back to the generated
 *   {@link ActionOutputBody} only when the descriptor names no resolvable `outputType` (a bespoke
 *   document, or a pre-`outputType` generated client);
 * - `meta` — the response document's top-level `meta` object;
 * - `none` — `void` (a `204`).
 */
type ActionResult<D extends ApiDescriptor, A, Act extends ActionDescriptor, E> = Act extends {
  output: 'document'
}
  ? Act extends { outputType: infer OT extends TypeName<D> }
    ? Act extends { outputCardinality: 'many' }
      ? Promise<Collection<ReadResult<D, A, OT>>>
      : Promise<ReadResult<D, A, OT>>
    : Promise<ActionOutputBody<E>>
  : Act extends { output: 'meta' }
    ? Promise<Record<string, unknown>>
    : Promise<void>

/** The JSON:API media type, as the `accept` / `contentType` an action call names it by. */
type JsonApiMediaType = 'application/vnd.api+json'

/** How an action call reads a binary response: as a `Blob` (the default) or an `ArrayBuffer`. */
export type BinaryResponseType = 'blob' | 'arrayBuffer'

/** A request body sent for a `binary` request media type. */
export type BinaryBody = Blob | ArrayBuffer | Uint8Array<ArrayBuffer>

/**
 * The options every custom-action call takes, last argument (the only one for an action without
 * input). `accept` and `responseType` matter for an action with raw responses, `contentType` for
 * one listing several request media types; each generated method narrows them to what the action
 * declares.
 */
export interface ActionCallOptions {
  /** Cancels the request when signalled. */
  signal?: AbortSignal
  /** The media type to ask the action to answer in, sent as `Accept`. */
  accept?: string
  /** The request media type to send the body as, sent as `Content-Type`. */
  contentType?: string
  /** Read a binary response as a `Blob` (the default) or an `ArrayBuffer`. */
  responseType?: BinaryResponseType
}

/** The raw response media types an action declares (`[]` when none). */
type RawOutputOf<Act> = Act extends { rawOutput: infer R extends readonly RawOutputMedia[] }
  ? R
  : readonly []

/** The request media types an action lists when it lists several (`[]` otherwise). */
type InputMediaOf<Act> = Act extends { inputMedia: infer M extends readonly InputMedia[] }
  ? M
  : readonly []

/** The media types an action can answer in: JSON:API unless it answers in no document, plus each raw one. */
type AcceptOf<Act> =
  | (Act extends { output: 'none' } ? never : JsonApiMediaType)
  | RawOutputOf<Act>[number]['mediaType']

/** What an action answers in without an `accept`: JSON:API, or the first raw media type of one that answers in no document. */
type DefaultAccept<Act> = Act extends { output: 'none' }
  ? RawOutputOf<Act> extends readonly [infer First extends RawOutputMedia, ...unknown[]]
    ? First['mediaType']
    : never
  : JsonApiMediaType

/** A declared request media type as the caller may name it: a wildcard such as `image/*` takes any `image/…`. */
type MediaPattern<M extends string> = M extends `${infer Top}/*`
  ? Top extends '*'
    ? string
    : `${Top}/${string}`
  : M

/** The media types an action with several request media types can be sent as. */
type ContentTypeOf<Act> = MediaPattern<InputMediaOf<Act>[number]['mediaType']>

/** What an action with several request media types sends without a `contentType`: JSON:API when listed, else the first. */
type DefaultContentType<Act> = JsonApiMediaType extends InputMediaOf<Act>[number]['mediaType']
  ? JsonApiMediaType
  : InputMediaOf<Act> extends readonly [infer First extends InputMedia, ...unknown[]]
    ? First['mediaType']
    : never

/** The declared entry a picked media type `C` matches through a wildcard. */
type WildcardMatch<I, C> = I extends { mediaType: infer K extends string }
  ? C extends MediaPattern<K>
    ? I
    : never
  : never

/** The declared request media entry for a picked `C`: an exact match first, else a wildcard that takes it. */
type InputMediaFor<Act, C> = [Extract<InputMediaOf<Act>[number], { mediaType: C }>] extends [never]
  ? WildcardMatch<InputMediaOf<Act>[number], C>
  : Extract<InputMediaOf<Act>[number], { mediaType: C }>

/** The generated type keyed by media type under `Key` of the action's type entry `E`, else `unknown`. */
type GeneratedMediaType<E, Key extends string, M> = E extends { [K in Key]: infer Map }
  ? M extends keyof Map
    ? Map[M]
    : unknown
  : unknown

/**
 * The typed fields generated for a multipart or URL-encoded request media type `M`, which the
 * client encodes itself; `never` when its schema lists no properties, leaving only the raw body.
 */
type GeneratedFields<E, M> = E extends { requests: infer Map }
  ? M extends keyof Map
    ? Map[M]
    : never
  : never

/** The JSON:API document body an action takes: flat input for its `inputType`, else the generated or loose document. */
type DocumentInput<D extends ApiDescriptor, W, Act, E> = Act extends {
  inputType: infer IT extends TypeName<D>
}
  ? CreateInput<D, W, IT>
  : ActionInputBody<E>

/** The body an action with several request media types takes when sent as `C`. */
type InputBodyFor<D extends ApiDescriptor, W, Act, E, C> =
  InputMediaFor<Act, C> extends infer I
    ? I extends { kind: 'document' }
      ? DocumentInput<D, W, Act, E>
      : I extends { kind: 'binary' }
        ? BinaryBody
        : I extends { kind: 'text' }
          ? string
          : I extends { kind: 'multipart'; mediaType: infer K }
            ? GeneratedFields<E, K> | FormData
            : I extends { kind: 'form'; mediaType: infer K }
              ? GeneratedFields<E, K> | URLSearchParams | string
              : I extends { kind: 'json'; mediaType: infer K }
                ? GeneratedMediaType<E, 'requests', K>
                : unknown
    : never

/** The value of a raw response in media type `M`, by its kind. */
type RawResponseValue<Act, E, M, RT> =
  Extract<RawOutputOf<Act>[number], { mediaType: M }> extends infer R
    ? R extends { kind: 'text' }
      ? string
      : R extends { kind: 'binary' }
        ? RT extends 'arrayBuffer'
          ? ArrayBuffer
          : Blob
        : R extends { kind: 'json' }
          ? GeneratedMediaType<E, 'responses', M>
          : never
    : never

/** What an action call resolves to when it asks for media type `M`. */
type ActionResultIn<
  D extends ApiDescriptor,
  A,
  Act extends ActionDescriptor,
  E,
  M,
  RT,
> = M extends JsonApiMediaType
  ? ActionResult<D, A, Act, E>
  : Promise<RawResponseValue<Act, E, M, RT>>

/** The `accept` / `responseType` options of an action with raw responses. */
type ResponseOptions<Act, M, RT> = Act extends { rawOutput: readonly RawOutputMedia[] }
  ? { accept?: M; responseType?: RT }
  : unknown

/** The body argument of an action with input, the options last. */
type WithInput<D extends ApiDescriptor, W, Act, E> = Act extends { input: 'document' }
  ? DocumentInput<D, W, Act, E>
  : Act extends { input: 'raw'; contentType: infer K extends string }
    ? [GeneratedFields<E, K>] extends [never]
      ? unknown
      : K extends `multipart/${string}`
        ? GeneratedFields<E, K> | FormData
        : GeneratedFields<E, K> | URLSearchParams | string
    : unknown

/**
 * A single custom-action method, typed by its declared `input` mode:
 *
 * - `none`  — only the options;
 * - `document` — FLAT input (the `inputType`'s {@link CreateInput}, so the client builds the
 *   envelope + remaps `422` pointers like `create`); falls back to the generated
 *   {@link ActionInputBody} for a bespoke command document with no resolvable `inputType`;
 * - `raw`   — an arbitrary body (sent with the declared media type).
 *
 * The result is shaped by the action's `output` (see {@link ActionResult}). An action that answers
 * in raw media types takes an `accept` naming one, and resolves to that media type's value. An
 * action listing several request media types takes a `contentType` naming one, and its body is
 * typed by that media type.
 */
type ActionMethod<D extends ApiDescriptor, A, W, Act extends ActionDescriptor, E> = Act extends {
  inputMedia: readonly InputMedia[]
}
  ? <
      const C extends ContentTypeOf<Act> = Extract<DefaultContentType<Act>, ContentTypeOf<Act>>,
      const M extends AcceptOf<Act> = Extract<DefaultAccept<Act>, AcceptOf<Act>>,
      RT extends BinaryResponseType = 'blob',
    >(
      input: InputBodyFor<D, W, Act, E, C>,
      options?: { signal?: AbortSignal; contentType?: C } & ResponseOptions<Act, M, RT>,
    ) => ActionResultIn<D, A, Act, E, M, RT>
  : Act extends { rawOutput: readonly RawOutputMedia[] }
    ? Act extends { input: 'none' }
      ? <
          const M extends AcceptOf<Act> = Extract<DefaultAccept<Act>, AcceptOf<Act>>,
          RT extends BinaryResponseType = 'blob',
        >(
          options?: { signal?: AbortSignal } & ResponseOptions<Act, M, RT>,
        ) => ActionResultIn<D, A, Act, E, M, RT>
      : <
          const M extends AcceptOf<Act> = Extract<DefaultAccept<Act>, AcceptOf<Act>>,
          RT extends BinaryResponseType = 'blob',
        >(
          input: WithInput<D, W, Act, E>,
          options?: { signal?: AbortSignal } & ResponseOptions<Act, M, RT>,
        ) => ActionResultIn<D, A, Act, E, M, RT>
    : Act extends { input: 'none' }
      ? () => ActionResult<D, A, Act, E>
      : (input: WithInput<D, W, Act, E>) => ActionResult<D, A, Act, E>

/**
 * The typed map of a type's custom actions at one scope (`collection` on the
 * {@link TypeAccessor}, `resource` on the {@link ResourceHandle}). Each entry is an
 * {@link ActionMethod} keyed by the action name, typed from the descriptor (`input`/`output` modes,
 * `inputType`/`outputType`/`outputCardinality`) with `A`/`W` for the materialised result + flat
 * input; only actions declared at `Scope` are present. Empty (`{}`) when the type declares no
 * actions at that scope. `Act` supplies the generated per-action body-type fallbacks.
 */
export type ActionsAccessor<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
  Scope extends string,
  Act = DefaultActionTypes,
> = {
  // Mapped over the descriptor's own keys so each method keeps the JSDoc the codegen writes there.
  [N in keyof ActionsOf<D, T> as N extends ActionNameAtScope<D, T, Scope> ? N : never]: ActionsOf<
    D,
    T
  >[N] extends ActionDescriptor
    ? ActionMethod<D, A, W, ActionsOf<D, T>[N], ActionTypesFor<Act, T, Extract<N, string>>>
    : never
}

/**
 * A resource handle (no fetch) for a known id. Carries the read surface (`get`), the writes
 * scoped to a known id (`update`/`delete`), a relationship accessor per declared relation (by
 * name), a universal `.rel(name)` fallback (for relations whose name collides with a reserved
 * member like `get`/`update`/`rel`), and `.actions` (the type's resource-scoped custom
 * actions). `W` is the generated write-attribute map.
 */
export type ResourceHandle<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
  Act = DefaultActionTypes,
> = {
  readonly type: T
  readonly id: string
  get<const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
    query?: SingleReadQuery<D, T, Inc, F>,
  ): Promise<ReadResult<D, A, T, Inc, F>>
  update<const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
    patch: UpdateInput<D, W, T>,
    opts?: WriteOptions<D, T, Inc, F>,
  ): Promise<ReadResult<D, A, T, Inc, F>>
  delete(): Promise<void>
  rel<R extends RelationName<D, T>>(name: R): RelationshipAccessor<D, A, T, R>
  /** The type's resource-scoped custom actions, keyed by name (sub `{id}` from this handle). */
  readonly actions: ActionsAccessor<D, A, W, T, 'resource', Act>
} & RelationshipAccessors<D, A, T>

/** The collection-scoped accessor for one wire type (`client.albums`). */
export interface TypeAccessor<
  D extends ApiDescriptor,
  A,
  W,
  T extends TypeName<D>,
  Act = DefaultActionTypes,
> {
  list<
    const Inc extends readonly IncludePath<D, T>[] = [],
    const F extends FieldsMap<D> = {},
    const Pg extends ListPageParams<D, T> | undefined = undefined,
  >(
    query?: TypedReadQuery<D, T, Inc, F, Pg>,
  ): Promise<Collection<ReadResult<D, A, T, Inc, F>, PageOf<D[T]['paginator'], Pg>>>
  get<const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
    id: string,
    query?: SingleReadQuery<D, T, Inc, F>,
  ): Promise<ReadResult<D, A, T, Inc, F>>
  create<const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
    input: CreateInput<D, W, T>,
    opts?: WriteOptions<D, T, Inc, F>,
  ): Promise<ReadResult<D, A, T, Inc, F>>
  id(id: string): ResourceHandle<D, A, W, T, Act>
  /** The type's collection-scoped custom actions, keyed by name. */
  readonly actions: ActionsAccessor<D, A, W, T, 'collection', Act>
}

/**
 * The descriptor-driven client surface: one {@link TypeAccessor} per wire type. `W` is the
 * generated `WriteAttributes` map (per-type `{ create; update }` attribute pairs) and `Act`
 * the generated per-action body-type map; both thread through to the write/action surfaces and
 * default so read-only / codegen-less callers compile. `E` is the server's documented
 * error-code union, carried at the type level only (read it back with `ErrorCodeOf`).
 */
export type Client<
  D extends ApiDescriptor,
  A = DefaultAttributes<D>,
  W = DefaultWriteAttributes<D>,
  Act = DefaultActionTypes,
  E extends string = string,
> = {
  [T in TypeName<D>]: TypeAccessor<D, A, W, T, Act>
} & {
  /**
   * Run an Atomic Operations batch (CONTEXT.md "Atomic — typed transaction builder"): the
   * callback records `create`/`update`/`delete` ops on a non-type-scoped recorder (each carries
   * its `type`), posted all-or-nothing to the server's atomic endpoint. Present only when the
   * client was built with the server's `atomic` capability; calling it on an API without one
   * throws.
   *
   * The return shape is driven by what the callback returns (a single signature, branched in the
   * return type — NOT an overload set, which would defeat the per-op `const` tuple inference):
   *
   * - return a tuple of handles -> a PER-OP POSITIONALLY-TYPED tuple of results: a create/update
   *   handle resolves to the `AtomicResult` of that type (data typed as the materialised
   *   resource), a delete handle to `undefined`. The mapping is by `opIndex`, so it stays sound
   *   regardless of the order/subset of handles returned;
   * - return void/nothing -> the loose, ordered `AtomicResult[]` (backward-compatible).
   */
  atomic<const Ops>(
    build: (tx: AtomicRecorder<D, W>) => Ops,
  ): Promise<Ops extends readonly AtomicHandle[] ? AtomicResults<D, A, Ops> : AtomicResult[]>
  // Here rather than in its own intersection member, which stops json-api-query inferring `D`.
  readonly [errorCodes]?: E
}

// Type-only key: never assigned, so it costs nothing at runtime.
declare const errorCodes: unique symbol

/** The error-code union a client type carries, or `string` for one that carries none. */
export type ErrorCodeOf<T> = T extends { readonly [errorCodes]?: infer C extends string }
  ? C
  : string

/**
 * The fallback attribute map when a caller doesn't supply the generated `Attributes`
 * (direct `createClient` users without codegen): every type's attributes are an open
 * `Record<string, unknown>` so reads still type-check, just without precise fields.
 */
export type DefaultAttributes<D extends ApiDescriptor> = {
  [T in TypeName<D>]: Record<string, unknown>
}

/**
 * The fallback write-attribute map when a caller doesn't supply the generated
 * `WriteAttributes`: every type accepts an open `{ create; update }` pair so writes still
 * type-check without precise per-type field constraints.
 */
export type DefaultWriteAttributes<D extends ApiDescriptor> = {
  [T in TypeName<D>]: { create: Record<string, unknown>; update: Record<string, unknown> }
}
