/**
 * The client TYPE layer (Build 3): the static types a materialised read resolves to,
 * driven by the generated descriptor `D` (cardinality/related-type/pivot) and the
 * generated `Attributes` map `A` (the precise per-type attribute interfaces). The
 * runtime that produces these values lives in materialise.ts; this file is the
 * compile-time projection of that runtime onto descriptor + attribute types.
 *
 * Naming mirrors the runtime `$`-accessors: the data is
 * flattened as own enumerable props (`type`, `id`, attributes, relations) and the
 * envelope rides non-enumerable `$`-accessors.
 */
import type { Accepted, PollOptions } from './accepted'
import type {
  AtomicCreateHandle,
  AtomicDeleteHandle,
  AtomicHandle,
  AtomicRecorder,
  AtomicResult,
  AtomicResults,
  AtomicUpdateHandle,
} from './atomic'
import type {
  AcceptedOperation,
  ActionDescriptor,
  ApiDescriptor,
  InputMedia,
  RawOutputMedia,
  RelatedQueryOperation,
} from './descriptor'
import type { ActionLocation } from './location'
import type {
  ArrayEnvelope,
  DocumentEnvelope,
  Edge,
  NavigateOptions,
  RelationArrayEnvelope,
  RelationView,
  ResourceLinks,
} from './materialise'
import type { ExactPageParams, Page, PageOf, PageParams } from './pagination'
import type { LocalIdentifier, ResourceIdentifier } from './types'

/**
 * An augmented array (docs/materialisation.md "Augmented arrays"):
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
 * A to-many relationship value: a {@link Collection} that also carries `$count`, the
 * relationship's `meta.total` when the read counted it.
 */
export type RelationCollection<T, P = Page> = Collection<T, P> & RelationArrayEnvelope

/**
 * The edge-local accessors carried by a materialised related VALUE (a per-edge view):
 * `$edge` (this membership's edge meta/links) and `$pivot` (typed sugar over
 * `$edge.meta.pivot`). `$pivot` is graceful: present iff the endpoint rendered
 * `meta.pivot` (relationship/related endpoints), `undefined` otherwise. `Meta` types
 * `$edge.meta` where the linkage renders the relation's declared identifier meta.
 */
export interface EdgeMembers<
  Pivot = Record<string, unknown>,
  Meta extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly $edge: Edge<Meta> | undefined
  readonly $pivot: Pivot | undefined
}

/**
 * The resource-level `$`-accessors on a materialised resource object. `Links` types `$links`: the
 * type's generated links interface when its resources declare links, else the loose
 * {@link ResourceLinks}.
 */
export interface ResourceAccessors<Links = ResourceLinks> {
  readonly $meta: Record<string, unknown> | undefined
  readonly $links: Links | undefined
  /** The `self` link's href, whether the wire carried a bare URL or a link object. */
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
 * The read-types map a client threads to its results: the attribute map `A`, carrying the
 * per-type declared links map `L` so every type that takes `A` reaches them without another
 * parameter. An empty `L` leaves `A` as it is. The key is a string a wire type can't be, since `$`
 * is not allowed in a JSON:API member name. A symbol key would leave a consumer's declaration
 * emit unable to name the bound query API's type.
 */
export type WithLinks<A, L> = [keyof L] extends [never] ? A : A & { readonly $declaredLinks: L }

/** The links of type `T`: its declared links interface from `A`, or the loose {@link ResourceLinks}. */
type LinksOf<A, T> = A extends { readonly $declaredLinks: infer L }
  ? T extends keyof L
    ? L[T]
    : ResourceLinks
  : ResourceLinks

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
  Meta extends Record<string, unknown> = Record<string, unknown>,
> = ResourceIdentifier<TType> & EdgeMembers<Pivot, Meta>

/**
 * A hydrated related resource: a per-edge VIEW — the full `ResourceObjectView` of the
 * related node plus this membership's `$edge`/`$pivot`. Relations one hop deep stay as
 * identifiers (no nested-include narrowing in the read API today). The fieldset map `F`
 * threads through so a sparse fieldset on the included type narrows its attributes/relations.
 * `Pivot` types the per-edge `$pivot` (a `belongsToMany` relation's `meta.pivot`), and `Meta` the
 * per-edge `$edge.meta`.
 */
export type HydratedMember<
  D extends ApiDescriptor,
  A,
  TType extends TypeName<D>,
  F = unknown,
  Pivot = Record<string, unknown>,
  Meta extends Record<string, unknown> = Record<string, unknown>,
> = ResourceObjectView<D, A, TType, never, F> & EdgeMembers<Pivot, Meta>

/** A hydrated related value distributes over a polymorphic union of related types. */
type Hydrated<
  D extends ApiDescriptor,
  A,
  TType extends TypeName<D>,
  F = unknown,
  Pivot = Record<string, unknown>,
  Meta extends Record<string, unknown> = Record<string, unknown>,
> = TType extends TypeName<D> ? HydratedMember<D, A, TType, F, Pivot, Meta> : never

/** An identifier related value distributes over a polymorphic union of related types. */
type Identifier<
  TType extends string,
  Pivot = Record<string, unknown>,
  Meta extends Record<string, unknown> = Record<string, unknown>,
> = TType extends string ? IdentifierMember<TType, Pivot, Meta> : never

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
    ? RelationCollection<
        Hydrated<D, A, RelatedType<D, T, R>, F, Record<string, unknown>, EdgeMetaOf<D, T, R>>,
        RelationPage<D, T, R>
      >
    : Hydrated<D, A, RelatedType<D, T, R>, F, Record<string, unknown>, EdgeMetaOf<D, T, R>> | null
  : IsMany<D, T, R> extends true
    ? RelationCollection<
        Identifier<RelatedType<D, T, R>, Record<string, unknown>, EdgeMetaOf<D, T, R>>,
        RelationPage<D, T, R>
      >
    :
        | Identifier<RelatedType<D, T, R>, Record<string, unknown>, EdgeMetaOf<D, T, R>>
        | null
        | undefined

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
 * The relations of type `T` a `withCount` read can count: its count tokens without `_self_`,
 * which counts the collection rather than a relation.
 */
export type CountedRelationName<D extends ApiDescriptor, T extends TypeName<D>> = Exclude<
  CountToken<D, T>,
  '_self_'
>

/**
 * The `$count` accessor of a resource object of type `T`: a relationship's `meta.total`, read
 * from the raw relationship so it works when the relation carries no data. `Counted` names the
 * relations the read asked to count, for which it is a `number`; any other relation may have no
 * count, so it is `number | undefined`.
 */
export interface CountAccessor<D extends ApiDescriptor, T extends TypeName<D>, Counted = never> {
  $count<R extends CountedRelationName<D, T>>(
    name: R,
  ): R extends Counted ? number : number | undefined
}

/**
 * A materialised resource object: flattened `type` + `id` + attributes + relation slots
 * as own enumerable props, intersected with the resource-level `$`-accessors. `Inc` is
 * the union of relation names included by the read (narrows relations to hydrated); `F` is
 * the sparse-fieldset selection map (narrows attributes/relations to the requested members —
 * `type`/`id`/the `$`-accessors are always present). The default `F = unknown` keeps every
 * member (no fieldset narrowing). `Counted` names the relations the read counted, whose `$count`
 * is then a `number`.
 */
export type ResourceObjectView<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  Inc = never,
  F = unknown,
  Counted = never,
> = {
  type: T
  id: string
} & PickSelected<AttributesOf<A, T>, SelectedFields<F, T>> &
  Relations<D, A, T, Inc, F> &
  ResourceAccessors<LinksOf<A, T>> &
  CountAccessor<D, T, Counted>

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
 * The types a compound document of type `T` can carry in `included`: the descriptor's
 * `included` list, or every type `D` declares when the descriptor doesn't list them.
 */
export type IncludedType<D extends ApiDescriptor, T extends TypeName<D>> = D[T] extends {
  included: infer I
}
  ? I extends readonly (infer U)[]
    ? Extract<U, TypeName<D>>
    : TypeName<D>
  : TypeName<D>

/**
 * One resource of a type `T` compound document's `included`, a union discriminated by `type`
 * over {@link IncludedType}.
 */
export type IncludedResource<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  F = unknown,
> = IncludedOf<D, A, IncludedType<D, T>, F>

/**
 * The types the related read of relation `R` on type `T` can carry in `included`: the relation
 * descriptor's `included` list, or every type `D` declares when it doesn't list them.
 */
export type RelatedIncludedType<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = D[T]['relations'][R] extends { included: infer I }
  ? I extends readonly (infer U)[]
    ? Extract<U, TypeName<D>>
    : TypeName<D>
  : TypeName<D>

/**
 * One resource of the `included` of relation `R`'s related read on type `T`, a union discriminated
 * by `type` over {@link RelatedIncludedType}.
 */
export type RelatedIncludedResource<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
  F = unknown,
> = IncludedOf<D, A, RelatedIncludedType<D, T, R>, F>

type IncludedOf<D extends ApiDescriptor, A, U extends TypeName<D>, F> =
  U extends TypeName<D> ? ResourceObjectView<D, A, U, never, F> : never

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
 * A sort token type `T`'s COLLECTION read accepts: its `sortable` literal union (signed field
 * names like `title`/`-title`) plus, per sort family, `prefix.${string}` and `-prefix.${string}`.
 * `never` when the collection advertises no sorting.
 */
export type SortToken<D extends ApiDescriptor, T extends TypeName<D>> = SortTokenOf<D[T]>

/**
 * A sort token a descriptor `Spec` (a type's, or a relation's) accepts: its `sortable` literal
 * union plus, per sort family, `prefix.${string}` and `-prefix.${string}`. `never` when it
 * declares neither.
 */
type SortTokenOf<Spec> = FixedSortToken<Spec> | FamilySortToken<Spec>

type FixedSortToken<Spec> = Spec extends {
  sortable: infer S
}
  ? S extends readonly (infer Token)[]
    ? Token & string
    : never
  : never

type FamilySortToken<Spec> = Spec extends {
  sortFamilies: infer F
}
  ? F extends readonly { prefix: infer P extends string }[]
    ? `${P}.${string}` | `-${P}.${string}`
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
 * The filter keys of a descriptor `Spec` (a type's, or a collection action's) whose filter takes a
 * list, or `never`.
 */
type ListFilterKeyOf<Spec> = Spec extends { listFilters: readonly (infer Key)[] }
  ? Key & string
  : never

/** The filter family prefixes of a descriptor `Spec`, or `never`. */
type FilterFamilyPrefixOf<Spec> = Spec extends {
  filterFamilies: readonly { prefix: infer P extends string }[]
}
  ? P
  : never

/** The value a filter family of `Spec` keyed `P` takes: a list for a list family, else a string. */
type FilterFamilyValue<Spec, P extends string> = Spec extends {
  filterFamilies: readonly (infer Family)[]
}
  ? Extract<Family, { prefix: P }> extends { list: true }
    ? readonly string[]
    : string
  : never

/**
 * The filter object a descriptor `Spec` takes, given its exact filter keys `Key`: each exact key
 * `unknown`, a list filter's key `readonly string[]`, and per filter family a `<prefix>.${string}`
 * key. With no list filter and no family it is the plain partial record of the exact keys.
 */
type FiltersOf<Spec, Key extends string> = [
  ListFilterKeyOf<Spec> | FilterFamilyPrefixOf<Spec>,
] extends [never]
  ? Partial<Record<Key, unknown>>
  : Partial<Record<Exclude<Key, ListFilterKeyOf<Spec>>, unknown>> &
      Partial<Record<ListFilterKeyOf<Spec> & Key, readonly string[]>> & {
        [P in FilterFamilyPrefixOf<Spec> as `${P}.${string}`]?: FilterFamilyValue<Spec, P>
      }

/**
 * The `filter` object for type `T`: keys constrained to the advertised filter params (values
 * stay `unknown` — value shapes/operators vary), a list filter's value a list of strings, and a
 * `<prefix>.${string}` key per filter family. `never` (so `filter` cannot be supplied) when the
 * collection advertises no filters — a compile-time mirror of `400 FILTERING_UNRECOGNIZED`.
 */
export type FilterQuery<D extends ApiDescriptor, T extends TypeName<D>> = [
  FilterKey<D, T> | FilterFamilyPrefixOf<D[T]>,
] extends [never]
  ? never
  : FiltersOf<D[T], FilterKey<D, T>>

/** The exact filter keys a descriptor `Spec` declares in `filterable`, or `never`. */
type FilterKeyOf<Spec> = Spec extends { filterable: readonly (infer Key)[] } ? Key & string : never

/** Relation `R` of type `T` as its descriptor declares it. */
type RelationSpec<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = D[T]['relations'][R]

/** Whether a descriptor `Spec` records `sortable` or `sortFamilies`, even an empty `sortable`. */
type RecordsSorts<Spec> = Spec extends { sortable: unknown }
  ? true
  : Spec extends { sortFamilies: unknown }
    ? true
    : false

/**
 * The related type of a relation `Spec` the client can tell is monomorphic, as
 * {@link isPolymorphic} tells at runtime: flagged `polymorphic: false`, or unflagged with a
 * literal one-type `types` tuple. `never` otherwise.
 */
type MonomorphicTarget<D extends ApiDescriptor, Spec> = Spec extends { polymorphic: true }
  ? never
  : Spec extends { polymorphic: false; types: readonly [infer First, ...unknown[]] }
    ? Extract<First, TypeName<D>>
    : Spec extends { types: readonly [infer Only] }
      ? Extract<Only, TypeName<D>>
      : never

/** One of the tokens `Token` or a tuple of them; `never` when there are none. */
type SortTokensQuery<Token> = [Token] extends [never] ? never : Token | readonly Token[]

/**
 * The `sort` value relation `R`'s related and relationship reads take, as {@link SortQuery} types
 * a collection read. Where the descriptor records the relation's own `sortable` or
 * `sortFamilies`, they're its tokens, and an empty `sortable` with no families means the reads
 * take no sort, typed `never`. Where it records neither, a monomorphic relation takes its related
 * type's collection tokens and a polymorphic one takes any sort.
 */
export type RelationSortQuery<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> =
  RecordsSorts<RelationSpec<D, T, R>> extends true
    ? SortTokensQuery<SortTokenOf<RelationSpec<D, T, R>>>
    : MonomorphicTarget<D, RelationSpec<D, T, R>> extends infer U extends TypeName<D>
      ? [U] extends [never]
        ? string | readonly string[]
        : SortQuery<D, U>
      : string | readonly string[]

/** Whether a descriptor `Spec` records `filterable` or `filterFamilies`, even an empty `filterable`. */
type RecordsFilters<Spec> = Spec extends { filterable: unknown }
  ? true
  : Spec extends { filterFamilies: unknown }
    ? true
    : false

/** The filter object a descriptor `Spec` takes; `never` when it declares no key and no family. */
type SpecFilterQuery<Spec> = [FilterKeyOf<Spec> | FilterFamilyPrefixOf<Spec>] extends [never]
  ? never
  : FiltersOf<Spec, FilterKeyOf<Spec>>

/**
 * The `filter` object relation `R`'s related and relationship reads take, as {@link FilterQuery}
 * types a collection read. Where the descriptor records the relation's own `filterable` or
 * `filterFamilies`, they're its keys, and an empty `filterable` with no families means the reads
 * take no filter, typed `never`. Where it records neither, a monomorphic relation takes its related
 * type's collection filter and a polymorphic one takes any filter.
 */
export type RelationFilterQuery<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> =
  RecordsFilters<RelationSpec<D, T, R>> extends true
    ? SpecFilterQuery<RelationSpec<D, T, R>>
    : MonomorphicTarget<D, RelationSpec<D, T, R>> extends infer U extends TypeName<D>
      ? [U] extends [never]
        ? Record<string, unknown>
        : FilterQuery<D, U>
      : Record<string, unknown>

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

/** A `relatedQuery` entry for a path whose relation the types can't resolve. */
export interface LooseRelatedQueryEntry {
  filter?: Record<string, unknown>
  sort?: string | readonly string[]
}

/**
 * The `relatedQuery` entry for relation `R` of type `T`: its `filter` and `sort` typed as the
 * relation's own related read types them (see {@link RelationFilterQuery} and
 * {@link RelationSortQuery}).
 */
export interface RelatedQueryEntry<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> {
  filter?: RelationFilterQuery<D, T, R>
  sort?: RelationSortQuery<D, T, R>
}

/** The most relationships deep {@link RelatedQueryEntryAt} follows a path before it goes loose. */
type MaxRelatedQueryDepth = 8

/**
 * The entry for include path `P` from type `T`, typed from the relation the path ends on. A
 * polymorphic relation part way along continues from each member type declaring the next
 * relation. `never` when no type along the path declares it.
 */
type RelatedQueryEntryAt<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  P extends string,
  Depth extends readonly unknown[] = [],
> = Depth['length'] extends MaxRelatedQueryDepth
  ? LooseRelatedQueryEntry
  : P extends `${infer Head}.${infer Rest}`
    ? Head extends RelationName<D, T>
      ? RelatedType<D, T, Head> extends infer U
        ? U extends TypeName<D>
          ? RelatedQueryEntryAt<D, U, Rest, [...Depth, unknown]>
          : never
        : never
      : never
    : P extends RelationName<D, T>
      ? RelatedQueryEntry<D, T, P>
      : never

/** The entry for include path `P` from type `T`, loose when its relation can't be resolved. */
type RelatedQueryEntryFor<D extends ApiDescriptor, T extends TypeName<D>, P extends string> = [
  RelatedQueryEntryAt<D, T, P>,
] extends [never]
  ? LooseRelatedQueryEntry
  : RelatedQueryEntryAt<D, T, P>

/**
 * The `relatedQuery` object for type `T` (the Relationship Queries profile): keyed by the type's
 * include paths, each entry a `filter` and `sort` for the relationship the path ends on.
 */
export type RelatedQuery<D extends ApiDescriptor, T extends TypeName<D>> = {
  readonly [P in IncludePath<D, T>]?: RelatedQueryEntryFor<D, T, P>
}

/**
 * The `relatedQuery` read `Op` of type `T` takes: {@link RelatedQuery} when the type's
 * descriptor names the read in `relatedQuery.operations`, else `never`, so it can't be sent.
 */
export type RelatedQueryParam<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  Op extends RelatedQueryOperation,
> = D[T] extends { relatedQuery: { operations: readonly (infer O)[] } }
  ? Op extends O
    ? RelatedQuery<D, T>
    : never
  : never

/** The `page` argument a collection read of type `T` accepts (see {@link PageParams}). */
export type ListPageParams<D extends ApiDescriptor, T extends TypeName<D>> = PageParams<
  D[T]['paginator']
>

/**
 * A read query carrying a typed, narrowing `include`, a typed `fields` (drives sparse-fieldset
 * return narrowing), a `withCount` constrained to the type's count tokens (`Cnt` drives `$count`
 * narrowing), a `page` typed by the collection's paginator (`Pg` drives the `$page` type), a
 * `relatedQuery` keyed by include path, plus the loose JSON:API query families. `Inc`/`F`/`Cnt`
 * are inferred (as `const`) at the call site. Used for the COLLECTION read (`list`); the
 * single-resource read (`get`) uses {@link SingleReadQuery}, which drops `withCount` (no
 * `GET /{type}/{id}` endpoint advertises it).
 */
export interface TypedReadQuery<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[],
  F extends FieldsMap<D> = FieldsMap<D>,
  Pg extends ListPageParams<D, T> | undefined = ListPageParams<D, T> | undefined,
  Cnt extends readonly CountToken<D, T>[] = readonly CountToken<D, T>[],
> {
  /** The relations to include — drives static narrowing; constrained to the advertised paths. */
  include?: Inc
  /** Filter the collection — keys constrained to the type's advertised `filter[...]` params. */
  filter?: FilterQuery<D, T>
  /** Sort the collection — constrained to the type's advertised (signed) sort tokens and families. */
  sort?: SortQuery<D, T>
  /** Sparse fieldsets per type — drives return-type narrowing (unrequested members are absent). */
  fields?: F
  /**
   * Relationship-count tokens (the Countable profile) — comma-joined onto `withCount`. Each
   * relation named here reads back as a `number` from `$count` on the result's resources.
   */
  withCount?: Cnt
  /**
   * A `filter` and `sort` per include path, applied to that relationship (the Relationship
   * Queries profile). Present only when the collection read advertises it.
   */
  relatedQuery?: RelatedQueryParam<D, T, 'fetchMany'>
  /**
   * The page to read, under the paginator's wire keys. On a menu, `kind` picks a strategy;
   * without it the server answers with its default.
   */
  page?: ExactPageParams<Pg, ListPageParams<D, T>>
  /** Cancels the read when signalled (e.g. a superseded request). Not sent to the server. */
  signal?: AbortSignal
}

/**
 * A single-resource read query (`GET /{type}/{id}`): `include`, sparse `fields` and, where the
 * read advertises it, `relatedQuery`. A single-resource endpoint advertises neither
 * `sort`/`filter`/`page` (no collection to order, filter or page) nor `withCount` — accepting
 * any of them would be a lying type (the server rejects an unrecognised parameter with `400`
 * under strict query-param validation).
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
  /**
   * A `filter` and `sort` per include path, applied to that relationship (the Relationship
   * Queries profile). Present only when the single-resource read advertises it.
   */
  relatedQuery?: RelatedQueryParam<D, T, 'fetchOne'>
  /** Cancels the read when signalled (e.g. a superseded request). Not sent to the server. */
  signal?: AbortSignal
}

/**
 * The static return type of a read on type `T` given its `include` tuple and `fields` selection
 * `F` — the resource object with the named relations narrowed to hydrated and its members
 * narrowed to the requested sparse fieldset. `Counted` names the relations the read counted.
 */
export type ReadResult<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[] = [],
  F = unknown,
  Counted = never,
> = ResourceObjectView<D, A, T, IncludedRelations<D, T, Inc>, F, Counted>

/**
 * A read query for the relationship/related endpoints: loose include/fields/withCount, a `page` of
 * type `Pg` (typed from the relation's paginator on a typed accessor), and a `sort` of type `S`
 * and a `filter` of type `F`, which a typed accessor narrows to what the relation's reads take
 * (see {@link RelationSortQuery} and {@link RelationFilterQuery}).
 */
export interface RelationReadQuery<
  Pg = Readonly<Record<string, unknown>>,
  S = string | readonly string[],
  F = Record<string, unknown>,
> {
  filter?: F
  sort?: S
  include?: readonly string[]
  fields?: Record<string, readonly string[]>
  page?: Pg
  /**
   * Relationship-count tokens (`_self_` + the relation's countable relations) — the related/
   * relationship endpoints advertise their own `withCount`, and the client negotiates the
   * relation's Countable profile so a strict server accepts it.
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
 * a loose record.
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
 * The `$edge.meta` of each linkage member of relation `R`: the members the descriptor's
 * `identifierMeta` declares, typed like a pivot, over an open record that still carries
 * `pivot` and any other meta. A relation declaring none keeps the open record.
 */
type EdgeMetaOf<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = D[T]['relations'][R] extends { identifierMeta: infer P }
  ? PivotObject<P> & Record<string, unknown>
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
 * relation's `readPivot`.
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
 * Each member's `$pivot` is typed from the relation's `readPivot`, and its `$edge.meta` from its
 * `identifierMeta`.
 */
type LinkageValue<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
  Q = undefined,
> =
  IsMany<D, T, R> extends true
    ? Collection<
        Identifier<RelatedType<D, T, R>, PivotFieldsOf<D, T, R>, EdgeMetaOf<D, T, R>>,
        RelationPage<D, T, R, Q>
      >
    : Identifier<RelatedType<D, T, R>, PivotFieldsOf<D, T, R>, EdgeMetaOf<D, T, R>> | null

/**
 * The query relation `R`'s related and relationship reads take, its `sort` and `filter` narrowed
 * to what the relation declares and its `page` of type `Pg`.
 */
export type TypedRelationReadQuery<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
  Pg = Readonly<Record<string, unknown>>,
> = RelationReadQuery<Pg, RelationSortQuery<D, T, R>, RelationFilterQuery<D, T, R>>

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
 * `withoutRelationshipEndpoint()`); a write is present only when the relationship
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
        query?: TypedRelationReadQuery<D, T, R, ExactPageParams<Pg, RelationPageParams<D, T, R>>>,
      ) => Promise<LinkageValue<D, T, R, Pg>>
    : never
  related: ExposesRelated<D, T, R> extends true
    ? <const Pg extends RelationPageParams<D, T, R> | undefined = undefined>(
        query?: TypedRelationReadQuery<D, T, R, ExactPageParams<Pg, RelationPageParams<D, T, R>>>,
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
 * carries the precise pivot shape (`{ position, weight?, … }`) instead of a loose record.
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
  // Mapped over the descriptor's own keys so each member keeps the JSDoc the codegen writes there.
  -readonly [R in keyof D[T]['relations'] as Extract<R, string>]: RelationshipAccessor<
    D,
    A,
    T,
    Extract<R, string>
  >
}

// ── Write input types (docs/writes.md) ─────────────────────────────────────────────────────────

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
  // Mapped over the descriptor's own keys so each member keeps the JSDoc the codegen writes there.
  -readonly [R in keyof D[T]['relations'] as Extract<R, string>]?: RelationInput<
    D,
    T,
    Extract<R, string>
  >
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

// ── Accepted writes (docs/writes.md) ──────────────────────────────────────────────────────────

/** The options that make a write wait for an accepted job: `true`, or the {@link PollOptions}. */
export interface WaitOptions {
  wait: true | PollOptions
}

/** The `202` write `Op` on type `T` declares (its `{ jobType }`), or `never`. */
export type AcceptedOf<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  Op extends AcceptedOperation,
> = D[T] extends {
  accepted: infer Acc
}
  ? Acc extends { [K in Op]: infer J }
    ? J
    : never
  : never

/**
 * The job an accepted write answers with: the job type's resource view when it is a type of this
 * API, else an open record, which is also what a meta-only job document's `meta` reads as.
 */
export type AcceptedJob<D extends ApiDescriptor, A, J> = J extends {
  jobType: infer JT extends string
}
  ? JT extends TypeName<D>
    ? ReadResult<D, A, JT>
    : Readonly<Record<string, unknown>>
  : never

/**
 * What write `Op` on type `T` resolves to without waiting: its result `R`, or, when it declares a
 * `202`, `R` or an {@link Accepted} job whose poll resolves to the resource without the write's
 * `include` or `fields`.
 */
export type WriteResult<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  Op extends AcceptedOperation,
  R,
> = [AcceptedOf<D, T, Op>] extends [never]
  ? R
  : R | Accepted<AcceptedJob<D, A, AcceptedOf<D, T, Op>>, ReadResult<D, A, T>>

/**
 * The `wait` a caller may pass to write `Op` on type `T`: a boolean or {@link PollOptions} when it
 * declares a `202`, else nothing.
 */
export type WaitValue<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  Op extends AcceptedOperation,
> = [AcceptedOf<D, T, Op>] extends [never] ? undefined : boolean | PollOptions | undefined

/**
 * What write `Op` resolves to when called with `wait` of type `Wt`: the resource without the
 * write's `include` or `fields` when it waits, else {@link WriteResult}.
 */
export type WaitedWriteResult<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  Op extends AcceptedOperation,
  R,
  Wt,
> = Wt extends true | PollOptions ? ReadResult<D, A, T> : WriteResult<D, A, T, Op, R>

/**
 * `client.<type>.create`. A type whose create declares a `202` also takes `wait`, which polls an
 * accepted job and resolves to the created resource; without it the call may resolve to an
 * {@link Accepted}.
 */
export type CreateMethod<D extends ApiDescriptor, A, W, T extends TypeName<D>> = [
  AcceptedOf<D, T, 'create'>,
] extends [never]
  ? <const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
      input: CreateInput<D, W, T>,
      opts?: WriteOptions<D, T, Inc, F>,
    ) => Promise<ReadResult<D, A, T, Inc, F>>
  : {
      (input: CreateInput<D, W, T>, opts: WaitOptions): Promise<ReadResult<D, A, T>>
      <const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
        input: CreateInput<D, W, T>,
        opts?: WriteOptions<D, T, Inc, F> & { wait?: false },
      ): Promise<WriteResult<D, A, T, 'create', ReadResult<D, A, T, Inc, F>>>
    }

/** `client.<type>.id(id).update`, which takes `wait` as {@link CreateMethod} does. */
export type UpdateMethod<D extends ApiDescriptor, A, W, T extends TypeName<D>> = [
  AcceptedOf<D, T, 'update'>,
] extends [never]
  ? <const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
      patch: UpdateInput<D, W, T>,
      opts?: WriteOptions<D, T, Inc, F>,
    ) => Promise<ReadResult<D, A, T, Inc, F>>
  : {
      (patch: UpdateInput<D, W, T>, opts: WaitOptions): Promise<ReadResult<D, A, T>>
      <const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
        patch: UpdateInput<D, W, T>,
        opts?: WriteOptions<D, T, Inc, F> & { wait?: false },
      ): Promise<WriteResult<D, A, T, 'update', ReadResult<D, A, T, Inc, F>>>
    }

// ── Atomic results (docs/atomic-operations.md) ─────────────────────────────────────────────────

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

// ── Custom actions (docs/custom-actions.md) ────────────────────────────────────────────────────

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
 * The generated per-action body/result types (docs/custom-actions.md — a typed
 * action surface). The codegen emits precise `<Type><Action>Input`/`Output` aliases (expanding the
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
 * The static value an action returns, by its declared `output`, or an {@link ActionLocation} when
 * it declares a `location` (only that for output `location`):
 *
 * - `document` — the MATERIALISED resource view of the action's `outputType` (matching the read
 *   path — `result.title`, not `result.data.attributes.title`), a {@link Collection} when the
 *   output is a collection (`outputCardinality: 'many'`). Falls back to the generated
 *   {@link ActionOutputBody} only when the descriptor names no resolvable `outputType` (a bespoke
 *   document, or a pre-`outputType` generated client);
 * - `meta` — the response document's top-level `meta` object;
 * - `none` — `void` (a `204`).
 */
type ActionResult<D extends ApiDescriptor, A, Act extends ActionDescriptor, E> = Promise<
  ActionValue<D, A, Act, E> | ActionAccepted<D, A, Act, E>
>

/** The value an action answers with when it answers synchronously. */
type ActionValue<D extends ApiDescriptor, A, Act extends ActionDescriptor, E> = Act extends {
  location: object
}
  ? ActionDocumentValue<D, A, Act, E> | ActionLocation
  : ActionDocumentValue<D, A, Act, E>

/** The {@link Accepted} job of an action that declares a `202`, or `never`. */
type ActionAccepted<D extends ApiDescriptor, A, Act extends ActionDescriptor, E> = Act extends {
  accepted: object
}
  ? Accepted<AcceptedJob<D, A, Act['accepted']>, ActionValue<D, A, Act, E>>
  : never

/** The `wait` option of an action that declares a `202`; `unknown` (adding nothing) otherwise. */
type ActionWaitOption<Act> = Act extends { accepted: object }
  ? { wait?: boolean | PollOptions }
  : unknown

/** The value of an action's JSON:API answer other than a location document. */
type ActionDocumentValue<
  D extends ApiDescriptor,
  A,
  Act extends ActionDescriptor,
  E,
> = Act extends {
  output: 'document'
}
  ? Act extends { outputType: infer OT extends TypeName<D> }
    ? Act extends { outputCardinality: 'many' }
      ? Collection<ReadResult<D, A, OT>>
      : ReadResult<D, A, OT>
    : ActionOutputBody<E>
  : Act extends { output: 'meta' }
    ? Record<string, unknown>
    : Act extends { output: 'location' }
      ? never
      : void

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
  /** The filters of a collection action that takes them, sent as `filter[...]` like a read's. */
  filter?: Readonly<Record<string, unknown>>
  /** Poll a `202 Accepted` job until it's done, for an action that declares one. */
  wait?: boolean | PollOptions
}

/** A filter key a collection action accepts (its `filterable` literal union), or `never`. */
type ActionFilterKey<Act> = Act extends { filterable: readonly (infer Key)[] }
  ? Key & string
  : never

/**
 * The `filter` option of an action that takes filters, keyed like {@link FilterQuery}; `unknown`
 * (adding nothing) for one that takes none.
 */
type ActionFilterOptions<Act> = [ActionFilterKey<Act> | FilterFamilyPrefixOf<Act>] extends [never]
  ? unknown
  : { filter?: FiltersOf<Act, ActionFilterKey<Act>> }

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
          ? string | Blob
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
 * typed by that media type. An action that takes filters takes a `filter` option keyed by them.
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
      options?: { signal?: AbortSignal; contentType?: C } & ResponseOptions<Act, M, RT> &
        ActionFilterOptions<Act> &
        ActionWaitOption<Act>,
    ) => ActionResultIn<D, A, Act, E, M, RT>
  : Act extends { rawOutput: readonly RawOutputMedia[] }
    ? Act extends { input: 'none' }
      ? <
          const M extends AcceptOf<Act> = Extract<DefaultAccept<Act>, AcceptOf<Act>>,
          RT extends BinaryResponseType = 'blob',
        >(
          options?: { signal?: AbortSignal } & ResponseOptions<Act, M, RT> &
            ActionFilterOptions<Act> &
            ActionWaitOption<Act>,
        ) => ActionResultIn<D, A, Act, E, M, RT>
      : <
          const M extends AcceptOf<Act> = Extract<DefaultAccept<Act>, AcceptOf<Act>>,
          RT extends BinaryResponseType = 'blob',
        >(
          input: WithInput<D, W, Act, E>,
          options?: { signal?: AbortSignal } & ResponseOptions<Act, M, RT> &
            ActionFilterOptions<Act> &
            ActionWaitOption<Act>,
        ) => ActionResultIn<D, A, Act, E, M, RT>
    : Act extends { accepted: object }
      ? AcceptedActionMethod<D, A, W, Act, E>
      : Act extends { filterable: readonly string[] } | { filterFamilies: readonly unknown[] }
        ? Act extends { input: 'none' }
          ? (
              options?: { signal?: AbortSignal } & ActionFilterOptions<Act>,
            ) => ActionResult<D, A, Act, E>
          : (
              input: WithInput<D, W, Act, E>,
              options?: { signal?: AbortSignal } & ActionFilterOptions<Act>,
            ) => ActionResult<D, A, Act, E>
        : Act extends { input: 'none' }
          ? () => ActionResult<D, A, Act, E>
          : (input: WithInput<D, W, Act, E>) => ActionResult<D, A, Act, E>

/**
 * An action that declares a `202`: `wait` polls the accepted job and resolves to the action's
 * value; without it the call may resolve to an {@link Accepted}.
 */
type AcceptedActionMethod<
  D extends ApiDescriptor,
  A,
  W,
  Act extends ActionDescriptor,
  E,
> = Act extends { input: 'none' }
  ? {
      (
        options: { signal?: AbortSignal } & ActionFilterOptions<Act> & WaitOptions,
      ): Promise<ActionValue<D, A, Act, E>>
      (
        options?: { signal?: AbortSignal; wait?: false } & ActionFilterOptions<Act>,
      ): ActionResult<D, A, Act, E>
    }
  : {
      (
        input: WithInput<D, W, Act, E>,
        options: { signal?: AbortSignal } & ActionFilterOptions<Act> & WaitOptions,
      ): Promise<ActionValue<D, A, Act, E>>
      (
        input: WithInput<D, W, Act, E>,
        options?: { signal?: AbortSignal; wait?: false } & ActionFilterOptions<Act>,
      ): ActionResult<D, A, Act, E>
    }

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
  update: UpdateMethod<D, A, W, T>
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
    const Cnt extends readonly CountToken<D, T>[] = [],
  >(
    query?: TypedReadQuery<D, T, Inc, F, Pg, Cnt>,
  ): Promise<Collection<ReadResult<D, A, T, Inc, F, Cnt[number]>, PageOf<D[T]['paginator'], Pg>>>
  get<const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
    id: string,
    query?: SingleReadQuery<D, T, Inc, F>,
  ): Promise<ReadResult<D, A, T, Inc, F>>
  create: CreateMethod<D, A, W, T>
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
  L = Record<never, never>,
> = {
  // Mapped over the descriptor's own keys so each member keeps the JSDoc the codegen writes there.
  -readonly [T in keyof D as Extract<T, string>]: TypeAccessor<
    D,
    WithLinks<A, L>,
    W,
    Extract<T, string>,
    Act
  >
} & {
  /**
   * Run an Atomic Operations batch (docs/atomic-operations.md): the
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
  ): Promise<
    Ops extends readonly AtomicHandle[] ? AtomicResults<D, WithLinks<A, L>, Ops> : AtomicResult[]
  >
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
