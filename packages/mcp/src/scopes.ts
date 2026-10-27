import type { McpOperation, McpOperationKind } from './types'

/** The descriptor's key for each kind's operation in a type's `scopes`. */
const SCOPE_KEYS: Readonly<Record<Exclude<McpOperationKind, 'related' | 'action'>, string>> = {
  list: 'fetchCollection',
  get: 'fetchOne',
  create: 'create',
  update: 'update',
  delete: 'delete',
}

/** The scopes the descriptor says an operation needs, or `undefined` when it names none. */
export function descriptorScopes(
  op: Pick<McpOperation, 'kind' | 'relation' | 'resource' | 'actionDescriptor'>,
): readonly string[] | undefined {
  let scopes: readonly string[] | undefined
  if (op.kind === 'action') {
    scopes = op.actionDescriptor?.scopes
  } else if (op.kind === 'related') {
    scopes = op.resource.scopes?.[`fetchRelated.${op.relation ?? ''}`]
  } else {
    scopes = op.resource.scopes?.[SCOPE_KEYS[op.kind]]
  }
  return scopes === undefined || scopes.length === 0 ? undefined : scopes
}
