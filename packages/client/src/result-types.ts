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
import type { ActionDescriptor, ApiDescriptor } from './descriptor'
import type {
  ArrayEnvelope,
  DocumentEnvelope,
  Edge,
  RelationView,
  ResourceLinks,
} from './materialise'
import type { LocalIdentifier, ResourceIdentifier } from './types'

/**
 * An augmented array (CONTEXT.md "To-many relationship values are augmented arrays"):
 * a real, read-only `T[]` carrying the non-enumerable relationship-level envelope
 * (`$page`/`$links`/`$meta`) plus link-driven `$next()`/`$prev()` navigation. The same
 * model backs top-level collections, related-endpoint collections, and hydrated/linkage
 * to-many relationship values ("one model, three surfaces").
 */
export type Collection<T> = ReadonlyArray<T> &
  Omit<ArrayEnvelope, '$next' | '$prev'> & {
    $next(): Promise<Collection<T> | undefined>
    $prev(): Promise<Collection<T> | undefined>
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
 * The bare resource-identifier shape a non-included (but linked) relation takes,
 * carrying the per-edge `$edge`/`$pivot` accessors the runtime attaches to every
 * materialised related value.
 */
export type IdentifierMember<TType extends string> = ResourceIdentifier<TType> & EdgeMembers

/**
 * A hydrated related resource: a per-edge VIEW — the full `ResourceObjectView` of the
 * related node plus this membership's `$edge`/`$pivot`. Relations one hop deep stay as
 * identifiers (no nested-include narrowing in the read API today). The fieldset map `F`
 * threads through so a sparse fieldset on the included type narrows its attributes/relations.
 */
export type HydratedMember<
  D extends ApiDescriptor,
  A,
  TType extends TypeName<D>,
  F = unknown,
> = ResourceObjectView<D, A, TType, never, F> & EdgeMembers

/** A hydrated related value distributes over a polymorphic union of related types. */
type Hydrated<D extends ApiDescriptor, A, TType extends TypeName<D>, F = unknown> =
  TType extends TypeName<D> ? HydratedMember<D, A, TType, F> : never

/** An identifier related value distributes over a polymorphic union of related types. */
type Identifier<TType extends string> = TType extends string ? IdentifierMember<TType> : never

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
    ? Collection<Hydrated<D, A, RelatedType<D, T, R>, F>>
    : Hydrated<D, A, RelatedType<D, T, R>, F> | null
  : IsMany<D, T, R> extends true
    ? Collection<Identifier<RelatedType<D, T, R>>>
    : Identifier<RelatedType<D, T, R>> | null | undefined

/**
 * The relation slots of type `T`, each typed by cardinality and include-presence, then
 * narrowed to the fieldset selection for `T` (relations are sparse-fieldset members too — an
 * unrequested relation is statically absent).
 */
type Relations<D extends ApiDescriptor, A, T extends TypeName<D>, Inc, F = unknown> = PickSelected<
  {
    [R in RelationName<D, T>]: RelationValue<D, A, T, R, Inc, F>
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
 * `attributes` keys) or a relation name. The descriptor carries the literal member names, so
 * `fields` entries are constrained to real members.
 */
export type MemberName<D extends ApiDescriptor, T extends TypeName<D>> =
  | Extract<keyof D[T]['attributes'], string>
  | RelationName<D, T>

/**
 * A read query carrying a typed, narrowing `include`, a typed `fields` (drives sparse-fieldset
 * return narrowing), a `withCount` constrained to the type's count tokens, plus the loose
 * JSON:API query families. `Inc`/`F` are inferred (as `const`) at the call site. Used for the
 * COLLECTION read (`list`); the single-resource read (`get`) uses {@link SingleReadQuery}, which
 * drops `withCount` (no `GET /{type}/{id}` endpoint advertises it).
 */
export interface TypedReadQuery<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[],
  F extends FieldsMap<D> = FieldsMap<D>,
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
  page?: Record<string, unknown>
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

/** A loose read query (filter/sort/include/fields/page) for the relationship/related endpoints. */
export interface RelationReadQuery {
  filter?: Record<string, unknown>
  sort?: string | readonly string[]
  include?: readonly string[]
  fields?: Record<string, readonly string[]>
  page?: Record<string, unknown>
}

/**
 * A hydrated related VALUE for relation `R` of type `T`, resolved by cardinality over the
 * (possibly polymorphic) related type(s): a `Collection` of hydrated members for to-many,
 * the hydrated member (or `null`) for to-one.
 */
type RelatedValue<D extends ApiDescriptor, A, T extends TypeName<D>, R extends RelationName<D, T>> =
  IsMany<D, T, R> extends true
    ? Collection<Hydrated<D, A, RelatedType<D, T, R>>>
    : Hydrated<D, A, RelatedType<D, T, R>> | null

/**
 * A linkage VALUE for relation `R` (the `/relationships/{rel}` endpoint, identifiers only):
 * a `Collection` of identifier members for to-many, a single identifier (or `null`) for to-one.
 */
type LinkageValue<D extends ApiDescriptor, T extends TypeName<D>, R extends RelationName<D, T>> =
  IsMany<D, T, R> extends true
    ? Collection<Identifier<RelatedType<D, T, R>>>
    : Identifier<RelatedType<D, T, R>> | null

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
  get: ExposesRelationship<D, T, R> extends true
    ? (query?: RelationReadQuery) => Promise<LinkageValue<D, T, R>>
    : never
  related: ExposesRelated<D, T, R> extends true
    ? (query?: RelationReadQuery) => Promise<RelatedValue<D, A, T, R>>
    : never
  add: RelationMutation<D, T, R, 'add', readonly LinkageRefOf<RelatedType<D, T, R>>[]>
  remove: RelationMutation<D, T, R, 'remove', readonly LinkageRefOf<RelatedType<D, T, R>>[]>
  replace: RelationMutation<D, T, R, 'replace', readonly LinkageRefOf<RelatedType<D, T, R>>[]>
  set: RelationMutation<D, T, R, 'set', LinkageRefOf<RelatedType<D, T, R>> | null>
}

/**
 * True unless relation `R`'s related endpoint is suppressed (`related: false`, the bundle's
 * `withoutRelatedEndpoint()`). Absent flag ⇒ exposed (the default / a hand-written descriptor).
 */
type ExposesRelated<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = D[T]['relations'][R] extends { related: false } ? false : true

/**
 * True unless relation `R`'s relationship endpoint is suppressed (`relationship: false`, the
 * bundle's `withoutRelationshipEndpoint()`). Absent flag ⇒ exposed (the default).
 */
type ExposesRelationship<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> = D[T]['relations'][R] extends { relationship: false } ? false : true

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
 * Writable pivot data carried on a to-many member as `$pivot` (a belongsToMany relation
 * with `pivot: true`). Loose by design — the OpenAPI write attributes don't model per-edge
 * pivot fields, so the runtime passes the object through as `meta.pivot`.
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
 * to-one accepts a single ref or `null` (clear); to-many accepts an array of refs.
 */
type RelationInput<D extends ApiDescriptor, T extends TypeName<D>, R extends RelationName<D, T>> =
  IsMany<D, T, R> extends true
    ? readonly LinkageRefOf<RelatedType<D, T, R>>[]
    : LinkageRefOf<RelatedType<D, T, R>> | null

/** The relationship slots of type `T` as optional write input keys (one per declared relation). */
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

/**
 * A single custom-action method, typed by its declared `input` mode:
 *
 * - `none`  — no argument;
 * - `document` — FLAT input (the `inputType`'s {@link CreateInput}, so the client builds the
 *   envelope + remaps `422` pointers like `create`); falls back to the generated
 *   {@link ActionInputBody} for a bespoke command document with no resolvable `inputType`;
 * - `raw`   — an arbitrary body (sent with a relaxed content type).
 *
 * The result is shaped by the action's `output` (see {@link ActionResult}).
 */
type ActionMethod<D extends ApiDescriptor, A, W, Act extends ActionDescriptor, E> = Act extends {
  input: 'none'
}
  ? () => ActionResult<D, A, Act, E>
  : Act extends { input: 'document' }
    ? Act extends { inputType: infer IT extends TypeName<D> }
      ? (input: CreateInput<D, W, IT>) => ActionResult<D, A, Act, E>
      : (input: ActionInputBody<E>) => ActionResult<D, A, Act, E>
    : (input: unknown) => ActionResult<D, A, Act, E>

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
  [N in ActionNameAtScope<D, T, Scope>]: ActionsOf<D, T>[N] extends ActionDescriptor
    ? ActionMethod<D, A, W, ActionsOf<D, T>[N], ActionTypesFor<Act, T, N>>
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
  list<const Inc extends readonly IncludePath<D, T>[] = [], const F extends FieldsMap<D> = {}>(
    query?: TypedReadQuery<D, T, Inc, F>,
  ): Promise<Collection<ReadResult<D, A, T, Inc, F>>>
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
 * default so read-only / codegen-less callers compile.
 */
export type Client<
  D extends ApiDescriptor,
  A = DefaultAttributes<D>,
  W = DefaultWriteAttributes<D>,
  Act = DefaultActionTypes,
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
}

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
