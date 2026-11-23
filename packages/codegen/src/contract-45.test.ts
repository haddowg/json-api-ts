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
 * Give every `releasedOn` filter, the witness's comparison filter over a `Date` field, the `date`
 * format and stamp the document 45. Applied to the pinned 2.23.0 witness, this reproduces what core
 * main's projector does to that filter, which no release has published yet. It goes once the pins
 * move to a core release at 45.
 */
function dateFilters(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc) as unknown as Record<string, unknown>
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (typeof node !== 'object' || node === null) {
      return
    }
    const object = node as Record<string, unknown>
    if (object['name'] === 'filter[releasedOn]' && typeof object['schema'] === 'object') {
      ;(object['schema'] as Record<string, unknown>)['format'] = 'date'
    }
    const filter = (object['properties'] as Record<string, unknown> | undefined)?.['filter']
    const releasedOn = (filter as { properties?: Record<string, unknown> } | undefined)
      ?.properties?.['releasedOn']
    if (typeof releasedOn === 'object' && releasedOn !== null) {
      ;(releasedOn as Record<string, unknown>)['format'] = 'date'
    }
    Object.values(object).forEach(visit)
  }
  visit(copy)
  const dated = copy as unknown as OpenApiDocument
  dated.info!['x-generator'] = { contract: 45 }
  return dated
}

/** Every filter value schema carrying a date format, by where it sits. */
function datedFilters(doc: OpenApiDocument): string[] {
  const found: string[] = []
  const visit = (node: unknown, at: string): void => {
    if (typeof node !== 'object' || node === null) {
      return
    }
    const schema = node as Record<string, unknown>
    if (
      at.includes('filter') &&
      typeof schema['format'] === 'string' &&
      ['date', 'date-time', 'time'].includes(schema['format'])
    ) {
      found.push(at)
    }
    for (const [key, value] of Object.entries(schema)) {
      const name = (value as { name?: unknown } | null)?.name
      visit(value, `${at}/${typeof name === 'string' ? name : key}`)
    }
  }
  visit(doc, '')
  return found
}

const dated = dateFilters(pinned)
const datedBaseline = dateFilters(pinnedBaseline)

/**
 * A comparison or list filter over a `DateTime`, `Date` or `Time` field, on the type or reached
 * through relations, documents the RFC 3339 `format` that field writes, as a range's bounds
 * already do. The codegen reads no filter value shape, so the client it generates doesn't change.
 */
describe('generator contract 45 (date formats on filter values)', () => {
  it('reads a document stamped 45 without a warning, and warns past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(45)
    expect(checkContract(dated)).toBeUndefined()
    expect(checkContract(datedBaseline)).toBeUndefined()
    const newer = { ...dated, info: { ...dated.info!, 'x-generator': { contract: 46 } } }
    expect(checkContract(newer as OpenApiDocument)).toContain('reads up to 45')
  })

  it('formats the comparison filter over a date field wherever it is projected', () => {
    const releasedOn = (doc: OpenApiDocument) =>
      datedFilters(doc).filter((at) => at.includes('releasedOn'))
    expect(releasedOn(pinned)).toEqual([])
    expect(releasedOn(dated)).toHaveLength(5)
    expect(releasedOn(datedBaseline)).toHaveLength(4)
    // The related endpoint's filter inside the tags' `relatedQuery` component too.
    expect(releasedOn(dated).filter((at) => at.startsWith('/components/parameters/'))).toEqual([
      '/components/parameters/relatedQuery/schema/properties/articles/properties/filter/properties/releasedOn',
    ])
  })

  it('builds the same descriptor and client as before', () => {
    expect(buildDescriptor(dated)).toEqual(buildDescriptor(pinned))
    expect(buildDescriptor(datedBaseline)).toEqual(buildDescriptor(pinnedBaseline))
    // Only the spec hash in the header moves.
    const client = (doc: OpenApiDocument) =>
      emit(doc, buildDescriptor(doc)).replace(/Spec hash: +\w+/, '')
    expect(client(dated)).toBe(client(pinned))
  })
})
