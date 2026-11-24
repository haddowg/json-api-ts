import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkContract } from './contract'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'

const load = (name: 'contract-witness.json' | 'contract-witness-baseline.json') =>
  JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument
const witness = load('contract-witness.json')
const baseline = load('contract-witness-baseline.json')

/** Every range filter object the document closes, by the parameter or component it sits in. */
function closedRanges(doc: OpenApiDocument): string[] {
  const found: string[] = []
  const visit = (node: unknown, at: string): void => {
    if (typeof node !== 'object' || node === null) {
      return
    }
    const schema = node as Record<string, unknown>
    if (schema['additionalProperties'] === false && 'min' in Object(schema['properties'])) {
      found.push(at)
    }
    for (const [key, value] of Object.entries(schema)) {
      visit(value, key === 'name' ? at : `${at}/${key}`)
    }
  }
  visit(doc, '')
  return found
}

/**
 * A `Range` or `DateRange` filter refuses any member but `min` and `max`, so its `filter[<key>]`
 * object is closed with `additionalProperties: false` wherever it is projected, on a read's
 * parameters and in a `relatedQuery` component's `filter`. The codegen reads no filter value
 * shape, so the client it generates doesn't change.
 */
describe('generator contract 44 (closed range filters)', () => {
  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(46)
    expect(baseline.info?.['x-generator']?.contract).toBe(46)
    expect(checkContract(witness)).toBeUndefined()
    expect(checkContract(baseline)).toBeUndefined()
  })

  it('closes each range filter the witness projects', () => {
    expect(closedRanges(witness)).toHaveLength(11)
    expect(closedRanges(baseline)).toHaveLength(8)
    expect(closedRanges(witness)).toContain(
      '/components/parameters/TagsRelatedQuery/schema/properties/articles/properties/filter/properties/rating',
    )
  })
})
