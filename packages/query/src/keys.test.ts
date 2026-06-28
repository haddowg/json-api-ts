import { describe, expect, it } from 'vitest'
import { keyFor, normalizeParams, operationKey, resourceKey, typeKey } from './keys'

describe('normalizeParams', () => {
  it('sorts object keys recursively so authoring order is irrelevant', () => {
    const a = normalizeParams({ b: 1, a: { d: 4, c: 3 } })
    const b = normalizeParams({ a: { c: 3, d: 4 }, b: 1 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(Object.keys(a as object)).toEqual(['a', 'b'])
    expect(Object.keys((a as { a: object }).a)).toEqual(['c', 'd'])
  })

  it('preserves array order (order is meaningful for sort/include)', () => {
    expect(normalizeParams(['title', '-year'])).toEqual(['title', '-year'])
    expect(normalizeParams(['-year', 'title'])).toEqual(['-year', 'title'])
  })

  it('drops undefined members and maps null through', () => {
    expect(normalizeParams({ a: undefined, b: 1 })).toEqual({ b: 1 })
    expect(normalizeParams(null)).toBeNull()
    expect(normalizeParams(undefined)).toBeNull()
  })
})

describe('keyFor', () => {
  it('produces a stable hierarchical prefix [type, operation, id?, rel?]', () => {
    expect(keyFor({ type: 'albums', operation: 'fetchMany' })).toEqual(['albums', 'fetchMany'])
    expect(keyFor({ type: 'albums', operation: 'fetchOne', id: '1' })).toEqual([
      'albums',
      'fetchOne',
      '1',
    ])
    expect(keyFor({ type: 'albums', operation: 'fetchRelated', id: '1', rel: 'tracks' })).toEqual([
      'albums',
      'fetchRelated',
      '1',
      'tracks',
    ])
  })

  it('is param-order independent (semantically-equal queries share a key)', () => {
    const a = keyFor(
      { type: 'albums', operation: 'fetchMany' },
      { sort: 'title', filter: { q: 'x' } },
    )
    const b = keyFor(
      { type: 'albums', operation: 'fetchMany' },
      { filter: { q: 'x' }, sort: 'title' },
    )
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('distinguishes keys whose param values differ', () => {
    const a = keyFor({ type: 'albums', operation: 'fetchMany' }, { filter: { q: 'x' } })
    const b = keyFor({ type: 'albums', operation: 'fetchMany' }, { filter: { q: 'y' } })
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it('unifies a bare read with an empty-params read (no trailing segment)', () => {
    const bare = keyFor({ type: 'albums', operation: 'fetchMany' })
    const empty = keyFor({ type: 'albums', operation: 'fetchMany' }, {})
    const undef = keyFor({ type: 'albums', operation: 'fetchMany' }, undefined)
    expect(bare).toEqual(empty)
    expect(bare).toEqual(undef)
    expect(bare).toHaveLength(2)
  })

  it('appends the normalised params as a single trailing segment', () => {
    const key = keyFor({ type: 'albums', operation: 'fetchMany' }, { sort: ['title'] })
    expect(key).toHaveLength(3)
    expect(key[2]).toEqual({ sort: ['title'] })
  })
})

describe('hierarchical prefixes', () => {
  it('typeKey is a prefix of every operation key of the type', () => {
    const prefix = typeKey('albums')
    const full = keyFor({ type: 'albums', operation: 'fetchOne', id: '1' }, { include: ['artist'] })
    expect(full.slice(0, prefix.length)).toEqual(prefix)
  })

  it('operationKey is a prefix of a list read regardless of params', () => {
    const prefix = operationKey('albums', 'fetchMany')
    const full = keyFor({ type: 'albums', operation: 'fetchMany' }, { filter: { q: 'x' } })
    expect(full.slice(0, prefix.length)).toEqual(prefix)
  })

  it('resourceKey is a prefix of a single-resource read regardless of params', () => {
    const prefix = resourceKey('albums', '1')
    const full = keyFor({ type: 'albums', operation: 'fetchOne', id: '1' }, { include: ['artist'] })
    expect(full.slice(0, prefix.length)).toEqual(prefix)
  })
})
