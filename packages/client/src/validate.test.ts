import { describe, expect, it, vi } from 'vitest'
import type { ApiDescriptor } from './descriptor'
import { StructuralGuardError } from './errors'
import { materialise, type MaterialiseContext } from './materialise'
import type { Document } from './request'
import {
  assertJsonApiDocument,
  resolveValidator,
  validateDocument,
  type SchemaMap,
  type WireResource,
} from './validate'

const descriptor: ApiDescriptor = {
  albums: { attributes: {}, relations: {}, paths: {}, paginator: 'page', clientId: 'optional' },
  tracks: { attributes: {}, relations: {}, paths: {}, paginator: 'page', clientId: 'optional' },
}

const ctx = (validate?: MaterialiseContext['validate']): MaterialiseContext => ({
  descriptor,
  navigate: async () => undefined,
  validate,
})

describe('assertJsonApiDocument — light structural guards', () => {
  it('rejects a non-object body', () => {
    expect(() => assertJsonApiDocument('nope')).toThrow(StructuralGuardError)
    expect(() => assertJsonApiDocument(null)).toThrow(StructuralGuardError)
    expect(() => assertJsonApiDocument([])).toThrow(StructuralGuardError)
  })

  it('rejects an object with neither data nor meta (not a JSON:API document)', () => {
    expect(() => assertJsonApiDocument({ foo: 'bar' })).toThrow(StructuralGuardError)
  })

  it('rejects a primary resource missing type', () => {
    expect(() => assertJsonApiDocument({ data: { id: '1' } })).toThrow(/missing a string "type"/)
  })

  it('rejects a primary resource missing id', () => {
    expect(() => assertJsonApiDocument({ data: { type: 'albums' } })).toThrow(
      /missing a string "id"/,
    )
  })

  it('rejects a collection member missing type+id', () => {
    expect(() =>
      assertJsonApiDocument({ data: [{ type: 'albums', id: '1' }, { id: '2' }] }),
    ).toThrow(/data\[1\] is missing a string "type"/)
  })

  it('rejects an included member missing id', () => {
    const doc = { data: { type: 'albums', id: '1' }, included: [{ type: 'artists' }] }
    expect(() => assertJsonApiDocument(doc)).toThrow(/included\[0\].+missing a string "id"/)
  })

  it('rejects a non-array included', () => {
    const doc = { data: { type: 'albums', id: '1' }, included: { type: 'artists', id: '1' } }
    expect(() => assertJsonApiDocument(doc)).toThrow(/"included" is not an array/)
  })

  it('accepts a single resource, a collection, null data, and a meta-only document', () => {
    expect(() => assertJsonApiDocument({ data: { type: 'albums', id: '1' } })).not.toThrow()
    expect(() => assertJsonApiDocument({ data: [{ type: 'albums', id: '1' }] })).not.toThrow()
    expect(() => assertJsonApiDocument({ data: null })).not.toThrow()
    expect(() => assertJsonApiDocument({ meta: { total: 0 } })).not.toThrow()
  })
})

describe('materialise — structural guards always run', () => {
  it('throws StructuralGuardError on a type-less wire resource (no validator configured)', () => {
    const doc = { data: { id: '1', attributes: { title: 'x' } } } as unknown as Document
    expect(() => materialise(doc, ctx())).toThrow(StructuralGuardError)
  })

  it('materialises a well-formed document with no validator (guards pass, no validation)', () => {
    const doc: Document = { data: { type: 'albums', id: '1', attributes: { title: 'x' } } }
    const res = materialise(doc, ctx()) as Record<string, unknown>
    expect(res['title']).toBe('x')
  })
})

describe('resolveValidator — seam normalisation', () => {
  const schemas: SchemaMap = { albums: { kind: 'albums-schema' } }

  it('returns undefined when validation is off', () => {
    expect(resolveValidator(undefined)).toBeUndefined()
  })

  it('config form: looks the schema up by type and passes it to the validator', () => {
    const validator = vi.fn<(r: WireResource, s: unknown) => void>()
    const resolved = resolveValidator({ schemas, validator })!
    const resource: WireResource = { type: 'albums', id: '1' }
    resolved.validate(resource)
    expect(validator).toHaveBeenCalledWith(resource, { kind: 'albums-schema' })
  })

  it('config form: skips a type with no schema (partial coverage is graceful)', () => {
    const validator = vi.fn<(r: WireResource, s: unknown) => void>()
    const resolved = resolveValidator({ schemas, validator })!
    resolved.validate({ type: 'tracks', id: '9' })
    expect(validator).not.toHaveBeenCalled()
  })

  it('bare-function form: calls the validator with schema undefined', () => {
    const validator = vi.fn<(r: WireResource, s: unknown) => void>()
    const resolved = resolveValidator(validator)!
    const resource: WireResource = { type: 'tracks', id: '9' }
    resolved.validate(resource)
    expect(validator).toHaveBeenCalledWith(resource, undefined)
  })
})

describe('validateDocument — only full resource objects, not linkage identifiers', () => {
  it('validates full resources (data + included) but skips bare identifiers', () => {
    const validator = vi.fn<(r: WireResource, s: unknown) => void>()
    const resolved = resolveValidator(validator)!
    // A relationship-linkage response: `data` is bare identifiers (no attributes/relationships).
    validateDocument(
      {
        data: [
          { type: 'tracks', id: '1', meta: { served_by: 'x' } },
          { type: 'tracks', id: '2' },
        ],
      },
      resolved,
    )
    expect(validator).not.toHaveBeenCalled()

    // A resource/collection response: full resource objects (and includes) are validated.
    validateDocument(
      {
        data: { type: 'albums', id: '1', attributes: { title: 'X' } },
        included: [{ type: 'tracks', id: '1', attributes: { name: 'Y' } }],
      },
      resolved,
    )
    expect(validator).toHaveBeenCalledTimes(2)
  })
})
