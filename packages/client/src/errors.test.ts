import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ApiDescriptor } from './descriptor'
import { type ErrorCodeGuard, hasErrorCode, JsonApiError, type JsonApiErrorObject } from './errors'
import type { Client, ErrorCodeOf } from './result-types'

describe('JsonApiError', () => {
  it('exposes expressive status matchers', () => {
    const err = new JsonApiError(403, [{ status: '403', code: 'FORBIDDEN' }])
    expect(err.isForbidden()).toBe(true)
    expect(err.is4xx()).toBe(true)
    expect(err.is5xx()).toBe(false)
    expect(err.hasStatus(403)).toBe(true)
  })

  it('groups validation errors by user-facing path', () => {
    const err = new JsonApiError(422, [
      { status: '422', source: { pointer: '/data/attributes/title' }, path: 'title' },
      { status: '422', source: { pointer: '/data/attributes/title' }, path: 'title' },
      { status: '422', source: { pointer: '/data/relationships/artist/data' }, path: 'artist' },
    ])

    const byPath = err.byPath()
    expect(err.isValidationError()).toBe(true)
    expect(byPath['title']).toHaveLength(2)
    expect(byPath['artist']).toHaveLength(1)
  })
})

type Code = 'ACCESS_DENIED' | 'PASSWORD_EXPIRED' | 'RESOURCE_NOT_FOUND'

describe('hasErrorCode', () => {
  const err = new JsonApiError<Code>(403, [
    { status: '403', code: 'ACCESS_DENIED' },
    { status: '403', code: 'PASSWORD_EXPIRED' },
    { status: '403' },
  ])

  it('matches when any of the error objects carries the code', () => {
    expect(hasErrorCode(err, 'ACCESS_DENIED')).toBe(true)
    expect(hasErrorCode(err, 'PASSWORD_EXPIRED')).toBe(true)
    expect(hasErrorCode(err, 'RESOURCE_NOT_FOUND')).toBe(false)
  })

  it('matches a code the server never documented', () => {
    const undocumented = new JsonApiError(409, [{ status: '409', code: 'APP_SPECIFIC' }])
    expect(hasErrorCode(undocumented, 'APP_SPECIFIC')).toBe(true)
  })

  it('is false for anything that is not a JsonApiError', () => {
    const lookalike = Object.assign(new Error('nope'), {
      status: 403,
      errors: [{ code: 'ACCESS_DENIED' }],
    })
    expect(hasErrorCode(lookalike, 'ACCESS_DENIED')).toBe(false)
    expect(hasErrorCode({ errors: [{ code: 'ACCESS_DENIED' }] }, 'ACCESS_DENIED')).toBe(false)
    expect(hasErrorCode(undefined, 'ACCESS_DENIED')).toBe(false)
    expect(hasErrorCode('ACCESS_DENIED', 'ACCESS_DENIED')).toBe(false)
  })

  it('binds to a code union: known codes narrow, unknown literals do not compile', () => {
    // How a generated client binds it.
    const bound = hasErrorCode as ErrorCodeGuard<Code>
    const caught: unknown = err

    if (bound(caught, 'PASSWORD_EXPIRED')) {
      expectTypeOf(caught).toEqualTypeOf<JsonApiError<Code>>()
      expectTypeOf(caught.errors).toEqualTypeOf<JsonApiErrorObject<Code>[]>()
      expectTypeOf(caught.errors[0]!.code).toEqualTypeOf<Code | (string & {}) | undefined>()
    }

    // @ts-expect-error a misspelt code is not in the union
    bound(caught, 'PASWORD_EXPIRED')
    // @ts-expect-error a plain string is not in the union either
    bound(caught, 'x' as string)
    // The unbound guard is the escape hatch for an undocumented code.
    expectTypeOf(hasErrorCode).parameter(1).toEqualTypeOf<string>()
  })
})

describe('error-code typing', () => {
  it('keeps code open: documented codes plus any other string', () => {
    const object: JsonApiErrorObject<Code> = { code: 'SOMETHING_ELSE' }
    expectTypeOf(object.code).toEqualTypeOf<Code | (string & {}) | undefined>()
    // The default stays a plain string, so untyped callers see no change.
    expectTypeOf<JsonApiErrorObject['code']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<JsonApiError['errors']>().toEqualTypeOf<JsonApiErrorObject[]>()
  })

  it('a typed error still assigns to the untyped one', () => {
    expectTypeOf<JsonApiError<Code>>().toMatchTypeOf<JsonApiError>()
  })

  it('reads the union back off a client type, defaulting to string', () => {
    type D = ApiDescriptor
    expectTypeOf<ErrorCodeOf<Client<D, unknown, unknown, unknown, Code>>>().toEqualTypeOf<Code>()
    expectTypeOf<ErrorCodeOf<Client<D>>>().toEqualTypeOf<string>()
    expectTypeOf<ErrorCodeOf<unknown>>().toEqualTypeOf<string>()
    expectTypeOf<ErrorCodeOf<{ albums: unknown }>>().toEqualTypeOf<string>()
  })
})
