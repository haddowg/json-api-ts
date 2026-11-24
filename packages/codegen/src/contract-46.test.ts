import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument, SchemaObject } from './openapi'
import { documentPath } from '../test/documents'

const load = (name: 'contract-witness.json' | 'contract-witness-baseline.json') =>
  JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument
const witness = load('contract-witness.json')
const baseline = load('contract-witness-baseline.json')

/** A write request's `relationships` object, as the document projects it. */
const writeRelationships = (doc: OpenApiDocument, request: string): SchemaObject =>
  (doc.components!.schemas![request]!.properties!['data'] as SchemaObject).properties![
    'relationships'
  ] as SchemaObject

/**
 * A create requires its `attributes` when an attribute is required on create and its
 * `relationships` when a relation is, listing each such relation in `relationships.required`. A
 * write narrows a required relation's shared relationship object beside its reference in an
 * `allOf`: `minItems: 1` on a to-many, and no `null` on a to-one. The codegen reads the reference
 * through the `allOf`, and records which relations a create must send, which to-ones a write
 * refuses `null` for and which to-manies it refuses an empty list for, so the client types their
 * write inputs.
 */
describe('generator contract 46 (required writes)', () => {
  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(46)
    expect(baseline.info?.['x-generator']?.contract).toBe(46)
    expect(checkContract(witness)).toBeUndefined()
    expect(checkContract(baseline)).toBeUndefined()
  })

  it('reads the narrowed writes of people.company and tags.articles', () => {
    for (const doc of [witness, baseline]) {
      expect(writeRelationships(doc, 'PeopleCreateRequest').properties!['company']).toEqual({
        allOf: [
          { $ref: '#/components/schemas/PeopleCompanyRelationship' },
          { properties: { data: { type: 'object' } } },
        ],
      })
      expect(writeRelationships(doc, 'TagsCreateRequest').properties!['articles']).toEqual({
        allOf: [
          { $ref: '#/components/schemas/TagsArticlesRelationship' },
          { properties: { data: { minItems: 1 } } },
        ],
      })
    }
  })

  it('records the relations a create must send and the writes refusing null or an empty list', () => {
    for (const doc of [witness, baseline]) {
      const described = buildDescriptor(doc)
      expect(described['people']!.relations['company']).toMatchObject({
        cardinality: 'one',
        types: ['companies'],
        requiredOnCreate: true,
        nonNullOn: ['create', 'update'],
      })
      expect(described['tags']!.relations['articles']).toMatchObject({
        cardinality: 'many',
        types: ['articles'],
        requiredOnCreate: true,
        nonEmptyOn: ['create'],
      })
      // A relation no write requires carries none of the flags.
      for (const flag of ['requiredOnCreate', 'nonNullOn', 'nonEmptyOn']) {
        expect(described['articles']!.relations['author']).not.toHaveProperty(flag)
      }
    }
  })

  it('writes the flags into the generated descriptor', () => {
    const source = emit(witness, buildDescriptor(witness))
    const company = source.slice(
      source.indexOf('\n      company: {', source.indexOf('\n  people: {')),
    )
    expect(company.slice(0, company.indexOf('\n      },'))).toMatch(
      /requiredOnCreate: true,\s*nonNullOn: \[\s*"create",\s*"update"\s*\]/,
    )
  })

  // The witness narrows no write-only relation, so this narrows its write-only `watchers` in both
  // write bodies, as a write-only to-many with item bounds is, and checks the codegen still finds it.
  it('keeps a write-only relation whose writes both narrow it', () => {
    const bounded = structuredClone(witness)
    for (const request of ['ArticlesCreateRequest', 'ArticlesUpdateRequest']) {
      const properties = writeRelationships(bounded, request).properties as Record<
        string,
        SchemaObject
      >
      const { writeOnly, ...reference } = properties['watchers']!
      properties['watchers'] = {
        allOf: [reference, { properties: { data: { minItems: 1 } } }],
        ...(writeOnly === undefined ? {} : { writeOnly }),
      }
    }
    const relations = buildDescriptor(bounded)['articles']!.relations
    expect(relations['watchers']).toEqual({
      ...buildDescriptor(witness)['articles']!.relations['watchers'],
      nonEmptyOn: ['create', 'update'],
    })
    expect(relations['watchers']!.writeOnly).toBe(true)
  })
})
