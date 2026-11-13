import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildAtomic, buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import { readErrorCatalogue } from './error-codes'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'

const witness = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument
const descriptor = buildDescriptor(witness)
const COUNTABLE = 'https://haddowg.github.io/json-api/profiles/countable/'

/**
 * Core's witness documents `withCount` on reading, creating and updating one article and on
 * reading one image, with the relations each can count and no `_self_`. It offers each
 * feature-gated error code only on the operations that can raise it, so it has no shared 409
 * document, and it moves the atomic relationship operations' identifiers into components.
 */
describe('generator contract 35 (single-resource counts, gated error codes)', () => {
  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(37)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('records the withCount of each operation answering with one resource', () => {
    const counts = { tokens: ['tags', 'sponsors'], profile: COUNTABLE }
    expect(descriptor['articles']!.resourceCountable).toEqual({
      fetchOne: counts,
      create: counts,
      update: counts,
    })
    expect(descriptor['images']!.resourceCountable).toEqual({
      fetchOne: { tokens: ['clips'], profile: COUNTABLE },
    })
    expect(descriptor['tags']!.resourceCountable).toBeUndefined()
  })

  it('emits the record on the resourceMap entry', () => {
    const source = emit(witness, buildDescriptor(witness))
    const images = source.slice(source.indexOf('\n  images: {'))
    expect(images).toContain(
      [
        '    resourceCountable: {',
        '      fetchOne: {',
        '        tokens: [',
        '          "clips"',
        '        ],',
        `        profile: "${COUNTABLE}"`,
        '      }',
        '    },',
      ].join('\n'),
    )
  })

  it('scopes every code of a status with no shared document to the operations that raise it', () => {
    const schemas = Object.keys(witness.components?.schemas ?? {})
    expect(schemas).not.toContain('ErrorDocument409')
    expect(Object.keys(witness.components?.responses ?? {})).not.toContain('Conflict')
    const catalogue = readErrorCatalogue(witness)
    expect(catalogue.byOperation.get('update.articles')).toEqual(
      expect.arrayContaining(['RESOURCE_ID_CONFLICT', 'RESOURCE_TYPE_UNACCEPTABLE']),
    )
    expect(catalogue.byOperation.get('fetchOne.articles')).toContain(
      'RELATIONSHIP_COUNT_NOT_ALLOWED',
    )
    expect(catalogue.byStatus.get(409)).toEqual(
      expect.arrayContaining(['ARTICLE_LOCKED', 'CLIENT_GENERATED_ID_ALREADY_EXISTS']),
    )
  })

  it('still finds the atomic endpoint, whose identifiers are now components', () => {
    expect(Object.keys(witness.components?.schemas ?? {})).toEqual(
      expect.arrayContaining(['AtomicIdentifier', 'AtomicIdentifiers']),
    )
    expect(buildAtomic(witness)?.path).toBe('/operations')
  })
})
