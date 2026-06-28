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
import type { ApiDescriptor, Cardinality } from './descriptor'
import type {
  ArrayEnvelope,
  DocumentEnvelope,
  Edge,
  RelationView,
  ResourceLinks,
} from './materialise'
import type { ResourceIdentifier } from './types'

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
 * identifiers (no nested-include narrowing in the read API today).
 */
export type HydratedMember<
  D extends ApiDescriptor,
  A,
  TType extends TypeName<D>,
> = ResourceObjectView<D, A, TType, never> & EdgeMembers

/** A hydrated related value distributes over a polymorphic union of related types. */
type Hydrated<D extends ApiDescriptor, A, TType extends TypeName<D>> =
  TType extends TypeName<D> ? HydratedMember<D, A, TType> : never

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
> = R extends Inc
  ? IsMany<D, T, R> extends true
    ? Collection<Hydrated<D, A, RelatedType<D, T, R>>>
    : Hydrated<D, A, RelatedType<D, T, R>> | null
  : IsMany<D, T, R> extends true
    ? Collection<Identifier<RelatedType<D, T, R>>>
    : Identifier<RelatedType<D, T, R>> | null | undefined

/** The relation slots of type `T`, each typed by cardinality and include-presence. */
type Relations<D extends ApiDescriptor, A, T extends TypeName<D>, Inc> = {
  [R in RelationName<D, T>]: RelationValue<D, A, T, R, Inc>
}

/**
 * A materialised resource object: flattened `type` + `id` + attributes + relation slots
 * as own enumerable props, intersected with the resource-level `$`-accessors. `Inc` is
 * the union of relation names included by the read (narrows relations to hydrated).
 */
export type ResourceObjectView<D extends ApiDescriptor, A, T extends TypeName<D>, Inc = never> = {
  type: T
  id: string
} & AttributesOf<A, T> &
  Relations<D, A, T, Inc> &
  ResourceAccessors

/**
 * The element type of the `include` array for type `T`: a relation name, optionally a
 * dotted child path (`relation.child`). Children are accepted (the wire supports them)
 * but only the top-level relation drives narrowing today — see the TODO on the read
 * methods.
 */
export type IncludePath<D extends ApiDescriptor, T extends TypeName<D>> =
  | RelationName<D, T>
  | `${RelationName<D, T>}.${string}`

/** The union of top-level relation names present in an `include` tuple (drops dotted children). */
export type IncludedRelations<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[],
> = Extract<Inc[number] extends `${infer Head}.${string}` ? Head : Inc[number], RelationName<D, T>>

/** A read query carrying a typed, narrowing `include` plus the loose JSON:API query families. */
export interface TypedReadQuery<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[],
> {
  /** The relations to include — drives static narrowing; constrained to declared paths. */
  include?: Inc
  filter?: Record<string, unknown>
  sort?: string | readonly string[]
  fields?: Record<string, readonly string[]>
  page?: Record<string, unknown>
}

/**
 * The static return type of a read on type `T` given its `include` tuple — the resource
 * object with the named relations narrowed to hydrated.
 */
export type ReadResult<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  Inc extends readonly IncludePath<D, T>[] = [],
> = ResourceObjectView<D, A, T, IncludedRelations<D, T, Inc>>

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
 * (PATCH). Write methods exist on every relation at the type level but the runtime routes
 * by cardinality (a `.set` on a to-many / `.add` on a to-one is a type error caught here).
 * A write returns the materialised linkage, or `void` when the server replies `204`.
 */
export interface RelationshipAccessor<
  D extends ApiDescriptor,
  A,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
> {
  get(query?: RelationReadQuery): Promise<LinkageValue<D, T, R>>
  related(query?: RelationReadQuery): Promise<RelatedValue<D, A, T, R>>
  add: RelationMutation<D, T, R, 'many', readonly LinkageRefOf<RelatedType<D, T, R>>[]>
  remove: RelationMutation<D, T, R, 'many', readonly LinkageRefOf<RelatedType<D, T, R>>[]>
  replace: RelationMutation<D, T, R, 'many', readonly LinkageRefOf<RelatedType<D, T, R>>[]>
  set: RelationMutation<D, T, R, 'one', LinkageRefOf<RelatedType<D, T, R>> | null>
}

/**
 * A relationship-mutation method, gated by cardinality: present (typed `(refs) => Promise<…>`)
 * only when the relation's cardinality matches `Kind` (`add`/`remove`/`replace` -> to-many,
 * `set` -> to-one); otherwise `never`, so calling the wrong verb for the cardinality is a
 * compile error. The result is the materialised linkage value or `void` (a `204` response).
 *
 * NOTE: gating is by cardinality only — a relation that forbids a specific verb (the bundle's
 * `cannotReplace` / per-relation endpoint exposure) is NOT yet caught here; an unsupported
 * verb surfaces as a server error. See docs/PLAN.md "Tracked follow-ups" (deferred from 3a).
 */
type RelationMutation<
  D extends ApiDescriptor,
  T extends TypeName<D>,
  R extends RelationName<D, T>,
  Kind extends Cardinality,
  Refs,
> = D[T]['relations'][R]['cardinality'] extends Kind
  ? (refs: Refs) => Promise<LinkageValue<D, T, R> | void>
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
 * identifier `{ type, id }`, OR a materialised resource object (its `type`/`id` are
 * extracted by the runtime). A to-many member may additionally carry `$pivot`.
 */
export type LinkageRef<TType extends string> =
  | (ResourceIdentifier<TType> & { $pivot?: PivotInput })
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
> {
  include?: Inc
  fields?: Record<string, readonly string[]>
}

/**
 * A resource handle (no fetch) for a known id. Carries the read surface (`get`), the writes
 * scoped to a known id (`update`/`delete`), a relationship accessor per declared relation (by
 * name), and a universal `.rel(name)` fallback (for relations whose name collides with a
 * reserved member like `get`/`update`/`rel`). `W` is the generated write-attribute map.
 */
export type ResourceHandle<D extends ApiDescriptor, A, W, T extends TypeName<D>> = {
  readonly type: T
  readonly id: string
  get<const Inc extends readonly IncludePath<D, T>[] = []>(
    query?: TypedReadQuery<D, T, Inc>,
  ): Promise<ReadResult<D, A, T, Inc>>
  update<const Inc extends readonly IncludePath<D, T>[] = []>(
    patch: UpdateInput<D, W, T>,
    opts?: WriteOptions<D, T, Inc>,
  ): Promise<ReadResult<D, A, T, Inc>>
  delete(): Promise<void>
  rel<R extends RelationName<D, T>>(name: R): RelationshipAccessor<D, A, T, R>
} & RelationshipAccessors<D, A, T>

/** The collection-scoped accessor for one wire type (`client.albums`). */
export interface TypeAccessor<D extends ApiDescriptor, A, W, T extends TypeName<D>> {
  list<const Inc extends readonly IncludePath<D, T>[] = []>(
    query?: TypedReadQuery<D, T, Inc>,
  ): Promise<Collection<ReadResult<D, A, T, Inc>>>
  get<const Inc extends readonly IncludePath<D, T>[] = []>(
    id: string,
    query?: TypedReadQuery<D, T, Inc>,
  ): Promise<ReadResult<D, A, T, Inc>>
  create<const Inc extends readonly IncludePath<D, T>[] = []>(
    input: CreateInput<D, W, T>,
    opts?: WriteOptions<D, T, Inc>,
  ): Promise<ReadResult<D, A, T, Inc>>
  id(id: string): ResourceHandle<D, A, W, T>
}

/**
 * The descriptor-driven client surface: one {@link TypeAccessor} per wire type. `W` is the
 * generated `WriteAttributes` map (per-type `{ create; update }` attribute pairs); it threads
 * through to the write surface and defaults so read-only callers compile.
 */
export type Client<
  D extends ApiDescriptor,
  A = DefaultAttributes<D>,
  W = DefaultWriteAttributes<D>,
> = {
  [T in TypeName<D>]: TypeAccessor<D, A, W, T>
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
