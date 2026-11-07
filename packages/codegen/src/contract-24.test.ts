import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JsonApiError } from '@haddowg/json-api-client'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import {
  type ErrorCodeByOperation,
  type ErrorMetaByCode,
  findError,
} from '../test/generated/contract-witness.client.gen'

const fixtureUrl = new URL('../test/fixtures/contract-witness.openapi.json', import.meta.url)
const witness = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), 'utf8')) as OpenApiDocument
const source = emit(witness, buildDescriptor(witness))

describe('generator contract 24 (error shapes, scoped codes, typed meta)', () => {
  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(24)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('reads each code off its shape, titled and described', () => {
    expect(source).toContain(
      [
        '  /**',
        '   * Article locked.',
        '   *',
        '   * Another editor holds the article. Wait for them to finish, then retry.',
        '   *',
        '   * @example The article is locked by another editor.',
        '   */',
        '  ARTICLE_LOCKED: "ARTICLE_LOCKED",',
      ].join('\n'),
    )
  })

  it('names the codes only some operations raise', () => {
    expectTypeOf<ErrorCodeByOperation['update.articles']>().toEqualTypeOf<'ARTICLE_LOCKED'>()
    expectTypeOf<ErrorCodeByOperation['delete.articles']>().toEqualTypeOf<'ARTICLE_LOCKED'>()
  })

  it('types a declared meta through findError', () => {
    expectTypeOf<ErrorMetaByCode['INSUFFICIENT_SCOPE']['missingScopes']>().toEqualTypeOf<
      [string, ...string[]]
    >()
    const err = new JsonApiError(403, [
      {
        status: '403',
        code: 'INSUFFICIENT_SCOPE',
        meta: { requiredScopes: ['a'], missingScopes: ['a'] },
      },
    ])
    const found = findError(err, 'INSUFFICIENT_SCOPE')
    expect(found?.meta.missingScopes).toEqual(['a'])
    expect(findError(err, 'ARTICLE_LOCKED')).toBeUndefined()
  })
})
