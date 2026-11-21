import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { emit } from './emit'
import type { OpenApiDocument, SchemaObject } from './openapi'

const actionBody = (component: string) => ({
  required: true,
  content: {
    'application/vnd.api+json': { schema: { $ref: `#/components/schemas/${component}` } },
  },
})
const collectionGet = (component: string) => ({
  responses: {
    '200': {
      content: {
        'application/vnd.api+json': { schema: { $ref: `#/components/schemas/${component}` } },
      },
    },
  },
})
const resourceOf = (type: string): SchemaObject => ({
  type: 'object',
  properties: {
    type: { type: 'string', const: type },
    id: { type: 'string' },
    attributes: { type: 'object', properties: {} },
  },
})

const text: SchemaObject = { type: 'string' }
const built = (doc: OpenApiDocument) => buildDescriptor(doc)['widgets']!

describe('emit — server-only and nullable attributes', () => {
  it('writes both into the generated descriptor', () => {
    const doc: OpenApiDocument = {
      openapi: '3.1.0',
      paths: {
        '/widgets': {
          get: collectionGet('WidgetsCollection'),
          post: { requestBody: actionBody('WidgetsCreateRequest'), responses: { '201': {} } },
        },
      },
      components: {
        schemas: {
          WidgetsResource: resourceOf('widgets'),
          WidgetsCollection: { type: 'object' },
          WidgetsAttributes: {
            type: 'object',
            properties: { title: { type: 'string' }, slug: { type: ['string', 'null'] } },
          },
          WidgetsCreateAttributes: { type: 'object', properties: { title: { type: 'string' } } },
        },
      },
    }
    const code = emit(doc, buildDescriptor(doc))
    expect(code).toMatch(/serverOnly"?:\s*\[\s*['"]slug/)
    expect(code).toMatch(/nullable"?:\s*\[\s*['"]slug/)
  })
})

describe('buildDescriptor — server-only and nullable attributes', () => {
  const post = { requestBody: actionBody('WidgetsCreateRequest'), responses: { '201': {} } }
  const docWith = (
    read: Record<string, SchemaObject>,
    create: Record<string, SchemaObject> | undefined,
    withPost = true,
  ): OpenApiDocument => ({
    openapi: '3.1.0',
    paths: {
      '/widgets': {
        get: collectionGet('WidgetsCollection'),
        ...(withPost ? { post } : {}),
      },
    },
    components: {
      schemas: {
        WidgetsResource: resourceOf('widgets'),
        WidgetsCollection: { type: 'object' },
        WidgetsAttributes: { type: 'object', properties: read },
        ...(create === undefined
          ? {}
          : { WidgetsCreateAttributes: { type: 'object', properties: create } }),
      },
    },
  })

  it('lists a read attribute the create attributes lack as server-only', () => {
    const widgets = built(docWith({ title: text, slug: text, code: text }, { title: text }))
    expect(widgets.serverOnly).toEqual(['code', 'slug'])
    expect(widgets.nullable).toBeUndefined()
  })

  it('lists a nullable attribute, whichever way the schema admits null', () => {
    const widgets = built(
      docWith(
        {
          a: { type: ['string', 'null'] },
          b: { anyOf: [text, { type: 'null' }] },
          c: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          d: text,
        },
        { a: text, b: text, c: text, d: text },
      ),
    )
    expect(widgets.nullable).toEqual(['a', 'b', 'c'])
    expect(widgets.serverOnly).toBeUndefined()
  })

  it('lists a nullable polymorphic attribute behind an anyOf of refs', () => {
    const widgets = built(
      docWith(
        {
          shape: {
            anyOf: [
              { $ref: '#/components/schemas/Circle' },
              { $ref: '#/components/schemas/Square' },
              { type: 'null' },
            ],
          },
        },
        { shape: { type: 'object' } },
      ),
    )
    expect(widgets.nullable).toEqual(['shape'])
  })

  it('records both, sorted', () => {
    const widgets = built(
      docWith(
        { title: text, slug: text, deletedAt: { type: ['string', 'null'], format: 'date-time' } },
        { title: text },
      ),
    )
    expect(widgets.serverOnly).toEqual(['deletedAt', 'slug'])
    expect(widgets.nullable).toEqual(['deletedAt'])
  })

  it('omits both when every attribute is creatable and none is nullable', () => {
    const widgets = built(docWith({ title: text }, { title: text }))
    expect(widgets).not.toHaveProperty('serverOnly')
    expect(widgets).not.toHaveProperty('nullable')
  })

  it('has no serverOnly for a type with no create, but still records nullable', () => {
    const widgets = built(
      docWith({ title: text, note: { type: ['string', 'null'] } }, undefined, false),
    )
    expect(widgets).not.toHaveProperty('serverOnly')
    expect(widgets.nullable).toEqual(['note'])
  })

  it('treats every read attribute as server-only when the create documents no attributes', () => {
    expect(built(docWith({ title: text }, undefined)).serverOnly).toEqual(['title'])
  })
})
