import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument, SchemaObject } from './openapi'
import { documentPath } from '../test/documents'

const witness = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument

/** The `links.location.type` narrowing of an action's location document. */
function locationType(doc: OpenApiDocument, path: string): SchemaObject {
  const schema = doc.paths![path]!.get!.responses!['200']!.content!['application/vnd.api+json']!
    .schema as SchemaObject
  const location = (schema.oneOf ?? [schema]).find((arm) => arm.allOf !== undefined)!
  const links = location.allOf![1]!.properties!['links'] as SchemaObject
  return (links.properties!['location'] as SchemaObject).properties!['type'] as SchemaObject
}

/**
 * An action whose URL's media type varies declares `application/octet-stream`, and its location
 * document's `type` is any string rather than a `const`. The codegen reads that as the declared
 * octet-stream type, as it read the `const` before, and the client types the URL's `type` as a
 * string either way.
 */
describe('generator contract 47 (a location type that varies)', () => {
  it('reads the document without a warning', () => {
    expect(witness.info!['x-generator']).toEqual({ contract: 47 })
    expect(locationType(witness, '/articles/{id}/-actions/revision')).toEqual({
      type: 'string',
      examples: ['application/octet-stream'],
    })
    expect(checkContract(witness)).toBeUndefined()
  })

  it('records the declared media type of an open and a fixed location type', () => {
    const actions = buildDescriptor(witness)['articles']!.actions!
    expect(actions['revision']!.location).toEqual({ mediaType: 'application/octet-stream' })
    expect(actions['download']!.location).toEqual({ mediaType: 'text/csv' })
  })

  it('emits the declared media type as the open location of the action', () => {
    expect(emit(witness, buildDescriptor(witness))).toMatch(
      /-actions\/revision",[^}]*location: \{\s*mediaType: "application\/octet-stream"\s*\}/,
    )
  })
})
