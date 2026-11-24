import type { AbstractControl, ValidationErrors } from '@angular/forms'
import type { FieldError, FieldErrors } from '@haddowg/json-api-client'

/**
 * Put each of `fe`'s errors on the control of `form` its path names, as a `server` error holding
 * the first message for that input, and mark the control touched so a template showing errors on
 * touched controls shows it. Errors on no input, and errors whose path names no control, go on
 * `form` itself as its `server` error and come back, so the page can show them elsewhere.
 *
 * The next validation run of a control, such as on its next value change, clears its `server`
 * error.
 *
 * ```ts
 * this.create.mutate(this.form.getRawValue(), {
 *   onError: (error) => applyServerErrors(this.form, fieldErrors(error)),
 * })
 * ```
 */
export function applyServerErrors<C extends string>(
  form: AbstractControl,
  fe: FieldErrors<unknown, C> | undefined,
): FieldError<C>[] {
  if (fe === undefined) {
    return []
  }
  const unplaced: FieldError<C>[] = [...fe.form]
  for (const issues of Object.values(fe.fields)) {
    const first = issues[0]!
    const control = form.get(first.path as (string | number)[])
    if (control === null) {
      unplaced.push(...issues)
      continue
    }
    setServerError(control, first.message)
    control.markAsTouched()
  }
  if (unplaced.length > 0) {
    setServerError(form, unplaced[0]!.message)
  }
  return unplaced
}

function setServerError(control: AbstractControl, message: string): void {
  const errors: ValidationErrors = { ...control.errors, server: message }
  control.setErrors(errors)
}
