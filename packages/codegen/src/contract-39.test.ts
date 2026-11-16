import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'

const witness = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument

type Json = Record<string, unknown>

/** The schema at a path of keys through a document. */
function at(doc: unknown, ...keys: (string | number)[]): Json {
  return keys.reduce<unknown>((node, key) => (node as Json)[key], doc) as Json
}

const PRIORITY_ITEM = { type: 'integer', allOf: [{ $ref: '#/components/schemas/Priority' }] }

/**
 * Core types the enum references inside each `<Type>RelatedQuery` parameter component the way it
 * types a top-level filter parameter's, as `{ type, allOf: [{ $ref }] }`. The codegen reads the
 * relations a component lists, not their filters, so the named enum comes out as it does from a
 * top-level filter.
 */
describe('generator contract 39 (typed enum references in relatedQuery)', () => {
  it('writes the relatedQuery filter item as the top-level filter writes it', () => {
    const path = ['components', 'parameters', 'TagsRelatedQuery', 'schema', 'properties']
    const filter = [...path, 'articles', 'properties', 'filter', 'properties', 'priorities']
    expect(at(witness, ...filter, 'items')).toEqual(PRIORITY_ITEM)
    const params = at(
      witness,
      'paths',
      '/tags/{id}/articles',
      'get',
      'parameters',
    ) as unknown as Json[]
    const priorities = params.find((param) => param['name'] === 'filter[priorities]')!
    expect(at(priorities, 'schema', 'items')).toEqual(PRIORITY_ITEM)
  })

  it('keeps the named enum', () => {
    const descriptor = buildDescriptor(witness)
    expect(descriptor['tags']?.relatedQuery?.relations).toContain('articles')
    const source = emit(witness, descriptor)
    expect(source).toContain('export type Priority = 1 | 2\n')
    expect(source).toContain('  priorities?: Priority[]\n')
  })
})
