import { readFileSync } from 'node:fs'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  ErrorCodeByOperation,
  ErrorCodeByStatus,
} from '../test/generated/contract-witness.client.gen'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import { readErrorCatalogue } from './error-codes'
import type { OpenApiDocument, SchemaObject } from './openapi'
import { documentPath } from '../test/documents'

const witness = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument

const ref = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` })

/** An error document offering the generic `Error` plus the named shapes. */
const errorDocument = (...shapes: string[]): SchemaObject => ({
  type: 'object',
  properties: {
    errors: { type: 'array', minItems: 1, items: { anyOf: [ref('Error'), ...shapes.map(ref)] } },
  },
  required: ['errors'],
})

/** A shape whose `code` offers the given codes. */
const shape = (...codes: string[]): SchemaObject => ({
  allOf: [
    ref('Error'),
    {
      type: 'object',
      properties: { code: { anyOf: codes.map((code) => ({ type: 'string', const: code })) } },
      required: ['code'],
    },
  ],
})

const answer = (document: string) => ({
  description: 'An error.',
  content: { 'application/vnd.api+json': { schema: ref(document) } },
})

/**
 * Core's witness scopes `ARTICLE_LOCKED` to updating and deleting an article and to the Atomic
 * Operations endpoint, and its payment codes to creating a tag, adding an article's tags, its
 * `publish` action, the `POST` of its `export` action and the Atomic Operations endpoint. Each
 * of those operations answers the status inline with an error document named for it.
 */
describe('generator contract 33 (error documents named for the operation)', () => {
  const catalogue = readErrorCatalogue(witness)

  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(34)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('reaches the scoped documents only through the operations that answer with them', () => {
    const names = Object.keys(witness.components?.schemas ?? {})
    expect(names).toContain('ArticlesUpdate409')
    expect(names.filter((name) => name.includes('With'))).toEqual([])
    expect(Object.keys(witness.components?.responses ?? {})).not.toContain(
      'ConflictWithArticleLocked',
    )
  })

  it('maps each operation to the codes its own documents add to the shared ones', () => {
    const payment = ['PAYMENT_REQUIRED', 'SUBSCRIPTION_EXPIRED']
    expect([...catalogue.byOperation]).toEqual([
      ['action.articles.export.post', payment],
      ['action.articles.publish', payment],
      ['addRelationship.articles.tags', payment],
      ['atomic.operations', ['ARTICLE_LOCKED', ...payment]],
      ['create.tags', payment],
      ['delete.articles', ['ARTICLE_LOCKED']],
      ['update.articles', ['ARTICLE_LOCKED']],
    ])
  })

  it('files each operation document under the status that answers with it', () => {
    expect(catalogue.byStatus.get(402)).toEqual(['PAYMENT_REQUIRED', 'SUBSCRIPTION_EXPIRED'])
    expect(catalogue.byStatus.get(409)).toContain('ARTICLE_LOCKED')
    expect(catalogue.codes.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['ARTICLE_LOCKED', 'PAYMENT_REQUIRED', 'SUBSCRIPTION_EXPIRED']),
    )
  })

  it('types the scoped codes in the generated client', () => {
    expectTypeOf<ErrorCodeByOperation['update.articles']>().toEqualTypeOf<'ARTICLE_LOCKED'>()
    expectTypeOf<ErrorCodeByOperation['action.articles.publish']>().toEqualTypeOf<
      'PAYMENT_REQUIRED' | 'SUBSCRIPTION_EXPIRED'
    >()
    expectTypeOf<ErrorCodeByOperation['addRelationship.articles.tags']>().toEqualTypeOf<
      'PAYMENT_REQUIRED' | 'SUBSCRIPTION_EXPIRED'
    >()
    expectTypeOf<ErrorCodeByStatus[402]>().toEqualTypeOf<
      'PAYMENT_REQUIRED' | 'SUBSCRIPTION_EXPIRED'
    >()
  })

  it('emits no type for an operation document', () => {
    const source = emit(witness, buildDescriptor(witness))
    expect(source).not.toMatch(/\bArticlesUpdate409\b/)
    expect(source).toContain('  "update.articles": "ARTICLE_LOCKED"')
  })
})

describe('an operation document reached by reference', () => {
  const doc = {
    openapi: '3.1.0',
    info: { title: 'Errors', version: '1', 'x-generator': { contract: 33 } },
    paths: {
      '/articles/{id}': {
        get: {
          operationId: 'fetchOne.articles',
          responses: {
            '200': answer('ArticlesDocument'),
            '409': { $ref: '#/components/responses/Conflict' },
          },
        },
        patch: {
          operationId: 'update.articles',
          responses: { '409': answer('ArticlesUpdate409') },
        },
        delete: {
          operationId: 'delete.articles',
          responses: { '409': { $ref: '#/components/responses/ArticlesDelete' } },
        },
      },
      '/tags': {
        post: {
          operationId: 'create.tags',
          responses: { '402': answer('TagsCreate402'), '422': answer('ArticlesDocument') },
        },
      },
    },
    components: {
      schemas: {
        Error: { type: 'object', properties: { code: { type: 'string' } } },
        Error402Payment: shape('PAYMENT_REQUIRED'),
        Error409: shape('RESOURCE_ID_CONFLICT'),
        Error409Locked: shape('ARTICLE_LOCKED'),
        Error409Archived: shape('ARTICLE_ARCHIVED'),
        ErrorDocument409: errorDocument('Error409'),
        ArticlesUpdate409: errorDocument('Error409', 'Error409Locked'),
        ArticlesDelete409: errorDocument('Error409', 'Error409Archived'),
        TagsCreate402: errorDocument('Error402Payment'),
        ArticlesDocument: { type: 'object', properties: { data: { type: 'object' } } },
      },
      responses: {
        Conflict: answer('ErrorDocument409'),
        ArticlesDelete: answer('ArticlesDelete409'),
      },
    },
  } as unknown as OpenApiDocument
  const catalogue = readErrorCatalogue(doc)

  it('reads an inline response and a response component alike, skipping the shared document', () => {
    expect([...catalogue.byOperation]).toEqual([
      ['create.tags', ['PAYMENT_REQUIRED']],
      ['delete.articles', ['ARTICLE_ARCHIVED']],
      ['update.articles', ['ARTICLE_LOCKED']],
    ])
  })

  it('files the codes under the status of the response, with no shared document needed', () => {
    expect([...catalogue.byStatus]).toEqual([
      [402, ['PAYMENT_REQUIRED']],
      [409, ['ARTICLE_ARCHIVED', 'ARTICLE_LOCKED', 'RESOURCE_ID_CONFLICT']],
    ])
  })

  it('leaves out a document that holds no errors, and a success document', () => {
    expect(catalogue.codes.map((entry) => entry.code)).toEqual([
      'ARTICLE_ARCHIVED',
      'ARTICLE_LOCKED',
      'PAYMENT_REQUIRED',
      'RESOURCE_ID_CONFLICT',
    ])
  })
})
