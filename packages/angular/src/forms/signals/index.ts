/**
 * @haddowg/json-api-angular/forms/signals: show a JSON:API write's errors on an Angular Signal
 * Form. Signal Forms are experimental in Angular 21, so this entry point may change with them.
 */
import type { FieldTree, ValidationError } from '@angular/forms/signals'
import type { FieldErrors, PathSegment } from '@haddowg/json-api-client'

/** A server error as a Signal Form takes it from a `submit()` action. */
export interface ServerValidationError extends ValidationError {
  readonly kind: 'server'
  readonly message: string
  readonly fieldTree?: FieldTree<unknown>
}

/**
 * `fe`'s errors as a `submit()` action returns them: each on the field its path names, and an
 * error on no input, or on a path that names no field, without a field, so it lands on the form.
 *
 * ```ts
 * submit(this.form, async () => {
 *   try {
 *     await this.client.albums.create(this.model())
 *     return undefined
 *   } catch (error) {
 *     return serverErrors(this.form, fieldErrors(error))
 *   }
 * })
 * ```
 */
export function serverErrors<M>(
  form: FieldTree<M>,
  fe: FieldErrors | undefined,
): ServerValidationError[] {
  if (fe === undefined) {
    return []
  }
  return fe.issues.map((issue) => {
    const fieldTree = issue.path.length === 0 ? undefined : fieldAt(form, issue.path)
    return { kind: 'server', message: issue.message, ...(fieldTree && { fieldTree }) }
  })
}

// A field tree exposes each child field as a property, and each array item by index.
function fieldAt(
  form: FieldTree<unknown>,
  path: readonly PathSegment[],
): FieldTree<unknown> | undefined {
  let node: unknown = form
  for (const segment of path) {
    if (node === undefined || node === null) {
      return undefined
    }
    node = (node as Record<string | number, unknown>)[segment]
  }
  return node === undefined || node === null ? undefined : (node as FieldTree<unknown>)
}
