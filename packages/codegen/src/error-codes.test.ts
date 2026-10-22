import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { emit } from './emit'
import { emitErrorCodes, readErrorCatalogue } from './error-codes'
import type { OpenApiDocument, SchemaObject } from './openapi'

const ref = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` })

/** An error document offering the generic `Error` plus the named variants, as core projects it. */
const errorDocument = (...variants: string[]): SchemaObject => ({
  type: 'object',
  properties: {
    errors: { type: 'array', items: { anyOf: [ref('Error'), ...variants.map(ref)] } },
  },
  required: ['errors'],
})

/** A `<Code>Error` component: the generic `Error` narrowed by `code` and `status` consts. */
const variant = (
  code: string,
  status: number,
  extra: { description?: string; detail?: SchemaObject } = {},
): SchemaObject => ({
  title: `${code} title`,
  ...(extra.description !== undefined ? { description: extra.description } : {}),
  allOf: [
    ref('Error'),
    {
      type: 'object',
      properties: {
        code: { type: 'string', const: code },
        status: { type: 'string', const: String(status) },
        ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
      },
      required: ['code', 'status'],
    },
  ],
})

const doc: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Errors', version: '1', 'x-generator': { contract: 4 } },
  components: {
    schemas: {
      Error: { type: 'object', properties: { code: { type: 'string' } } },
      AuthenticationRequiredError: variant('AUTHENTICATION_REQUIRED', 401, {
        description: 'The request carries no valid credential.\nSign in and retry.',
        detail: { type: 'string', examples: ['Authentication is required.'] },
      }),
      AccessDeniedError: variant('ACCESS_DENIED', 403, {
        description: 'The credential is valid but lacks permission.',
      }),
      PasswordExpiredError: variant('PASSWORD_EXPIRED', 403, {
        detail: { type: 'string', example: 'Your password expired on 2026-01-01.' },
      }),
      ResourceNotFoundError: variant('RESOURCE_NOT_FOUND', 404),
      ErrorDocument: errorDocument(
        'AccessDeniedError',
        'AuthenticationRequiredError',
        'PasswordExpiredError',
        'ResourceNotFoundError',
      ),
      ErrorDocument403: errorDocument('PasswordExpiredError', 'AccessDeniedError'),
      ErrorDocument401: errorDocument('AuthenticationRequiredError'),
      ErrorDocument404: errorDocument('ResourceNotFoundError'),
      ErrorDocument500: errorDocument(),
    },
  },
}

describe('readErrorCatalogue', () => {
  const catalogue = readErrorCatalogue(doc)

  it('collects every documented code, sorted, skipping the generic Error branch', () => {
    expect(catalogue.codes.map((c) => c.code)).toEqual([
      'ACCESS_DENIED',
      'AUTHENTICATION_REQUIRED',
      'PASSWORD_EXPIRED',
      'RESOURCE_NOT_FOUND',
    ])
  })

  it('groups codes by the status in the error document name, in status order', () => {
    expect([...catalogue.byStatus]).toEqual([
      [401, ['AUTHENTICATION_REQUIRED']],
      [403, ['ACCESS_DENIED', 'PASSWORD_EXPIRED']],
      [404, ['RESOURCE_NOT_FOUND']],
      [500, []],
    ])
  })

  it('reads descriptions and detail examples when present', () => {
    const byCode = new Map(catalogue.codes.map((c) => [c.code, c]))
    expect(byCode.get('AUTHENTICATION_REQUIRED')).toEqual({
      code: 'AUTHENTICATION_REQUIRED',
      description: 'The request carries no valid credential.\nSign in and retry.',
      examples: ['Authentication is required.'],
    })
    expect(byCode.get('PASSWORD_EXPIRED')).toEqual({
      code: 'PASSWORD_EXPIRED',
      examples: ['Your password expired on 2026-01-01.'],
    })
    expect(byCode.get('RESOURCE_NOT_FOUND')).toEqual({ code: 'RESOURCE_NOT_FOUND', examples: [] })
  })

  it('finds nothing in a document without error documents', () => {
    const empty = readErrorCatalogue({ openapi: '3.1.0' })
    expect(empty.codes).toEqual([])
    expect(empty.byStatus.size).toBe(0)
  })
})

describe('emitErrorCodes', () => {
  const source = emitErrorCodes(readErrorCatalogue(doc))

  it('emits the ErrorCodes object with TSDoc only where the document describes a code', () => {
    expect(source).toContain(
      [
        'export const ErrorCodes = {',
        '  /** The credential is valid but lacks permission. */',
        '  ACCESS_DENIED: "ACCESS_DENIED",',
        '  /**',
        '   * The request carries no valid credential.',
        '   * Sign in and retry.',
        '   *',
        '   * @example Authentication is required.',
        '   */',
        '  AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",',
        '  /** @example Your password expired on 2026-01-01. */',
        '  PASSWORD_EXPIRED: "PASSWORD_EXPIRED",',
        '  RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",',
        '} as const',
      ].join('\n'),
    )
  })

  it('derives the ErrorCode union from the object', () => {
    expect(source).toContain('export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]')
  })

  it('quotes a code that is not a valid identifier', () => {
    const odd = emitErrorCodes({
      codes: [
        { code: 'app.locked-out', examples: [] },
        { code: '2FA_REQUIRED', examples: [] },
        { code: 'OK_CODE', examples: [] },
      ],
      byStatus: new Map(),
    })
    expect(odd).toContain('  "app.locked-out": "app.locked-out",')
    expect(odd).toContain('  "2FA_REQUIRED": "2FA_REQUIRED",')
    expect(odd).toContain('  OK_CODE: "OK_CODE",')
  })

  it('emits the per-status map, with never for a status documenting only the generic Error', () => {
    expect(source).toContain(
      [
        'export interface ErrorCodeByStatus {',
        '  401: "AUTHENTICATION_REQUIRED"',
        '  403: "ACCESS_DENIED" | "PASSWORD_EXPIRED"',
        '  404: "RESOURCE_NOT_FOUND"',
        '  500: never',
        '}',
      ].join('\n'),
    )
  })

  it('binds the guard to the union', () => {
    expect(source).toContain(
      'export const hasErrorCode = hasErrorCodeRuntime as ErrorCodeGuard<ErrorCode>',
    )
  })

  it('falls back to string and an empty map when nothing is catalogued', () => {
    const empty = emitErrorCodes(readErrorCatalogue({ openapi: '3.1.0' }))
    expect(empty).toContain('export const ErrorCodes = {} as const')
    expect(empty).toContain('export type ErrorCode = string')
    expect(empty).toContain('export interface ErrorCodeByStatus {}')
  })

  it('keeps a description from closing the comment early', () => {
    const tricky = emitErrorCodes({
      codes: [{ code: 'X', description: 'ends */ here', examples: [{ field: 'a' }] }],
      byStatus: new Map(),
    })
    expect(tricky).toContain('   * ends * / here\n   *\n   * @example {"field":"a"}')
  })
})

describe('error codes in the generated client (music-catalog fixture)', () => {
  const path = fileURLToPath(
    new URL('../test/fixtures/music-catalog.openapi.json', import.meta.url),
  )
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument
  const source = emit(fixture, buildDescriptor(fixture))

  it('emits the codes object, the per-status map and the bound guard', () => {
    expect(source).toContain(
      'export const ErrorCodes = {\n  ADDITION_PROHIBITED: "ADDITION_PROHIBITED",',
    )
    expect(source).toContain('  RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",')
    expect(source).toContain(
      'export interface ErrorCodeByStatus {\n  400:\n    | "ATOMIC_OPERATIONS_INVALID"',
    )
    expect(source).toContain('  404: ')
    expect(source).toContain(
      'export const hasErrorCode = hasErrorCodeRuntime as ErrorCodeGuard<ErrorCode>',
    )
  })

  it('a contract-2 document has no descriptions, so the codes carry no TSDoc', () => {
    const codes = source.slice(source.indexOf('export const ErrorCodes = {'))
    const body = codes.slice(0, codes.indexOf('} as const'))
    expect(body).not.toContain('/**')
  })

  it('threads ErrorCode into the bound client factory', () => {
    expect(source).toContain(
      'createClientRuntime<typeof resourceMap, Attributes, WriteAttributes, ActionTypes, ErrorCode>(',
    )
  })
})
