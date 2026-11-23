import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract, MAXIMUM_CONTRACT } from './contract'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'

const load = (name: 'contract-witness.json' | 'contract-witness-baseline.json') =>
  JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument
const pinned = load('contract-witness.json')
const pinnedBaseline = load('contract-witness-baseline.json')

/**
 * Close every object of a range filter's `min` and `max` bounds and stamp the document 44. Applied
 * to the pinned 2.22.0 witness, this reproduces the witness core main exports, which no release
 * has published yet. It goes once the pins move to a core release at 44.
 */
function closeRanges(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc) as unknown as Record<string, unknown>
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (typeof node !== 'object' || node === null) {
      return
    }
    const schema = node as Record<string, unknown>
    const properties = schema['properties']
    if (
      schema['type'] === 'object' &&
      typeof properties === 'object' &&
      properties !== null &&
      Object.keys(properties).length === 2 &&
      'min' in properties &&
      'max' in properties &&
      !('additionalProperties' in schema)
    ) {
      schema['additionalProperties'] = false
    }
    Object.values(schema).forEach(visit)
  }
  visit(copy)
  const closed = copy as unknown as OpenApiDocument
  closed.info!['x-generator'] = { contract: 44 }
  return closed
}

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

const closed = closeRanges(pinned)
const closedBaseline = closeRanges(pinnedBaseline)

/**
 * A `Range` or `DateRange` filter refuses any member but `min` and `max`, so its `filter[<key>]`
 * object is closed with `additionalProperties: false` wherever it is projected, on a read's
 * parameters and in a `relatedQuery` component's `filter`. The codegen reads no filter value
 * shape, so the client it generates doesn't change.
 */
describe('generator contract 44 (closed range filters)', () => {
  it('reads a document stamped 44 without a warning, and warns past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(44)
    expect(checkContract(closed)).toBeUndefined()
    expect(checkContract(closedBaseline)).toBeUndefined()
    const newer = { ...closed, info: { ...closed.info!, 'x-generator': { contract: 45 } } }
    expect(checkContract(newer as OpenApiDocument)).toContain('reads up to 44')
  })

  it('closes each range filter the witness projects, and nothing else', () => {
    expect(closedRanges(pinned)).toEqual([])
    expect(closedRanges(closed)).toHaveLength(11)
    expect(closedRanges(closedBaseline)).toHaveLength(8)
    expect(closedRanges(closed)).toContain(
      '/components/parameters/TagsRelatedQuery/schema/properties/articles/properties/filter/properties/rating',
    )
  })

  it('builds the same descriptor and client as the open ranges did', () => {
    expect(buildDescriptor(closed)).toEqual(buildDescriptor(pinned))
    expect(buildDescriptor(closedBaseline)).toEqual(buildDescriptor(pinnedBaseline))
    // Only the spec hash in the header moves.
    const client = (doc: OpenApiDocument) =>
      emit(doc, buildDescriptor(doc)).replace(/Spec hash: +\w+/, '')
    expect(client(closed)).toBe(client(pinned))
  })
})
