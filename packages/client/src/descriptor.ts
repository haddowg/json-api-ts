/**
 * The generated runtime descriptor (ADR 0001). The codegen emits one of these per
 * server `as const satisfies ApiDescriptor`; the client's TYPES are derived from it
 * (one source of truth). It carries everything the generic runtime needs that types
 * alone can't: attribute-vs-relation, cardinality, related type(s), per-operation
 * path templates (uriType/prefix-aware), paginator kind, and the create client-id
 * policy.
 */
export type Cardinality = 'one' | 'many'

export interface RelationDescriptor {
  cardinality: Cardinality
  /** Related JSON:API type(s); more than one = polymorphic. */
  types: readonly string[]
  /** Whether members carry pivot data (`meta.pivot`). */
  pivot?: boolean
}

export type PaginatorKind = 'page' | 'offset' | 'cursor' | 'none'

export type ClientIdPolicy = 'forbidden' | 'optional' | 'required'

export interface ResourceDescriptor {
  /** Attribute name -> wire format hint (drives optional value coercion). */
  attributes: Readonly<Record<string, string>>
  relations: Readonly<Record<string, RelationDescriptor>>
  /** Per-operation path templates, e.g. `{ fetchOne: '/albums/{id}' }`. */
  paths: Readonly<Record<string, string>>
  paginator: PaginatorKind
  clientId: ClientIdPolicy
}

export type ApiDescriptor = Readonly<Record<string, ResourceDescriptor>>
