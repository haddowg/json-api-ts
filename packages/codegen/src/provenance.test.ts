import { describe, expect, it } from 'vitest'
import type { OpenApiDocument } from './openapi'
import { deriveProvenance, hashJson, provenanceLines } from './provenance'

function doc(overrides: Partial<OpenApiDocument> = {}): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'Music Catalog API', version: '1.0.0' },
    servers: [{ url: 'https://music.example' }],
    ...overrides,
  }
}

describe('deriveProvenance', () => {
  it('reads the source identifier from info.title + info.version', () => {
    expect(deriveProvenance(doc()).source).toBe('Music Catalog API 1.0.0')
  })

  it('reads the server from the first declared server URL', () => {
    expect(deriveProvenance(doc()).server).toBe('https://music.example')
  })

  it('falls back to `unknown` parts when info is absent', () => {
    const p = deriveProvenance({ openapi: '3.1.0' })
    expect(p.source).toBe('unknown unknown')
  })

  it('reports no server when none is declared', () => {
    expect(deriveProvenance({ openapi: '3.1.0' }).server).toBeUndefined()
  })

  it('produces a 16-hex content hash', () => {
    expect(deriveProvenance(doc()).hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic for the same document', () => {
    expect(deriveProvenance(doc()).hash).toBe(deriveProvenance(doc()).hash)
  })

  it('is insensitive to object key ordering (canonicalised)', () => {
    const a = deriveProvenance({ info: { title: 'A', version: '1' }, openapi: '3.1.0' })
    const b = deriveProvenance({ openapi: '3.1.0', info: { version: '1', title: 'A' } })
    expect(a.hash).toBe(b.hash)
  })

  it('changes the hash when the spec content changes', () => {
    const base = deriveProvenance(doc()).hash
    const changed = deriveProvenance(doc({ paths: { '/albums': { get: {} } } })).hash
    expect(changed).not.toBe(base)
  })
})

describe('hashJson', () => {
  it('hashes arbitrary JSON deterministically, key-order-insensitively', () => {
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }))
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }))
  })

  it('preserves array order (significant)', () => {
    expect(hashJson([1, 2])).not.toBe(hashJson([2, 1]))
  })
})

describe('provenanceLines', () => {
  it('renders source, server and hash as prefixed JSDoc lines', () => {
    const lines = provenanceLines(deriveProvenance(doc()))
    expect(lines).toEqual([
      ' * Source spec: Music Catalog API 1.0.0',
      ' * Server:      https://music.example',
      ' * Spec hash:   ' + deriveProvenance(doc()).hash,
    ])
  })

  it('omits the server line when no server is declared', () => {
    const lines = provenanceLines(
      deriveProvenance({ info: { title: 'A', version: '1' }, openapi: '3.1.0' }),
    )
    expect(lines.some((l) => l.includes('Server:'))).toBe(false)
    expect(lines.some((l) => l.includes('Source spec:'))).toBe(true)
    expect(lines.some((l) => l.includes('Spec hash:'))).toBe(true)
  })
})
