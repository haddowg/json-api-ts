import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import type { OpenApiDocument, SchemaObject } from './openapi'
import { documentPath } from '../test/documents'

const pinned = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument

const ref = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` })
const narrowing = (meta: SchemaObject): SchemaObject => ({
  type: 'object',
  properties: { meta },
})

/**
 * The witness with declared identifier meta, shaped as core projects it: a
 * `<Type><Rel>IdentifierMeta` component per relation, referenced from the response linkage's
 * `allOf` narrowing, alone on a to-one and a polymorphic to-many and over an `allOf` beside the
 * pivot. Written by hand until the pinned witness carries the structure.
 */
function withIdentifierMeta(): OpenApiDocument {
  const doc = structuredClone(pinned)
  doc.info!['x-generator'] = { contract: 28 }
  const schemas = doc.components!.schemas!
  schemas['ArticlesAuthorIdentifierMeta'] = {
    type: 'object',
    properties: { role: { type: 'string' }, primary: { type: ['boolean', 'null'] } },
    required: ['role', 'primary'],
  }
  schemas['ArticlesTagsIdentifierMeta'] = {
    type: 'object',
    properties: { addedVia: { type: ['string', 'null'] } },
    required: [],
  }
  schemas['ArticlesAttachmentsIdentifierMeta'] = {
    type: 'object',
    properties: { order: { type: ['integer', 'null'] } },
    required: ['order'],
  }
  schemas['ArticlesSubjectIdentifierMeta'] = {
    type: 'object',
    properties: { since: { type: 'string', format: 'date-time' } },
    required: ['since'],
  }

  const author = schemas['ArticlesAuthorRelationship']!.properties!['data'] as SchemaObject
  author.anyOf = [
    { allOf: [author.anyOf![0]!, narrowing(ref('ArticlesAuthorIdentifierMeta'))] },
    ...author.anyOf!.slice(1),
  ]

  const tags = schemas['ArticlesTagsRelationship']!.properties!['data'] as SchemaObject
  tags.items = {
    allOf: [
      ref('TagsResourceIdentifier'),
      narrowing({
        allOf: [
          ref('ArticlesTagsIdentifierMeta'),
          { type: 'object', properties: { pivot: ref('ArticlesTagsPivot') } },
        ],
      }),
    ],
  }

  const attachments = schemas['ArticlesAttachmentsRelationship']!.properties![
    'data'
  ] as SchemaObject
  attachments.items = {
    allOf: [attachments.items!, narrowing(ref('ArticlesAttachmentsIdentifierMeta'))],
  }

  const subject = schemas['ArticlesSubjectRelationship']!.properties!['data'] as SchemaObject
  subject.anyOf = [
    { allOf: [subject.anyOf![0]!, narrowing(ref('ArticlesSubjectIdentifierMeta'))] },
    ...subject.anyOf!.slice(1),
  ]

  return doc
}

describe('generator contract 28 (declared identifier meta)', () => {
  const doc = withIdentifierMeta()
  const relations = buildDescriptor(doc)['articles']!.relations
  const plain = buildDescriptor(pinned)['articles']!.relations

  it('reads the document without a warning', () => {
    expect(checkContract(doc)).toBeUndefined()
  })

  it('types a to-one linkage member meta', () => {
    expect(relations['author']).toEqual({
      ...plain['author'],
      identifierMeta: { fields: { primary: 'boolean', role: 'string' }, nullable: ['primary'] },
    })
  })

  it('types the declared meta beside the pivot', () => {
    expect(relations['tags']).toEqual({
      ...plain['tags'],
      identifierMeta: { fields: { addedVia: 'string' }, required: [], nullable: ['addedVia'] },
    })
    expect(relations['tags']!.readPivot).toEqual(plain['tags']!.readPivot)
    expect(relations['tags']!.writePivot).toEqual(plain['tags']!.writePivot)
  })

  it('keeps a polymorphic relation narrowed as a whole union', () => {
    expect(relations['attachments']).toEqual({
      ...plain['attachments'],
      identifierMeta: { fields: { order: 'integer' }, nullable: ['order'] },
    })
    expect(relations['subject']).toEqual({
      ...plain['subject'],
      identifierMeta: { fields: { since: 'date-time' } },
    })
  })

  it('leaves every other relation as it was', () => {
    for (const [name, relation] of Object.entries(plain)) {
      if (!['author', 'tags', 'attachments', 'subject'].includes(name)) {
        expect(relations[name]).toEqual(relation)
      }
    }
  })
})
