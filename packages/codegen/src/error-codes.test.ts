import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { emit } from './emit'
import { emitErrorCodes, readErrorCatalogue } from './error-codes'
import type { OpenApiDocument, SchemaObject } from './openapi'
import { documentPath } from '../test/documents'

const ref = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` })

/** An error document offering the generic `Error` plus the named variants, as core projects it. */
const errorDocument = (...variants: string[]): SchemaObject => ({
  type: 'object',
  properties: {
    errors: { type: 'array', items: { anyOf: [ref('Error'), ...variants.map(ref)] } },
  },
  required: ['errors'],
})

/** One code's branch of a shape's `code`. */
const codeBranch = (code: string, title?: string, description?: string): SchemaObject => ({
  type: 'string',
  const: code,
  ...(title !== undefined ? { title } : {}),
  ...(description !== undefined ? { description } : {}),
})

/** A shape: the generic `Error` narrowed by a `code` anyOf, a `status` const and any `meta`. */
const shape = (
  status: number,
  codes: SchemaObject[],
  meta?: { schema: SchemaObject; required: boolean },
): SchemaObject => ({
  title: `A ${status} error`,
  allOf: [
    ref('Error'),
    {
      type: 'object',
      properties: {
        code: { anyOf: codes },
        status: { type: 'string', const: String(status) },
        ...(meta !== undefined ? { meta: meta.schema } : {}),
      },
      required: meta?.required ? ['code', 'status', 'meta'] : ['code', 'status'],
    },
  ],
})

const example = (code: string, detail: string) => ({
  summary: code,
  value: { errors: [{ status: '403', code, detail }] },
})

const doc: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Errors', version: '1', 'x-generator': { contract: 24 } },
  // An operation `$ref`s a shared response; the reader only follows the reference.
  paths: {
    '/articles/{id}': {
      patch: {
        operationId: 'update.articles',
        responses: { '409': { $ref: '#/components/responses/ConflictWithArticleLocked' } as never },
      },
      delete: {
        operationId: 'delete.articles',
        responses: { '409': { $ref: '#/components/responses/Conflict' } as never },
      },
    },
  },
  components: {
    schemas: {
      Error: { type: 'object', properties: { code: { type: 'string' } } },
      Error401: shape(401, [
        codeBranch(
          'AUTHENTICATION_REQUIRED',
          'Authentication required',
          'The request carries no valid credential.\nSign in and retry.',
        ),
      ]),
      Error403: shape(403, [
        codeBranch(
          'ACCESS_DENIED',
          'Access denied',
          'The credential is valid but lacks permission.',
        ),
        codeBranch('PASSWORD_EXPIRED'),
      ]),
      Error403InsufficientScope: shape(
        403,
        [codeBranch('INSUFFICIENT_SCOPE', 'Insufficient scope')],
        {
          schema: {
            type: 'object',
            properties: {
              missingScopes: { type: 'array', items: { type: 'string' }, minItems: 1 },
            },
            required: ['missingScopes'],
            additionalProperties: false,
          },
          required: true,
        },
      ),
      Error404: shape(404, [codeBranch('RESOURCE_NOT_FOUND')]),
      Error409: shape(409, [codeBranch('RESOURCE_ID_CONFLICT')]),
      Error409ArticleLocked: shape(409, [codeBranch('ARTICLE_LOCKED', 'Article locked')]),
      ErrorDocument: errorDocument(
        'Error401',
        'Error403',
        'Error403InsufficientScope',
        'Error404',
        'Error409',
        'Error409ArticleLocked',
      ),
      ErrorDocument401: errorDocument('Error401'),
      ErrorDocument403: errorDocument('Error403', 'Error403InsufficientScope'),
      ErrorDocument404: errorDocument('Error404'),
      ErrorDocument409: errorDocument('Error409'),
      ErrorDocument409WithArticleLocked: errorDocument('Error409', 'Error409ArticleLocked'),
      ErrorDocument500: errorDocument(),
    },
    responses: {
      Conflict: { content: { 'application/vnd.api+json': { schema: ref('ErrorDocument409') } } },
      ConflictWithArticleLocked: {
        content: {
          'application/vnd.api+json': { schema: ref('ErrorDocument409WithArticleLocked') },
        },
      },
    },
    examples: {
      AUTHENTICATION_REQUIRED: example('AUTHENTICATION_REQUIRED', 'Authentication is required.'),
      PASSWORD_EXPIRED: example('PASSWORD_EXPIRED', 'Your password expired on 2026-01-01.'),
    },
  },
}

describe('readErrorCatalogue', () => {
  const catalogue = readErrorCatalogue(doc)

  it('collects every code of every shape, sorted, skipping the generic Error branch', () => {
    expect(catalogue.codes.map((c) => c.code)).toEqual([
      'ACCESS_DENIED',
      'ARTICLE_LOCKED',
      'AUTHENTICATION_REQUIRED',
      'INSUFFICIENT_SCOPE',
      'PASSWORD_EXPIRED',
      'RESOURCE_ID_CONFLICT',
      'RESOURCE_NOT_FOUND',
    ])
  })

  it('groups codes by status across the shared and narrowed error documents, in status order', () => {
    expect([...catalogue.byStatus]).toEqual([
      [401, ['AUTHENTICATION_REQUIRED']],
      [403, ['ACCESS_DENIED', 'INSUFFICIENT_SCOPE', 'PASSWORD_EXPIRED']],
      [404, ['RESOURCE_NOT_FOUND']],
      [409, ['ARTICLE_LOCKED', 'RESOURCE_ID_CONFLICT']],
      [500, []],
    ])
  })

  it('maps each operation to the codes its narrowed responses add', () => {
    expect([...catalogue.byOperation]).toEqual([['update.articles', ['ARTICLE_LOCKED']]])
  })

  it('reads titles, descriptions, examples and meta when present', () => {
    const byCode = new Map(catalogue.codes.map((c) => [c.code, c]))
    expect(byCode.get('AUTHENTICATION_REQUIRED')).toEqual({
      code: 'AUTHENTICATION_REQUIRED',
      title: 'Authentication required',
      description: 'The request carries no valid credential.\nSign in and retry.',
      examples: ['Authentication is required.'],
    })
    expect(byCode.get('PASSWORD_EXPIRED')).toEqual({
      code: 'PASSWORD_EXPIRED',
      examples: ['Your password expired on 2026-01-01.'],
    })
    expect(byCode.get('RESOURCE_NOT_FOUND')).toEqual({ code: 'RESOURCE_NOT_FOUND', examples: [] })
    expect(byCode.get('INSUFFICIENT_SCOPE')?.metaRequired).toBe(true)
    expect(byCode.get('INSUFFICIENT_SCOPE')?.meta?.required).toEqual(['missingScopes'])
  })

  it('finds nothing in a document without error documents', () => {
    const empty = readErrorCatalogue({ openapi: '3.1.0' })
    expect(empty.codes).toEqual([])
    expect(empty.byStatus.size).toBe(0)
    expect(empty.byOperation.size).toBe(0)
  })
})

describe('emitErrorCodes', () => {
  const source = emitErrorCodes(readErrorCatalogue(doc), (schema) =>
    schema.properties?.['missingScopes'] !== undefined
      ? '{ missingScopes: [string, ...string[]] }'
      : 'unknown',
  )

  it('emits the ErrorCodes object with TSDoc only where the document describes a code', () => {
    expect(source).toContain(
      [
        'export const ErrorCodes = {',
        '  /**',
        '   * Access denied.',
        '   *',
        '   * The credential is valid but lacks permission.',
        '   */',
        '  ACCESS_DENIED: "ACCESS_DENIED",',
        '  /** Article locked. */',
        '  ARTICLE_LOCKED: "ARTICLE_LOCKED",',
        '  /**',
        '   * Authentication required.',
        '   *',
        '   * The request carries no valid credential.',
        '   * Sign in and retry.',
        '   *',
        '   * @example Authentication is required.',
        '   */',
        '  AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",',
        '  /** Insufficient scope. */',
        '  INSUFFICIENT_SCOPE: "INSUFFICIENT_SCOPE",',
        '  /** @example Your password expired on 2026-01-01. */',
        '  PASSWORD_EXPIRED: "PASSWORD_EXPIRED",',
        '  RESOURCE_ID_CONFLICT: "RESOURCE_ID_CONFLICT",',
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
      byOperation: new Map(),
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
        '  403: "ACCESS_DENIED" | "INSUFFICIENT_SCOPE" | "PASSWORD_EXPIRED"',
        '  404: "RESOURCE_NOT_FOUND"',
        '  409: "ARTICLE_LOCKED" | "RESOURCE_ID_CONFLICT"',
        '  500: never',
        '}',
      ].join('\n'),
    )
  })

  it('binds the guard to the union and the finder to the union and its meta', () => {
    expect(source).toContain(
      'export const hasErrorCode = hasErrorCodeRuntime as ErrorCodeGuard<ErrorCode>',
    )
    expect(source).toContain(
      'export const findError = findErrorRuntime as ErrorFinder<ErrorCode, ErrorMetaByCode>',
    )
  })

  it('emits the codes only some operations raise, by operation id', () => {
    expect(source).toContain(
      [
        'export interface ErrorCodeByOperation {',
        '  "update.articles": "ARTICLE_LOCKED"',
        '}',
      ].join('\n'),
    )
  })

  it('types each declared meta, optional where the shape does not require it', () => {
    expect(source).toContain(
      [
        'export interface ErrorMetaByCode {',
        '  INSUFFICIENT_SCOPE: { missingScopes: [string, ...string[]] }',
        '}',
      ].join('\n'),
    )
    const optional = emitErrorCodes(
      {
        codes: [{ code: 'X', examples: [], meta: { type: 'object' }, metaRequired: false }],
        byStatus: new Map(),
        byOperation: new Map(),
      },
      () => '{ original?: string }',
    )
    expect(optional).toContain('  X: { original?: string } | undefined')
  })

  it('falls back to string and an empty map when nothing is catalogued', () => {
    const empty = emitErrorCodes(readErrorCatalogue({ openapi: '3.1.0' }))
    expect(empty).toContain('export const ErrorCodes = {} as const')
    expect(empty).toContain('export type ErrorCode = string')
    expect(empty).toContain('export interface ErrorCodeByStatus {}')
    expect(empty).toContain('export interface ErrorCodeByOperation {}')
    expect(empty).toContain('export interface ErrorMetaByCode {}')
  })

  it('keeps a description from closing the comment early', () => {
    const tricky = emitErrorCodes({
      codes: [{ code: 'X', description: 'ends */ here', examples: [{ field: 'a' }] }],
      byStatus: new Map(),
      byOperation: new Map(),
    })
    expect(tricky).toContain('   * ends * / here\n   *\n   * @example {"field":"a"}')
  })
})

describe('error codes in the generated client (music-catalog fixture)', () => {
  const path = documentPath('music-catalog.openapi.json')
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument
  const source = emit(fixture, buildDescriptor(fixture))

  it('emits the codes object, the per-status map and the bound guard', () => {
    expect(source).toContain(
      'export const ErrorCodes = {\n  /**\n   * Forbidden.\n   *\n   * The caller is authenticated but not permitted',
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

  it('documents each code from its title, description and example detail', () => {
    expect(source).toContain(
      [
        '  /**',
        '   * Pagination kind is not supported.',
        '   *',
        '   * `page[kind]` names a pagination strategy this collection does not offer. Use one of the strategies the `detail` lists, or leave `page[kind]` out.',
        '   *',
        "   * @example The pagination strategy 'page[kind]=offset' is not supported; use one of: page, cursor.",
        '   */',
        '  PAGINATION_KIND_UNKNOWN: "PAGINATION_KIND_UNKNOWN",',
      ].join('\n'),
    )
  })

  it('documents the detail example every core code carries', () => {
    expect(source).toContain(
      ['   * @example Access is denied!', '   */', '  ACCESS_DENIED: "ACCESS_DENIED",'].join('\n'),
    )
  })

  it('threads ErrorCode into the bound client factory', () => {
    expect(source).toContain(
      'createClientRuntime<typeof resourceMap, Attributes, WriteAttributes, ActionTypes, ErrorCode, Links>(',
    )
  })
})
