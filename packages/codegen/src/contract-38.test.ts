import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract, MAXIMUM_CONTRACT } from './contract'
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

/** The schema of a query parameter an operation lists inline. */
function parameter(doc: OpenApiDocument, path: string, name: string): Json {
  const params = at(doc, 'paths', path, 'get', 'parameters') as unknown as Json[]
  return params.find((param) => param['name'] === name)!['schema'] as Json
}

/**
 * Core writes every reference to a named value shape with its component's JSON type beside it:
 * `{ type, allOf: [{ $ref }] }`, or `{ type: [..., 'null'], anyOf: [{ $ref }, { type: 'null' }] }`
 * when nullable. The type repeats the component's, so the codegen reads the reference as before.
 */
describe('generator contract 38 (witness references to named value shapes)', () => {
  it('reads a document stamped 38 without a warning, and warns past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(38)
    expect(witness.info?.['x-generator']?.contract).toBe(38)
    expect(checkContract(witness)).toBeUndefined()
    const newer = { ...witness, info: { ...witness.info!, 'x-generator': { contract: 39 } } }
    expect(checkContract(newer as OpenApiDocument)).toContain('reads up to 38')
  })

  it('writes the witness the way contract 38 does', () => {
    const attributes = at(witness, 'components', 'schemas', 'ArticlesAttributes', 'properties')
    expect(attributes['status']).toMatchObject({
      type: ['string', 'null'],
      anyOf: [{ $ref: '#/components/schemas/Status' }, { type: 'null' }],
    })
    expect(attributes['priority']).toMatchObject({ type: ['integer', 'null'] })
    expect(attributes['defaultValue']).toMatchObject({
      type: ['string', 'number', 'boolean'],
      allOf: [{ $ref: '#/components/schemas/PlaceholderValue' }],
    })
    expect(attributes['reviewedBy']).toMatchObject({ type: ['object', 'null'] })
    expect(parameter(witness, '/articles', 'filter[priorities]')).toEqual({
      type: 'array',
      items: { type: 'integer', allOf: [{ $ref: '#/components/schemas/Priority' }] },
    })
    const report = at(witness, 'paths', '/articles/-actions/report', 'get', 'responses', '200')
    expect(at(report, 'content', 'application/json', 'schema')).toEqual({
      type: 'object',
      allOf: [{ $ref: '#/components/schemas/ArticleSummary' }],
    })
    const bulk = at(witness, 'paths', '/articles/-actions/bulk-import', 'post', 'requestBody')
    expect(at(bulk, 'content', 'application/json', 'schema')).toEqual({
      type: 'array',
      allOf: [{ $ref: '#/components/schemas/ArticleImportRow' }],
    })
  })

  it('keeps the named types, raw bodies among them', () => {
    const source = emit(witness, buildDescriptor(witness))
    expect(source).toContain('  status: Status | null\n')
    expect(source).toContain('  priority: Priority | null\n')
    expect(source).toContain('  defaultValue: PlaceholderValue\n')
    expect(source).toContain('  fallbackValue: PlaceholderValue | null\n')
    expect(source).toContain('  reviewedBy: Reviewer | null\n')
    expect(source).toContain('  reviewedBy?: ReviewerCreate\n')
    expect(source).toContain('  approvedBy?: ReviewerUpdate | null\n')
    expect(source).toContain('report: { responses: { "application/json": ArticleSummary } }')
    expect(source).toContain(
      '"bulk-import": { requests: { "application/json": ArticleImportRow } }',
    )
  })
})
