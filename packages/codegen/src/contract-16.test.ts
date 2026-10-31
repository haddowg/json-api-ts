import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isPolymorphic } from '@haddowg/json-api-client'
import { describe, expect, it } from 'vitest'
import { buildAtomic, buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument, SchemaObject } from './openapi'

function load(name: string): OpenApiDocument {
  const path = fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument
}

const witness = load('contract-witness.openapi.json')

/** A descriptor without the members contract 16 adds, nor the typed `included` it can't read. */
const strip = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, member: unknown) =>
      key === 'scopes' || key === 'polymorphic' || key === 'included' ? undefined : member,
    ),
  )
const descriptor = buildDescriptor(witness)

/** Replace every one-member union of `$ref`s with the bare `$ref`, as contract 15 wrote it. */
function collapseSingleUnions(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(collapseSingleUnions)
  }
  if (typeof node !== 'object' || node === null) {
    return node
  }
  const schema = node as SchemaObject
  const included = schema.properties?.['included']
  if (typeof included === 'object' && Array.isArray(included.items?.oneOf)) {
    // Before typed `included`, its items were an untyped `{type, id}`.
    const item = { type: 'object', required: ['type', 'id'] }
    return collapseSingleUnions({
      ...schema,
      properties: { ...schema.properties, included: { ...included, items: item } },
    })
  }
  const union = schema.oneOf ?? schema.anyOf
  if (Array.isArray(union) && union.length === 1 && typeof union[0]!.$ref === 'string') {
    const { anyOf: _anyOf, oneOf: _oneOf, discriminator: _discriminator, ...rest } = schema
    return { ...rest, $ref: union[0]!.$ref }
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, collapseSingleUnions(value)]),
  )
}

/**
 * The witness as a server before contract 16 projects it: no scopes, no one-type unions, and no
 * typed `included`.
 */
function beforeContract16(): OpenApiDocument {
  const doc = collapseSingleUnions(load('contract-witness.openapi.json')) as OpenApiDocument
  doc.info = { ...doc.info, 'x-generator': { contract: 15 } }
  for (const item of Object.values(doc.paths!)) {
    for (const op of Object.values(item)) {
      if (op.security?.some((requirement) => 'oauth2' in requirement)) {
        delete op.security
      }
    }
  }
  delete doc.components!.securitySchemes!['oauth2']
  return doc
}

describe('generator contract 16 (operation scopes, one-type polymorphic relations)', () => {
  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(19)
    expect(checkContract(witness)).toBeUndefined()
  })

  describe('operation scopes', () => {
    it("carries the music catalogue's scopes", () => {
      const music = load('music-catalog.openapi.json')
      expect(music.info?.['x-generator']?.contract).toBeGreaterThanOrEqual(16)
      const albums = buildDescriptor(music)['albums']!
      expect(albums.scopes?.['create']).toEqual(['catalog:write'])
      expect(albums.scopes?.['fetchCollection']).toBeUndefined()
      expect(albums.actions?.['artwork']?.scopes).toEqual(['catalog:write', 'catalog:media'])
    })

    it('carries the scopes of every kind of operation', () => {
      const articles = descriptor['articles']!
      expect(articles.scopes?.['fetchCollection']).toEqual(['articles:read'])
      expect(articles.scopes?.['create']).toEqual(['articles:write'])
      expect(articles.scopes?.['delete']).toEqual(['articles:write'])
      expect(articles.scopes?.['fetchRelated.author']).toEqual(['articles:read', 'people:read'])
      expect(articles.scopes?.['fetchRelationship.subject']).toEqual([
        'articles:read',
        'people:read',
      ])
      expect(articles.scopes?.['addRelationship.tags']).toEqual(['articles:write'])
      expect(articles.actions?.['publish']?.scopes).toEqual(['articles:publish'])
      expect(buildAtomic(witness)).toEqual({ path: '/operations', scopes: ['batch'] })
    })

    it('leaves them out when an operation needs none', () => {
      // `fetchCollection.people` is public (`security: []`); the rest inherit the bearer default.
      expect(descriptor['people']!.scopes).toEqual({
        fetchOne: ['people:read'],
        'fetchRelationship.company': ['companies:read'],
      })
      expect(descriptor['videos']!.scopes).toBeUndefined()
      expect(descriptor['articles']!.actions?.['report']).not.toHaveProperty('scopes')
    })

    it('reads scopes only under an oauth2 scheme, whatever its name', () => {
      const doc = load('contract-witness.openapi.json')
      const schemes = doc.components!.securitySchemes!
      schemes['partner'] = schemes['oauth2']!
      delete schemes['oauth2']
      doc.paths!['/articles']!.get!.security = [{ partner: ['articles:read'] }]
      doc.paths!['/articles']!.post!.security = [{ apiKey: ['articles:write'] }]
      const articles = buildDescriptor(doc)['articles']!
      expect(articles.scopes?.['fetchCollection']).toEqual(['articles:read'])
      expect(articles.scopes?.['create']).toBeUndefined()
    })

    it('names the scopes in the JSDoc', () => {
      const source = emit(witness, descriptor)
      expect(source).toContain(
        '      /** Needs the OAuth scope `articles:read`. */\n      fetchOne: "/articles/{id}"',
      )
      expect(source).toContain(
        [
          '      /**',
          '       * OAuth scopes:',
          '       *',
          '       * - `fetchRelated` needs `articles:read` and `people:read`',
          '       * - `fetchRelationship` needs `articles:read` and `people:read`',
          '       * - `updateRelationship` needs `articles:write`',
          '       */',
          '      subject: {',
        ].join('\n'),
      )
      expect(source).toContain(' * Needs the OAuth scope `batch`.\n */\nexport const atomic')
    })
  })

  describe('polymorphic relations', () => {
    const relations = descriptor['articles']!.relations

    it('marks a relation polymorphic over one type', () => {
      expect(relations['subject']).toMatchObject({
        cardinality: 'one',
        types: ['people'],
        polymorphic: true,
      })
      expect(relations['gallery']).toMatchObject({
        cardinality: 'many',
        types: ['images'],
        polymorphic: true,
      })
      expect(isPolymorphic(relations['subject']!)).toBe(true)
    })

    it('marks a relation over several types the same way', () => {
      expect(relations['attachments']).toMatchObject({
        cardinality: 'many',
        types: ['images', 'videos'],
        polymorphic: true,
      })
    })

    it('leaves a relation to one type unmarked', () => {
      expect(relations['author']).not.toHaveProperty('polymorphic')
      expect(isPolymorphic(relations['author']!)).toBe(false)
    })

    it('falls back to the type count without the flag', () => {
      expect(isPolymorphic({ types: ['a', 'b'] })).toBe(true)
      expect(isPolymorphic({ types: ['a'] })).toBe(false)
      expect(isPolymorphic({ types: ['a'], polymorphic: true })).toBe(true)
    })
  })

  describe('a document from before contract 16', () => {
    const before = buildDescriptor(beforeContract16())

    it('carries no scopes', () => {
      for (const resource of Object.values(before)) {
        expect(resource.scopes).toBeUndefined()
        for (const action of Object.values(resource.actions ?? {})) {
          expect(action.scopes).toBeUndefined()
        }
      }
      expect(buildAtomic(beforeContract16())).toEqual({ path: '/operations' })
    })

    it('reads a one-type relation as a plain one', () => {
      const relations = before['articles']!.relations
      expect(relations['subject']).not.toHaveProperty('polymorphic')
      expect(relations['gallery']).not.toHaveProperty('polymorphic')
      expect(relations['attachments']).toMatchObject({ polymorphic: true })
    })

    it('differs from the contract 16 descriptor only in the new members', () => {
      expect(strip(before)).toEqual(strip(descriptor))
    })
  })
})
