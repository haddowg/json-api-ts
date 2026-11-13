import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract, MAXIMUM_CONTRACT } from './contract'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'
import { typeRelatedQueries } from '../test/typed-references'

const witness = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument
const typed = typeRelatedQueries(witness)

type Json = Record<string, unknown>

/** The schema at a path of keys through a document. */
function at(doc: unknown, ...keys: (string | number)[]): Json {
  return keys.reduce<unknown>((node, key) => (node as Json)[key], doc) as Json
}

// The provenance header hashes the document, so it differs between the two forms by design.
const withoutHeader = (generated: string) => generated.slice(generated.indexOf(' */\n'))

const PRIORITY_ITEM = { type: 'integer', allOf: [{ $ref: '#/components/schemas/Priority' }] }

/**
 * Core types the enum references inside each `<Type>RelatedQuery` parameter component the way it
 * types a top-level filter parameter's, as `{ type, allOf: [{ $ref }] }`, where it wrote an inline
 * enum with no type before. The codegen reads the relations a component lists, not their filters,
 * so the generated client doesn't change.
 */
describe('generator contract 39 (typed enum references in relatedQuery)', () => {
  it('reads a document stamped 39 without a warning, and warns past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(39)
    expect(typed.info?.['x-generator']?.contract).toBe(39)
    expect(checkContract(typed)).toBeUndefined()
    const newer = { ...typed, info: { ...typed.info!, 'x-generator': { contract: 40 } } }
    expect(checkContract(newer as OpenApiDocument)).toContain('reads up to 39')
  })

  it('writes the relatedQuery filter item as the top-level filter writes it', () => {
    const path = ['components', 'parameters', 'TagsRelatedQuery', 'schema', 'properties']
    const filter = [...path, 'articles', 'properties', 'filter', 'properties', 'priorities']
    expect(at(witness, ...filter, 'items')).toEqual({
      enum: [1, 2],
      'x-enum-varnames': ['Low', 'High'],
    })
    expect(at(typed, ...filter, 'items')).toEqual(PRIORITY_ITEM)
    const params = at(
      typed,
      'paths',
      '/tags/{id}/articles',
      'get',
      'parameters',
    ) as unknown as Json[]
    const priorities = params.find((param) => param['name'] === 'filter[priorities]')!
    expect(at(priorities, 'schema', 'items')).toEqual(PRIORITY_ITEM)
  })

  it('keeps the named enum and generates the same client', () => {
    const descriptor = buildDescriptor(typed)
    expect(descriptor['tags']?.relatedQuery?.relations).toContain('articles')
    const source = emit(typed, descriptor)
    expect(source).toContain('export type Priority = 1 | 2\n')
    expect(source).toContain('  priorities?: Priority[]\n')
    expect(withoutHeader(source)).toBe(withoutHeader(emit(witness, buildDescriptor(witness))))
  })
})
