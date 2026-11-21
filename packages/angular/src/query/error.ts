import * as i0 from '@angular/core'
import { Pipe, type PipeTransform } from '@angular/core'
import { type ErrorCodeOf, JsonApiError, type StructuralGuardError } from '@haddowg/json-api-client'
import type { RegisteredClient } from '../provide'

/**
 * A partial declaration's argument. Core's facade types leave out `minVersion` and `version`, which
 * only the linker reads, so each literal is asserted to the facade.
 */
type Declaration<F extends (decl: never) => unknown> = Parameters<F>[0]

/** The error codes of the default client {@link Register} declares (`string` when none). */
export type RegisteredErrorCode = ErrorCodeOf<RegisteredClient>

/**
 * What a typed JSON:API read or write fails with, or nothing: the shape `error()` has on a query
 * built from `injectJsonApiReads()`'s factories.
 */
type TypedError<E extends string> =
  | JsonApiError<E>
  | StructuralGuardError
  | Error
  | null
  | undefined

/** The codes `E` carries, or the registered client's when `E` is just `string`. */
type CodesOf<E extends string> = string extends E ? RegisteredErrorCode : E

/**
 * The error when it is a {@link JsonApiError}, else `undefined`. Given a typed read's or write's
 * `error()` it keeps its error codes; given anything else (`unknown`) it types the codes by the
 * default client's `Register`. For another client's codes, pass them:
 * `asJsonApiError<ErrorCodeOf<AdminClient>>(error)`.
 */
export function asJsonApiError<E extends string>(
  error: TypedError<E>,
): JsonApiError<CodesOf<E>> | undefined
export function asJsonApiError<E extends string = RegisteredErrorCode>(
  error: unknown,
): JsonApiError<E> | undefined
export function asJsonApiError(error: unknown): JsonApiError | undefined {
  return error instanceof JsonApiError ? error : undefined
}

/**
 * `jsonApiError`: narrows a query's or mutation's `error()` to the {@link JsonApiError} it carries,
 * or `undefined`, so a template can reach its error objects without `instanceof`:
 *
 * ```html
 * @if (rename.error() | jsonApiError; as error) {
 *   {{ error.byPath()['name']?.[0]?.detail }}
 * }
 * ```
 *
 * The codes are typed as {@link asJsonApiError} types them: a typed read's own, else the default
 * client's. Standalone and pure: add it to a component's `imports`.
 */
export class JsonApiErrorPipe implements PipeTransform {
  transform<E extends string>(error: TypedError<E>): JsonApiError<CodesOf<E>> | undefined
  transform(error: unknown): JsonApiError<RegisteredErrorCode> | undefined
  transform(error: unknown): JsonApiError | undefined {
    return asJsonApiError(error)
  }

  // What the Angular compiler emits for `@Pipe({ name: 'jsonApiError' })` in partial compilation
  // mode (as ng-packagr builds a library), written by hand since this package isn't built by it. An
  // app's build links these declarations into definitions for its own Angular version, and JIT (as
  // in tests) compiles them through `@angular/compiler`. `minVersion` is the oldest Angular whose
  // linker reads each declaration (14 for a standalone pipe); `version` is the compiler release the
  // declarations were taken from. The declared types are what an app's compiler reads from the
  // `.d.ts` to type-check the pipe in templates.
  static ɵfac: i0.ɵɵFactoryDeclaration<JsonApiErrorPipe, never> = i0.ɵɵngDeclareFactory({
    minVersion: '12.0.0',
    version: '21.2.25',
    ngImport: i0,
    type: JsonApiErrorPipe,
    deps: [],
    target: i0.ɵɵFactoryTarget.Pipe,
  } as Declaration<typeof i0.ɵɵngDeclareFactory>) as i0.ɵɵFactoryDeclaration<
    JsonApiErrorPipe,
    never
  >

  static ɵpipe: i0.ɵɵPipeDeclaration<JsonApiErrorPipe, 'jsonApiError', true> = i0.ɵɵngDeclarePipe({
    minVersion: '14.0.0',
    version: '21.2.25',
    ngImport: i0,
    type: JsonApiErrorPipe,
    isStandalone: true,
    name: 'jsonApiError',
  } as Declaration<typeof i0.ɵɵngDeclarePipe>) as i0.ɵɵPipeDeclaration<
    JsonApiErrorPipe,
    'jsonApiError',
    true
  >
}

i0.ɵɵngDeclareClassMetadata({
  minVersion: '12.0.0',
  version: '21.2.25',
  ngImport: i0,
  type: JsonApiErrorPipe,
  decorators: [{ type: Pipe, args: [{ name: 'jsonApiError' }] }],
} as Declaration<typeof i0.ɵɵngDeclareClassMetadata>)
