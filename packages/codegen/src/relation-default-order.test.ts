import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { emit } from './emit'
import type { OpenApiDocument, OperationObject } from './openapi'
import { documentPath } from '../test/documents'

const witness = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument

/** The `sort` parameter of an operation, which the test documents always carry. */
function sortOf(op: OperationObject | undefined) {
  const sort = op?.parameters?.find((param) => param.name === 'sort')
  expect(sort?.schema).toBeDefined()
  return sort!.schema!
}

/** The witness with `tags` declaring a default read order on the endpoints named. */
function withDefaultOrder(
  order: unknown,
  endpoints: readonly ('related' | 'relationship')[] = ['related', 'relationship'],
): OpenApiDocument {
  const doc = structuredClone(witness)
  if (endpoints.includes('related')) {
    sortOf(doc.paths!['/articles/{id}/tags']!.get).default = order
  }
  if (endpoints.includes('relationship')) {
    sortOf(doc.paths!['/articles/{id}/relationships/tags']!.get).default = order
  }
  return doc
}

const TAGS_DOC = [
  '      /**',
  '       * Without a `sort`, the server reads its members ordered by `label`, then `-id`.',
  '       *',
  '       * OAuth scopes:',
]

/**
 * A to-many relation's declared default read order is the `default` of the `sort` parameter on its
 * related and relationship reads. No contract tier comes with it: the server applies the order
 * whether or not the client knows it, so the codegen only says so in the relation's JSDoc.
 */
describe("a relation's default read order", () => {
  it('names the order in the JSDoc of the relation', () => {
    const doc = withDefaultOrder(['label', '-id'])
    const source = emit(doc, buildDescriptor(doc))
    expect(source).toContain(TAGS_DOC.join('\n'))
  })

  it('reads it from the relationship read when the related read declares none', () => {
    const doc = withDefaultOrder(['label', '-id'], ['relationship'])
    expect(emit(doc, buildDescriptor(doc))).toContain(TAGS_DOC.join('\n'))
  })

  it('reads a comma-separated default', () => {
    const doc = withDefaultOrder('label,-id')
    expect(emit(doc, buildDescriptor(doc))).toContain(TAGS_DOC.join('\n'))
  })

  it('leaves the descriptor as it was', () => {
    expect(buildDescriptor(withDefaultOrder(['label', '-id']))).toEqual(buildDescriptor(witness))
  })

  it('says nothing for a relation that declares no default', () => {
    const source = emit(witness, buildDescriptor(witness))
    expect(source).not.toContain('Without a `sort`')
  })

  it('ignores a default that is not a list of sort tokens', () => {
    for (const order of [[], [1], ['']]) {
      const doc = withDefaultOrder(order)
      expect(emit(doc, buildDescriptor(doc))).not.toContain('Without a `sort`')
    }
  })
})
