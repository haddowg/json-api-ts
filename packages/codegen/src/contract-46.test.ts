import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract, MAXIMUM_CONTRACT } from './contract'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'
import { boundedWriteOnly, requiredWrites } from '../test/required-writes'

const load = (name: 'contract-witness.json' | 'contract-witness-baseline.json') =>
  JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument
const pinned = load('contract-witness.json')
const pinnedBaseline = load('contract-witness-baseline.json')
const witness = requiredWrites(pinned)
const baseline = requiredWrites(pinnedBaseline)

/** The generated client, but for the hash of the document it came from. */
const client = (doc: OpenApiDocument): string =>
  emit(doc, buildDescriptor(doc)).replace(/Spec hash: +\w+/, 'Spec hash')

/**
 * A create requires its `attributes` when an attribute is required on create and its
 * `relationships` when a relation is, listing each such relation in `relationships.required`. A
 * write narrows a required relation's shared relationship object beside its reference in an
 * `allOf`: `minItems: 1` on a to-many, and no `null` on a to-one. The codegen reads the reference
 * through the `allOf`, and records which relations a create must send and which to-ones a write
 * refuses `null` for, so the client types their write inputs.
 */
describe('generator contract 46 (required writes)', () => {
  it('reads a document stamped 46 without a warning, and warns past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(46)
    expect(checkContract(witness)).toBeUndefined()
    expect(checkContract(baseline)).toBeUndefined()
    const newer = { ...witness, info: { ...witness.info!, 'x-generator': { contract: 47 } } }
    expect(checkContract(newer as OpenApiDocument)).toContain('reads up to 46')
  })

  it('records the relations a create must send and the to-ones a write refuses null for', () => {
    for (const [narrowed, plain] of [
      [witness, pinned],
      [baseline, pinnedBaseline],
    ] as const) {
      const described = buildDescriptor(narrowed)
      expect(described['people']!.relations['company']).toEqual({
        ...buildDescriptor(plain)['people']!.relations['company'],
        requiredOnCreate: true,
        nonNullOn: ['create', 'update'],
      })
      expect(described['tags']!.relations['articles']).toEqual({
        ...buildDescriptor(plain)['tags']!.relations['articles'],
        requiredOnCreate: true,
      })
      // Nothing else moves.
      const plainly = buildDescriptor(plain)
      expect(described).toEqual({
        ...plainly,
        people: {
          ...plainly['people']!,
          relations: {
            ...plainly['people']!.relations,
            company: described['people']!.relations['company'],
          },
        },
        tags: {
          ...plainly['tags']!,
          relations: {
            ...plainly['tags']!.relations,
            articles: described['tags']!.relations['articles'],
          },
        },
      })
    }
  })

  it('writes the flags into the generated descriptor', () => {
    const source = client(witness)
    const company = source.slice(
      source.indexOf('\n      company: {', source.indexOf('\n  people: {')),
    )
    expect(company.slice(0, company.indexOf('\n      },'))).toMatch(
      /requiredOnCreate: true,\s*nonNullOn: \[\s*"create",\s*"update"\s*\]/,
    )
  })

  it('keeps a write-only relation whose writes both narrow it', () => {
    const bounded = boundedWriteOnly(witness)
    const relations = buildDescriptor(bounded)['articles']!.relations
    expect(relations['watchers']).toEqual(
      buildDescriptor(pinned)['articles']!.relations['watchers'],
    )
    expect(relations['watchers']!.writeOnly).toBe(true)
  })
})
