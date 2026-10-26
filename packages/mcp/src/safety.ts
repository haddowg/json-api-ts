import { isObject, type OperationObject } from './openapi'

/** The vendor extension an action's operation declares its safety in. */
export const SAFETY_EXTENSION = 'x-safety'

/** What an action declares about itself. A flag it doesn't declare is absent. */
export interface ActionSafety {
  readOnly?: boolean
  destructive?: boolean
  idempotent?: boolean
}

/**
 * Read an action's declared safety from its operation. An operation without the extension, or
 * with one this package can't read, declares nothing.
 */
export function readActionSafety(operation: OperationObject): ActionSafety {
  const raw = operation[SAFETY_EXTENSION]
  const safety: ActionSafety = {}
  if (!isObject(raw)) {
    return safety
  }
  for (const key of ['readOnly', 'destructive', 'idempotent'] as const) {
    if (typeof raw[key] === 'boolean') {
      safety[key] = raw[key]
    }
  }
  return safety
}
