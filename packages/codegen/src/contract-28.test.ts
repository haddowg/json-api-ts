import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import type { OpenApiDocument, SchemaObject } from './openapi'
import { documentPath } from '../test/documents'

const witness = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument

/**
 * The witness with its declared identifier meta taken back out of the response linkage: alone on
 * the `author` to-one and the polymorphic `attachments`, and over an `allOf` beside the pivot on
 * `tags`.
 */
function withoutIdentifierMeta(): OpenApiDocument {
  const doc = structuredClone(witness)
  const schemas = doc.components!.schemas!

  const author = schemas['ArticlesAuthorRelationship']!.properties!['data'] as SchemaObject
  author.anyOf = [author.anyOf![0]!.allOf![0]!, ...author.anyOf!.slice(1)]

  const tags = schemas['ArticlesTagsRelationship']!.properties!['data'] as SchemaObject
  const narrowing = tags.items!.allOf![1]!
  narrowing.properties!['meta'] = (narrowing.properties!['meta'] as SchemaObject).allOf![1]!

  const attachments = schemas['ArticlesAttachmentsRelationship']!.properties![
    'data'
  ] as SchemaObject
  attachments.items = attachments.items!.allOf![0]!

  return doc
}

/**
 * Core's witness declares identifier meta on three of articles' relations: `author` (a to-one),
 * `tags` (beside its pivot) and `attachments` (polymorphic).
 */
describe('generator contract 28 (declared identifier meta)', () => {
  const relations = buildDescriptor(witness)['articles']!.relations
  const plain = buildDescriptor(withoutIdentifierMeta())['articles']!.relations

  it('reads the witness without a warning', () => {
    expect(checkContract(witness)).toBeUndefined()
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
      identifierMeta: { fields: { addedVia: 'string' }, nullable: ['addedVia'] },
    })
    expect(relations['tags']!.readPivot).toEqual(plain['tags']!.readPivot)
    expect(relations['tags']!.writePivot).toEqual(plain['tags']!.writePivot)
  })

  it('keeps a polymorphic relation narrowed as a whole union', () => {
    expect(relations['attachments']).toEqual({
      ...plain['attachments'],
      identifierMeta: { fields: { order: 'integer' }, nullable: ['order'] },
    })
    expect(relations['attachments']!.polymorphic).toBe(true)
  })

  it('leaves every other relation as it was', () => {
    for (const [name, relation] of Object.entries(plain)) {
      if (!['author', 'tags', 'attachments'].includes(name)) {
        expect(relations[name]).toEqual(relation)
        expect(relation.identifierMeta).toBeUndefined()
      }
    }
  })
})
