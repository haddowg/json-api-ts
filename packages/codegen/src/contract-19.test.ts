import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { Included, RelatedIncluded } from '../test/generated/contract-witness.client.gen'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument, SchemaObject } from './openapi'

function load(): OpenApiDocument {
  const path = fileURLToPath(
    new URL('../test/fixtures/contract-witness.openapi.json', import.meta.url),
  )
  return JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument
}

const witness = load()
const descriptor = buildDescriptor(witness)

/**
 * The witness as an older server wrote it: each discriminated `oneOf` an `anyOf` of the same
 * members, and every `included` item an untyped `{type, id}`.
 */
function undiscriminated(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(undiscriminated)
  }
  if (typeof node !== 'object' || node === null) {
    return node
  }
  const schema = node as SchemaObject
  const included = schema.properties?.['included']
  if (typeof included === 'object' && Array.isArray(included.items?.oneOf)) {
    const item = { type: 'object', required: ['type', 'id'] }
    return undiscriminated({
      ...schema,
      properties: { ...schema.properties, included: { ...included, items: item } },
    })
  }
  const discriminator = schema['discriminator'] as { propertyName?: string } | undefined
  if (Array.isArray(schema.oneOf) && discriminator?.propertyName === 'type') {
    const { oneOf, discriminator: _discriminator, ...rest } = schema
    return undiscriminated({ ...rest, anyOf: oneOf })
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, undiscriminated(value)]),
  )
}

const withoutIncluded = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, member: unknown) => (key === 'included' ? undefined : member)),
  )

describe('generator contract 19 (discriminated unions, typed included)', () => {
  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(19)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('reads a discriminated oneOf as the polymorphic relation an anyOf was', () => {
    const relations = descriptor['articles']!.relations
    expect(relations['subject']).toMatchObject({ types: ['people'], polymorphic: true })
    expect(relations['gallery']).toMatchObject({ types: ['images'], polymorphic: true })
    expect(relations['attachments']).toMatchObject({
      cardinality: 'many',
      types: ['images', 'videos'],
      polymorphic: true,
    })
  })

  it('reads an older document the same way, without the typed included', () => {
    const older = buildDescriptor(undiscriminated(load()) as OpenApiDocument)
    expect(JSON.stringify(older)).not.toContain('"included"')
    expect(older).toEqual(withoutIncluded(descriptor))
  })

  it('lists the types a compound document can carry, per type and per related read', () => {
    expect(descriptor['articles']!.included).toEqual(['people', 'tags'])
    expect(descriptor['articles']!.relations['tags']!.included).toEqual(['articles'])
    // A type with nothing to include, and a related read with nothing to include, list none.
    expect(descriptor['tags']).not.toHaveProperty('included')
    expect(descriptor['articles']!.relations['author']).not.toHaveProperty('included')
  })

  it('takes a member type from the discriminator mapping when its component has no type const', () => {
    const doc: OpenApiDocument = {
      openapi: '3.1.0',
      paths: {
        '/notes': { get: { responses: { '200': {} } } },
        '/notes/{id}/relationships/about': { get: { responses: {} } },
      },
      components: {
        schemas: {
          NotesResource: {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'notes' },
              relationships: {
                type: 'object',
                properties: { about: { $ref: '#/components/schemas/NotesAboutRelationship' } },
              },
            },
          },
          NotesAboutRelationship: {
            type: 'object',
            properties: {
              data: {
                anyOf: [
                  {
                    oneOf: [{ $ref: '#/components/schemas/ThingsResourceIdentifier' }],
                    discriminator: {
                      propertyName: 'type',
                      mapping: { things: '#/components/schemas/ThingsResourceIdentifier' },
                    },
                  },
                  { type: 'null' },
                ],
              },
            },
          },
          ThingsResourceIdentifier: {
            type: 'object',
            properties: { type: { type: 'string' }, id: { type: 'string' } },
          },
        },
      },
    }
    expect(buildDescriptor(doc)['notes']!.relations['about']).toMatchObject({
      cardinality: 'one',
      types: ['things'],
      polymorphic: true,
    })
  })

  it('types the included of a read by the types it can carry', () => {
    expectTypeOf<Included<'articles'>['type']>().toEqualTypeOf<'people' | 'tags'>()
    expectTypeOf<RelatedIncluded<'articles', 'tags'>['type']>().toEqualTypeOf<'articles'>()
    // Without a list, every type the server declares.
    expectTypeOf<Included<'tags'>['type']>().toEqualTypeOf<
      'articles' | 'healthcheck' | 'images' | 'people' | 'tags' | 'videos'
    >()
  })

  it('emits the included aliases', () => {
    const source = emit(witness, descriptor)
    expect(source).toContain('export type Included<T extends TypeName<ResourceMap>>')
    expect(source).toContain('export type RelatedIncluded<')
  })
})
