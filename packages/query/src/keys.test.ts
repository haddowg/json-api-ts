import { describe, expect, it } from 'vitest'
import {
  INFINITE_SEGMENT,
  infiniteKeyFor,
  keyFor,
  keyHasPrefix,
  normalizeParams,
  operationKey,
  type QueryKey,
  relationReadKeys,
  resourceKey,
  SKIPPED_SEGMENT,
  typeKey,
} from './keys'

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

describe('relationReadKeys / keyHasPrefix (D35b)', () => {
  it('returns BOTH the related and relationship prefixes for a (parent, relation)', () => {
    expect(relationReadKeys('playlists', '1', 'tracks')).toEqual([
      ['playlists', 'fetchRelated', '1', 'tracks'],
      ['playlists', 'fetchRelationship', '1', 'tracks'],
    ])
  })

  it('each prefix matches its read key across ALL page/param variants', () => {
    const [related, relationship] = relationReadKeys('playlists', '1', 'tracks')
    const relatedPage1 = keyFor(
      { type: 'playlists', operation: 'fetchRelated', id: '1', rel: 'tracks' },
      { page: { size: 50 } },
    )
    const relatedPage2 = keyFor(
      { type: 'playlists', operation: 'fetchRelated', id: '1', rel: 'tracks' },
      { page: { number: 2, size: 10 } },
    )
    const linkage = keyFor({
      type: 'playlists',
      operation: 'fetchRelationship',
      id: '1',
      rel: 'tracks',
    })
    // The related prefix covers every page variant of the related read...
    expect(keyHasPrefix(relatedPage1, related)).toBe(true)
    expect(keyHasPrefix(relatedPage2, related)).toBe(true)
    // ...and the relationship prefix covers the linkage read.
    expect(keyHasPrefix(linkage, relationship)).toBe(true)
    // Cross-surface / cross-relation keys do not match.
    expect(keyHasPrefix(relatedPage1, relationship)).toBe(false)
    expect(
      keyHasPrefix(
        keyFor({ type: 'playlists', operation: 'fetchRelated', id: '1', rel: 'owner' }),
        related,
      ),
    ).toBe(false)
  })

  it('keyHasPrefix rejects a key shorter than the prefix', () => {
    expect(
      keyHasPrefix(['playlists', 'fetchRelated'], ['playlists', 'fetchRelated', '1', 'tracks']),
    ).toBe(false)
  })
})

describe('infiniteKeyFor', () => {
  it("appends '$infinite' after the plain read's key and its params", () => {
    const list = { type: 'albums', operation: 'fetchMany' } as const
    expect(infiniteKeyFor(list)).toEqual(['albums', 'fetchMany', INFINITE_SEGMENT])
    expect(infiniteKeyFor(list, { page: { size: 2 } })).toEqual([
      'albums',
      'fetchMany',
      { page: { size: 2 } },
      INFINITE_SEGMENT,
    ])
    // An empty query adds no params segment, as for the plain read.
    expect(infiniteKeyFor(list, {})).toEqual(['albums', 'fetchMany', INFINITE_SEGMENT])
  })

  it("keeps every prefix of the plain read's key", () => {
    const key = infiniteKeyFor(
      { type: 'albums', operation: 'fetchRelated', id: '1', rel: 'tracks' },
      { page: { size: 2 } },
    )
    expect(keyHasPrefix(key, typeKey('albums'))).toBe(true)
    expect(keyHasPrefix(key, relationReadKeys('albums', '1', 'tracks')[0])).toBe(true)
    expect(keyHasPrefix(key, ['albums', 'fetchRelated', '2'])).toBe(false)
  })
})

describe('SKIPPED_SEGMENT', () => {
  it('is a frozen object segment, so no id or relation name can equal it', () => {
    expect(SKIPPED_SEGMENT).toEqual({ $skip: true })
    expect(Object.isFrozen(SKIPPED_SEGMENT)).toBe(true)
  })

  it('keyHasPrefix compares it by value, as TanStack matches keys', () => {
    const skipped: QueryKey = ['albums', 'fetchRelated', SKIPPED_SEGMENT, 'tracks']
    const rebuilt = JSON.parse(JSON.stringify(skipped)) as QueryKey
    expect(keyHasPrefix(rebuilt, ['albums', 'fetchRelated', SKIPPED_SEGMENT])).toBe(true)
    expect(keyHasPrefix(rebuilt, skipped)).toBe(true)
    // An id spelt like the old string segment, or a params object that merely carries `$skip`,
    // is not a skipped read.
    expect(keyHasPrefix(['albums', 'fetchRelated', '$skip', 'tracks'], skipped)).toBe(false)
    expect(
      keyHasPrefix(['albums', 'fetchRelated', { $skip: true, x: 1 }], skipped.slice(0, 3)),
    ).toBe(false)
  })
})
