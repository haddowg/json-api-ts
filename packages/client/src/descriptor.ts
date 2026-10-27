/**
 * The generated runtime descriptor (ADR 0001). The codegen emits one of these per
 * server `as const satisfies ApiDescriptor`; the client's TYPES are derived from it
 * (one source of truth). It carries everything the generic runtime needs that types
 * alone can't: attribute-vs-relation, cardinality, related type(s), per-operation
 * path templates (uriType/prefix-aware), paginator kind, and the create client-id
 * policy.
 */
export type Cardinality = 'one' | 'many'

/**
 * The mutation verbs a single relationship endpoint advertises (derived from the HTTP
 * methods it exposes). These are NOT uniform across relations — the bundle gates them
 * per relation (`cannotAdd`/`cannotRemove`/`cannotReplace`, per-relation endpoint
 * exposure) — so the descriptor carries the capability per relation and the fluent
 * surface gates `add`/`remove`/`replace`/`set` on it (see ADR 0001 follow-up).
 *
 * For a to-many: `add` <- POST, `remove` <- DELETE, `replace` <- PATCH.
 * For a to-one: `set` <- PATCH. A flag is `true` iff the endpoint advertises the verb.
 */
export interface RelationMutations {
  add?: boolean
  remove?: boolean
  replace?: boolean
  set?: boolean
}

/**
 * The pivot fields one side of the wire carries on a member's `meta.pivot`: field name to
 * wire-format hint (the vocabulary of {@link ResourceDescriptor.attributes}), the fields that
 * are always present, and the fields that may be `null`.
 */
export interface PivotDescriptor {
  fields: Readonly<Record<string, string>>
  /**
   * On a response, the fields every member renders; on a request, the fields every member must
   * send. Absent means every field.
   */
  required?: readonly string[]
  /** The fields whose value may be `null`. Absent means none. */
  nullable?: readonly string[]
}

export interface RelationDescriptor {
  cardinality: Cardinality
  /** Related JSON:API type(s). */
  types: readonly string[]
  /**
   * `true` when the relation is polymorphic: its linkage is a union of identifier types, even a
   * union of one (generator contract 16). Read this rather than counting {@link types}, so a
   * relation declared polymorphic over one type keeps its shape when a second type is added. A
   * descriptor without the flag, such as one generated from an older document or written by
   * hand, is polymorphic when it lists more than one type; see {@link isPolymorphic}.
   */
  polymorphic?: boolean
  /** Whether members carry pivot data (`meta.pivot`). */
  pivot?: boolean
  /**
   * The pivot fields carried on each member's `meta.pivot`, as a field-name → wire-format-hint
   * map, typed as always present and never `null` on both reads and writes (D33).
   *
   * @deprecated Describe each side with {@link readPivot} and {@link writePivot}. Read only when
   * those are absent.
   */
  pivotFields?: Readonly<Record<string, string>>
  /** The `meta.pivot` a response renders on each member (`<Type><Rel>Pivot`). */
  readPivot?: PivotDescriptor
  /**
   * The `meta.pivot` a request may send on each member (`<Type><Rel>WritePivot`): a create,
   * update or atomic body, or a relationship mutation.
   */
  writePivot?: PivotDescriptor
  /**
   * `true` for a relation create and update accept but no response renders. It stays settable
   * on write inputs and is left out of the read view, `fields` and the relationship reads.
   */
  writeOnly?: boolean
  /**
   * The relation's segment in its related and relationship paths, when it differs from the
   * relation's name (`/articles/{id}/published-by` for `publisher`). Absent means the name.
   */
  uriField?: string
  /**
   * `false` when the related endpoint (`GET /{type}/{id}/{rel}`) is suppressed for this relation
   * (the bundle's `withoutRelatedEndpoint()`, ADR 0027) — `.related()` is then a compile error /
   * runtime guard rather than a 404. Absent means exposed (the default).
   */
  related?: boolean
  /**
   * `false` when the relationship endpoint (`.../relationships/{rel}`) is suppressed for this
   * relation (the bundle's `withoutRelationshipEndpoint()`, ADR 0027) — `.get()` (and every
   * mutation) is then gated off. Absent means exposed (the default).
   */
  relationship?: boolean
  /**
   * The per-relation mutation verbs the relationship endpoint advertises. An explicit `{}` means
   * the endpoint exposes no mutation verb (gates every verb OFF). Absent means the descriptor
   * carries no signal (a hand-written descriptor) — gating then falls back to cardinality alone.
   * A codegen descriptor always emits this (at least `{}`) so suppression never fails open.
   */
  mutations?: RelationMutations
  /**
   * The `withCount` count tokens + negotiation profile this relation's related/relationship reads
   * advertise (`_self_` + the relation's own countable relations). Lets `.related()`/`.get()` send
   * `withCount` and negotiate the right profile; absent when the relation advertises no Countable
   * profile (D3).
   */
  countable?: CountableDescriptor
  /**
   * The paginator this relation's OWN related/relationship endpoints advertise
   * (`GET /{type}/{id}/{rel}` / `.../relationships/{rel}`), when it DIVERGES from the related
   * type's collection-level {@link ResourceDescriptor.paginator}. A related endpoint may paginate
   * differently than the related type's own collection (e.g. a cursor-paginated related to-many
   * whose target type is page-paginated at its top-level collection) — so the client resolves a
   * related/embedded to-many array's `$page.kind` from this per-relation value first, falling back
   * to the related type's collection paginator (D6a). Absent when the two agree (the common case).
   */
  paginator?: PaginatorDescriptor
}

/** A built-in pagination strategy. */
export type PaginatorStrategy = 'page' | 'offset' | 'cursor' | 'fixed'

/** The strategy that answers a read, or `none` for an unpaginated endpoint. */
export type PaginatorKind = PaginatorStrategy | 'none'

/**
 * A role a page parameter fills. `page`: number, size; `offset`: offset, limit; `cursor`: after,
 * before, size; `fixed`: number.
 */
export type PaginatorRole = 'number' | 'size' | 'offset' | 'limit' | 'after' | 'before'

/** A strategy whose roles are filled by renamed wire keys, e.g. `{ number: 'p', size: 'size' }`. */
export interface StrategyDescriptor {
  strategy: PaginatorStrategy
  keys: Readonly<Partial<Record<PaginatorRole, string>>>
}

/**
 * A MultiPaginator menu: the client picks an arm by its `kind` (sent as `page[kind]`), and the
 * server answers with `default` when the request names none. Arm keys are the `kind` values.
 */
export interface MenuDescriptor {
  strategy: 'multi'
  default: string
  arms: Readonly<Record<string, PaginatorStrategy | StrategyDescriptor>>
}

/**
 * How an endpoint paginates. A bare kind uses the canonical wire keys (`page[number]`,
 * `page[size]`, ...); a {@link StrategyDescriptor} names renamed keys; a {@link MenuDescriptor}
 * offers several strategies.
 */
export type PaginatorDescriptor = PaginatorKind | StrategyDescriptor | MenuDescriptor

export type ClientIdPolicy = 'forbidden' | 'optional' | 'required'

/** Where a custom action is invoked: collection-scoped (`/{type}/-actions/{name}`) or resource-scoped (`/{type}/{id}/-actions/{name}`). */
export type ActionScope = 'collection' | 'resource'

/** The body a custom action accepts: a JSON:API document, no body, or a raw (non-JSON:API) payload. */
export type ActionInput = 'document' | 'none' | 'raw'

/**
 * What a custom action returns: a JSON:API document (materialised into the resource view of its
 * {@link ActionDescriptor.outputType}), a meta-only document (its top-level `meta`), only the URL
 * of a location document (see {@link ActionDescriptor.location}), or nothing (a `204`).
 */
export type ActionOutput = 'document' | 'meta' | 'location' | 'none'

/**
 * An action that answers with a URL, such as a short-lived download link (generator contract 17).
 * Asked for JSON:API, the server answers `200` with a location document whose `links.location`
 * carries the URL, and the client returns that URL without following it.
 */
export interface ActionLocationDescriptor {
  /** The media type the action declares the URL serves, such as `text/csv`. */
  mediaType: string
}

/**
 * How the client reads or sends a body that is not JSON:API: `binary` as a `Blob` or
 * `ArrayBuffer`, `text` as a `string`, `json` as parsed JSON typed from the media type's schema.
 */
export type RawMediaKind = 'binary' | 'text' | 'json'

/**
 * How the client sends one of an action's request media types: a JSON:API `document` (the
 * action's usual document input), a `multipart` `FormData`, a `form` of URL-encoded fields, or a
 * {@link RawMediaKind}.
 */
export type InputMediaKind = RawMediaKind | 'document' | 'form' | 'multipart'

/** A media type an action answers with besides JSON:API, and how its body is read. */
export interface RawOutputMedia {
  mediaType: string
  kind: RawMediaKind
}

/** A media type an action accepts as its request body, and how the client sends it. */
export interface InputMedia {
  mediaType: string
  kind: InputMediaKind
}

/**
 * A custom action declared on a type (`#[AsJsonApiAction]`). The runtime reaches it via
 * `client.<type>.actions.<name>(...)` (collection scope) or
 * `client.<type>.id(id).actions.<name>(...)` (resource scope); `input`/`output` drive how the body
 * is sent and the response shaped (see CONTEXT.md "Write surface").
 */
export interface ActionDescriptor {
  scope: ActionScope
  /** The action path template (e.g. `/albums/{id}/-actions/reissue`). */
  path: string
  /**
   * The HTTP method the action is invoked over, upper-case (e.g. `PATCH`). Absent means `POST`
   * (the default) — so an action declaring a single non-POST method (`#[AsJsonApiAction(methods:
   * ['PATCH'])]`) stays reachable rather than being silently dropped.
   */
  method?: string
  input: ActionInput
  output: ActionOutput
  /**
   * The JSON:API type of a `document`-input action's body — lets the client accept FLAT input
   * (like `create`) and build the envelope + remap `422` pointers, rather than the caller
   * hand-building `{ data: { type, attributes } }`. Absent for `none`/`raw` inputs, or a bespoke
   * command document whose type isn't a registered resource (then the raw envelope is passed
   * through).
   */
  inputType?: string
  /**
   * The JSON:API type of a `document`-output action's primary resource — the client materialises
   * the response into that type's resource view (matching the read path), so the typed result is
   * `result.title`, not `result.data.attributes.title`. Absent for `meta`/`none` outputs.
   */
  outputType?: string
  /** Whether a `document`-output action returns a single resource (`one`) or a collection (`many`). */
  outputCardinality?: Cardinality
  /**
   * The declared request media type for a `raw`-input action (e.g. `application/octet-stream`),
   * sent verbatim as the `Content-Type` so the server accepts the non-JSON:API body. Absent for
   * `document` (the JSON:API media type) and `none` (no body) inputs.
   */
  contentType?: string
  /**
   * The media types the action can answer with besides JSON:API (generator contract 10), in the
   * document's order. The caller picks one with the `accept` option; without it the client asks
   * for JSON:API when {@link output} is a document or meta, else for the first of these. Absent
   * when the action answers only in JSON:API.
   */
  rawOutput?: readonly RawOutputMedia[]
  /**
   * The media types the action's request body may use, in the document's order, when it lists
   * more than one. The caller picks one with the `contentType` option; without it the client
   * sends JSON:API when listed, else the first of these. Absent for a single media type, which
   * {@link input} and {@link contentType} already describe.
   */
  inputMedia?: readonly InputMedia[]
  /**
   * Whether the action leaves the server's state unchanged, as its operation's `x-safety`
   * declares (generator contract 15). Absent when the server doesn't say.
   */
  readOnly?: boolean
  /** Whether the action may destroy data, as its `x-safety` declares. Absent when not declared. */
  destructive?: boolean
  /**
   * Whether sending the action twice has the same effect as sending it once, as its `x-safety`
   * declares. Absent when the server doesn't say.
   */
  idempotent?: boolean
  /**
   * The OAuth scopes the action needs, read from its operation's `security` (generator contract
   * 16). Absent when it needs none.
   */
  scopes?: readonly string[]
  /**
   * Present when the action answers with a URL in a location document (generator contract 17).
   * With {@link output} `location` that is all it answers with; with `document` or `meta` it
   * answers with either, and the client tells them apart by the document's shape. Absent for an
   * action that answers with a bare `303`, which the transport follows as before.
   */
  location?: ActionLocationDescriptor
}

/**
 * The `withCount` capability of a type's read endpoints (the Countable profile, core ADR
 * 0101). `tokens` are the count tokens a `withCount` query may carry (`_self_` counts the
 * collection itself; a relation name counts that relation per item); `profile` is the URI a
 * client must negotiate (in `Accept`) before the server honours `withCount` — else it is
 * rejected (400) under strict query-param validation. Absent when no read endpoint of the
 * type advertises `withCount`.
 */
export interface CountableDescriptor {
  tokens: readonly string[]
  profile: string
}

export interface ResourceDescriptor {
  /** Attribute name -> wire format hint (drives optional value coercion). */
  attributes: Readonly<Record<string, string>>
  relations: Readonly<Record<string, RelationDescriptor>>
  /** Per-operation path templates, e.g. `{ fetchOne: '/albums/{id}' }`. */
  paths: Readonly<Record<string, string>>
  paginator: PaginatorDescriptor
  clientId: ClientIdPolicy
  /**
   * The `withCount` count tokens + negotiation profile for this type's read endpoints.
   * Absent when no read endpoint advertises `withCount`.
   */
  countable?: CountableDescriptor
  /**
   * The relation paths the read endpoints accept in `include` — the exact enum the OpenAPI
   * document advertises, including nested dotted paths (`tracks.album`). Drives `include`
   * narrowing. Absent when the type advertises no includable relations (so `include` is then
   * a compile error, matching the server's `400 INCLUSION_NOT_ALLOWED`).
   */
  includable?: readonly string[]
  /**
   * The sort tokens the COLLECTION read accepts in `sort` — signed field names (`title`,
   * `-title`). Drives `sort` narrowing. Absent when the collection advertises no sorting (so
   * `sort` is then a compile error, matching the server's `400 SORTING_UNSUPPORTED`).
   */
  sortable?: readonly string[]
  /**
   * The filter keys the COLLECTION read accepts in `filter[...]`. Drives `filter` key narrowing
   * (values stay `unknown` — value shapes/operators vary per filter, out of scope for v0.1).
   * Absent when the collection advertises no filters (so any `filter` is then a compile error,
   * matching the server's `400 FILTERING_UNRECOGNIZED`).
   */
  filterable?: readonly string[]
  /** Custom actions declared on this type, keyed by action name. Absent/empty when none. */
  actions?: Readonly<Record<string, ActionDescriptor>>
  /**
   * The OAuth scopes each of the type's operations needs, read from the operation's `security`
   * (generator contract 16). Keyed like {@link ResourceExamples.operations}: `fetchCollection`,
   * `fetchOne`, `create`, `update`, `delete`, and per relation `fetchRelated.<relation>`,
   * `fetchRelationship.<relation>`, `updateRelationship.<relation>`,
   * `addRelationship.<relation>` and `removeRelationship.<relation>`. An operation that needs
   * no scope has no entry, and the map is absent when none does. An action's scopes are on its
   * {@link ActionDescriptor.scopes}.
   */
  scopes?: Readonly<Record<string, readonly string[]>>
}

export type ApiDescriptor = Readonly<Record<string, ResourceDescriptor>>

/**
 * Whether a relation is polymorphic: flagged {@link RelationDescriptor.polymorphic}, or, when the
 * flag is absent, listing more than one related type.
 */
export function isPolymorphic(
  relation: Pick<RelationDescriptor, 'polymorphic' | 'types'>,
): boolean {
  return relation.polymorphic ?? relation.types.length > 1
}

/**
 * The server-level Atomic Operations capability (ADR 0001): the single `/operations`
 * endpoint, detected when its requestBody uses the atomic ext media type. `null` when the
 * server exposes no atomic endpoint. Carried alongside the per-type descriptor (not inside
 * it — atomic is server-level, not per-type) so the runtime `client.atomic` builder can
 * reach the path.
 */
export interface AtomicDescriptor {
  path: string
  /** The OAuth scopes the endpoint itself needs (generator contract 16). Absent when none. */
  scopes?: readonly string[]
}

/** Example bodies keyed by the media type they are declared for, such as `application/vnd.api+json`. */
export type MediaExamples = Readonly<Record<string, unknown>>

/**
 * The worked examples one operation declares (generator contract 12): its request body, and its
 * success responses keyed by status code. Each body is the whole wire document, not the flat input
 * or materialised result the client works with. A part the document gives no example for is absent.
 */
export interface OperationExamples {
  request?: MediaExamples
  responses?: Readonly<Record<string, MediaExamples>>
}

/**
 * The examples of one type's operations. `operations` is keyed by the operation's name in core's
 * terms, its `operationId` without the type: `fetchCollection`, `fetchOne`, `create`, `update`,
 * `delete`, and per relation `fetchRelated.<relation>`, `fetchRelationship.<relation>`,
 * `updateRelationship.<relation>`, `addRelationship.<relation>` and
 * `removeRelationship.<relation>`. `actions` is keyed by action name, as
 * {@link ResourceDescriptor.actions} is.
 */
export interface ResourceExamples {
  operations?: Readonly<Record<string, OperationExamples>>
  actions?: Readonly<Record<string, OperationExamples>>
}

/** The operation examples of every type that has one, keyed by wire type. */
export type ApiExamples = Readonly<Record<string, ResourceExamples>>
