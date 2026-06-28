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

export interface RelationDescriptor {
  cardinality: Cardinality
  /** Related JSON:API type(s); more than one = polymorphic. */
  types: readonly string[]
  /** Whether members carry pivot data (`meta.pivot`). */
  pivot?: boolean
  /**
   * The per-relation mutation verbs the relationship endpoint advertises. Absent when
   * the relation exposes no relationship endpoint at all (no mutation possible).
   */
  mutations?: RelationMutations
}

export type PaginatorKind = 'page' | 'offset' | 'cursor' | 'none'

export type ClientIdPolicy = 'forbidden' | 'optional' | 'required'

/** Where a custom action is invoked: collection-scoped (`/{type}/-actions/{name}`) or resource-scoped (`/{type}/{id}/-actions/{name}`). */
export type ActionScope = 'collection' | 'resource'

/** The body a custom action accepts: a JSON:API document, no body, or a raw (non-JSON:API) payload. */
export type ActionInput = 'document' | 'none' | 'raw'

/** What a custom action returns: a JSON:API document (materialised) or nothing (a `204`). */
export type ActionOutput = 'document' | 'none'

/**
 * A custom action declared on a type (`#[AsJsonApiAction]`), invoked over `POST`. The
 * runtime reaches it via `client.<type>.actions.<name>(...)` (collection scope) or
 * `client.<type>.id(id).actions.<name>(...)` (resource scope); `input`/`output` drive
 * how the body is sent and the response shaped (see CONTEXT.md "Write surface").
 */
export interface ActionDescriptor {
  scope: ActionScope
  /** The action path template (e.g. `/albums/{id}/-actions/reissue`). */
  path: string
  input: ActionInput
  output: ActionOutput
  /**
   * The declared request media type for a `raw`-input action (e.g. `application/octet-stream`),
   * sent verbatim as the `Content-Type` so the server accepts the non-JSON:API body. Absent for
   * `document` (the JSON:API media type) and `none` (no body) inputs.
   */
  contentType?: string
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
  paginator: PaginatorKind
  clientId: ClientIdPolicy
  /**
   * The `withCount` count tokens + negotiation profile for this type's read endpoints.
   * Absent when no read endpoint advertises `withCount`.
   */
  countable?: CountableDescriptor
  /** Custom actions declared on this type, keyed by action name. Absent/empty when none. */
  actions?: Readonly<Record<string, ActionDescriptor>>
}

export type ApiDescriptor = Readonly<Record<string, ResourceDescriptor>>

/**
 * The server-level Atomic Operations capability (ADR 0001): the single `/operations`
 * endpoint, detected when its requestBody uses the atomic ext media type. `null` when the
 * server exposes no atomic endpoint. Carried alongside the per-type descriptor (not inside
 * it — atomic is server-level, not per-type) so the runtime `client.atomic` builder can
 * reach the path.
 */
export interface AtomicDescriptor {
  path: string
}
