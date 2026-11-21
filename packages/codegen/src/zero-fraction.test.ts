import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { hashJson } from './provenance'
import { documentPath } from '../test/documents'

const text = readFileSync(documentPath('contract-witness.json'), 'utf8')

/**
 * The pinned witness writes whole floats with their fraction: the articles' `rating` bounds read
 * `0.0` and `10.0`, and the `reading` union's bound reads `1.0`. This copy writes them without one.
 */
const withoutFractions = text
  .replaceAll('"exclusiveMinimum": 0.0,', '"exclusiveMinimum": 0,')
  .replaceAll(/"exclusiveMaximum": 10\.0(\s)/g, '"exclusiveMaximum": 10$1')
  .replaceAll(/"maximum": 1\.0(\s)/g, '"maximum": 1$1')

describe('a document whose whole floats keep their fraction', () => {
  it('generates the same client, with the same provenance hash', () => {
    expect(withoutFractions).not.toBe(text)
    const before = JSON.parse(withoutFractions) as OpenApiDocument
    const after = JSON.parse(text) as OpenApiDocument
    expect(hashJson(after)).toBe(hashJson(before))
    expect(emit(after, buildDescriptor(after))).toBe(emit(before, buildDescriptor(before)))
  })
})
