import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkContract } from './contract'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'

const load = (name: 'contract-witness.json' | 'contract-witness-baseline.json') =>
  JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument
const witness = load('contract-witness.json')
const baseline = load('contract-witness-baseline.json')

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

/**
 * A comparison or list filter over a `DateTime`, `Date` or `Time` field, on the type or reached
 * through relations, documents the RFC 3339 `format` that field writes, as a range's bounds
 * already do. The codegen reads no filter value shape, so the client it generates doesn't change.
 */
describe('generator contract 45 (date formats on filter values)', () => {
  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(46)
    expect(baseline.info?.['x-generator']?.contract).toBe(46)
    expect(checkContract(witness)).toBeUndefined()
    expect(checkContract(baseline)).toBeUndefined()
  })

  it('formats the comparison filter over a date field wherever it is projected', () => {
    const releasedOn = (doc: OpenApiDocument) =>
      datedFilters(doc).filter((at) => /[[/]releasedOn\b/.test(at))
    expect(releasedOn(witness)).toHaveLength(5)
    expect(releasedOn(baseline)).toHaveLength(4)
    // The related endpoint's filter inside the tags' `relatedQuery` component too.
    expect(releasedOn(witness).filter((at) => at.startsWith('/components/parameters/'))).toEqual([
      '/components/parameters/relatedQuery/schema/properties/articles/properties/filter/properties/releasedOn',
    ])
  })

  it('formats the items of a list filter over a date-time field', () => {
    expect(datedFilters(witness).filter((at) => at.includes('[publishedOn]'))).toEqual([
      '/paths//articles/get/parameters/filter[publishedOn]/schema/items',
      '/paths//articles/-actions/count/get/parameters/filter[publishedOn]/schema/items',
      '/paths//tags/{id}/articles/get/parameters/filter[publishedOn]/schema/items',
      '/paths//tags/{id}/relationships/articles/get/parameters/filter[publishedOn]/schema/items',
    ])
  })

  it('formats the filters that reach a date field through a relation', () => {
    const through = datedFilters(witness).filter(
      (at) => at.includes('articleReleasedOn') || at.includes('articlesPublishedAt'),
    )
    expect(through.filter((at) => at.endsWith('/items'))).toHaveLength(4)
    expect(through.filter((at) => !at.endsWith('/items'))).toHaveLength(4)
    expect(through.filter((at) => at.startsWith('/components/parameters/'))).toEqual([
      '/components/parameters/relatedQuery/schema/properties/tags/properties/filter/properties/articleReleasedOn',
      '/components/parameters/relatedQuery/schema/properties/tags/properties/filter/properties/articlesPublishedAt/items',
    ])
  })
})
