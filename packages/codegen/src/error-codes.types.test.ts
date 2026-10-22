import { type ErrorCodeOf, JsonApiError } from '@haddowg/json-api-client'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  createClient,
  type ErrorCode,
  type ErrorCodeByStatus,
  ErrorCodes,
  hasErrorCode,
} from '../test/generated/music-catalog.client.gen'

// Type-level checks against the committed generated client: the bound guard takes only the
// server's documented codes and narrows to an error typed by them.
describe('generated error codes', () => {
  it('narrows a caught error by a documented code', () => {
    const caught: unknown = new JsonApiError(404, [{ status: '404', code: 'RESOURCE_NOT_FOUND' }])

    expect(hasErrorCode(caught, 'RESOURCE_NOT_FOUND')).toBe(true)
    if (hasErrorCode(caught, 'RESOURCE_NOT_FOUND')) {
      expectTypeOf(caught).toEqualTypeOf<JsonApiError<ErrorCode>>()
    }

    // @ts-expect-error a misspelt code is a compile error
    hasErrorCode(caught, 'RESOURCE_NOT_FOUN')
  })

  it('takes a member of the ErrorCodes object', () => {
    const caught: unknown = new JsonApiError(404, [{ status: '404', code: 'RESOURCE_NOT_FOUND' }])

    expect(ErrorCodes.RESOURCE_NOT_FOUND).toBe('RESOURCE_NOT_FOUND')
    expect(hasErrorCode(caught, ErrorCodes.RESOURCE_NOT_FOUND)).toBe(true)
    expectTypeOf(ErrorCodes.RESOURCE_NOT_FOUND).toEqualTypeOf<'RESOURCE_NOT_FOUND'>()
    expectTypeOf<ErrorCode>().toEqualTypeOf<(typeof ErrorCodes)[keyof typeof ErrorCodes]>()
    // @ts-expect-error not a documented code
    void ErrorCodes.RESOURCE_NOT_FOUN
  })

  it('types the per-status map and carries the union on the client type', () => {
    expectTypeOf<ErrorCodeByStatus[404]>().toMatchTypeOf<ErrorCode>()
    expectTypeOf<'RESOURCE_NOT_FOUND'>().toMatchTypeOf<ErrorCodeByStatus[404]>()
    expectTypeOf<ErrorCodeOf<ReturnType<typeof createClient>>>().toEqualTypeOf<ErrorCode>()
  })
})
