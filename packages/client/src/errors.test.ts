import { describe, expect, it } from 'vitest'
import { JsonApiError } from './errors'

describe('JsonApiError', () => {
  it('exposes expressive status matchers', () => {
    const err = new JsonApiError(403, [{ status: '403', code: 'FORBIDDEN' }])
    expect(err.isForbidden()).toBe(true)
    expect(err.is4xx()).toBe(true)
    expect(err.is5xx()).toBe(false)
    expect(err.hasStatus(403)).toBe(true)
  })

  it('groups validation errors by user-facing path', () => {
    const err = new JsonApiError(422, [
      { status: '422', source: { pointer: '/data/attributes/title' }, path: 'title' },
      { status: '422', source: { pointer: '/data/attributes/title' }, path: 'title' },
      { status: '422', source: { pointer: '/data/relationships/artist/data' }, path: 'artist' },
    ])

    const byPath = err.byPath()
    expect(err.isValidationError()).toBe(true)
    expect(byPath['title']).toHaveLength(2)
    expect(byPath['artist']).toHaveLength(1)
  })
})
