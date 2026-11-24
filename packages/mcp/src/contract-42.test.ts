import type { ApiDescriptor } from '@haddowg/json-api-client'
import { buildDescriptor } from '@haddowg/json-api-codegen'
import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import { HTTP_METHODS, type JsonSchema, type OpenApiDocument } from './openapi'
import { fakeTransport, modelOf, source } from './test-fixtures'

const { document: selecting } = source('contract-witness')

/** The witness with each `fields[articles]` parameter taking only its member names. */
function plainFields(): OpenApiDocument {
  const doc = structuredClone(selecting)
  for (const item of Object.values(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      for (const param of item[method]?.parameters ?? []) {
        if ('name' in param && param.name === 'fields[articles]') {
          const items = param.schema!['items'] as JsonSchema
          param.schema = { type: 'array', items: (items['anyOf'] as JsonSchema[])[0]! }
        }
      }
    }
  }
  return doc
}

const document = plainFields()

const toolsOf = (doc: OpenApiDocument) => createJsonApiMcp(modelOf(doc)).tools
const tool = (doc: OpenApiDocument, name: string) =>
  toolsOf(doc).find((entry) => entry.name === name)!

/** The schema of one type's entry in a tool's `fields` argument. */
function fieldsEntry(doc: OpenApiDocument, name: string, type: string): JsonSchema {
  const fields = (tool(doc, name).inputSchema['properties'] as Record<string, JsonSchema>)[
    'fields'
  ]!
  return (fields['properties'] as Record<string, JsonSchema>)[type]!
}

/** A write tool's argument for one attribute. */
function writeArgument(doc: OpenApiDocument, name: string, attribute: string): JsonSchema {
  return (tool(doc, name).inputSchema['properties'] as Record<string, JsonSchema>)[attribute]!
}

/** The values a converted shape allows its `kind` member, if it has one. */
function kindOf(shape: JsonSchema): unknown {
  const properties = shape['properties'] as Record<string, JsonSchema> | undefined
  return properties?.['kind']?.['enum']
}

const isObjectSchema = (schema: JsonSchema): boolean =>
  schema['type'] === 'object' ||
  (Array.isArray(schema['type']) && (schema['type'] as string[]).includes('object'))

/** An attribute's schema in the flattened `articles` resource a tool's output defines. */
function outputAttribute(doc: OpenApiDocument, name: string, attribute: string): JsonSchema {
  const defs = tool(doc, name).outputSchema!['$defs'] as Record<string, JsonSchema>
  return (defs['articles']!['properties'] as Record<string, JsonSchema>)[attribute]!
}

const DESCRIPTION =
  'Besides whole fields, list `<attribute>.<key>` to return that attribute with only the named keys, for `scores`, whose keys match `(?:[a-z][a-z0-9_]*)`; `totals`; `location`, whose keys match `(?:[a-z]+)`; and `hero`, whose keys match `(?:src|alt)`. A resource without a named key leaves it out. List the attribute itself to return all of it. A list returns every item, in order, with only the named keys when you list `<attribute>.*.<key>`, for `lines.*.<key>`, whose keys match `(?:sku|quantity|price)`; and `sections.*.<key>`, whose keys match `(?:text|level)` or `(?:src|size)`. An item without a named key leaves it out. List the attribute itself to return all of it. A key holding an object takes its own keys the same way, one more `.<key>` per level, for `location.geo.<key>`, whose keys match `(?:lat|lng)`; `lines.*.price.<key>`, whose keys match `(?:amount|currency)`; and `sections.*.size.<key>`, whose keys match `(?:width|height)`; listing the key itself returns all of it. Some values take one of several shapes: each item of `sections`, whose `kind` is `heading`, `figure` or `rule`; and `hero`, whose `kind` is `image` or `video`. Such a value returns only the named keys its own shape takes, beside the member naming its shape.'

/**
 * A `fields[<type>]` parameter accepting single keys of an attribute has items that are an `anyOf`
 * of the member enum and one pattern per such attribute. The list and get tools describe the key
 * members on that type's `fields` entry, and their output lets a narrowed attribute miss keys.
 */
describe('generator contract 42 (nested fieldsets)', () => {
  it('reads the witness', () => {
    expect(createJsonApiMcp(modelOf(selecting)).contract).toBe(46)
  })

  it('describes the nested fieldset members on each list and get tool that takes the type in fields', () => {
    for (const name of ['articles_list', 'articles_get', 'tags_articles_list']) {
      expect(fieldsEntry(selecting, name, 'articles')).toEqual({
        type: ['array', 'null'],
        items: { type: 'string' },
        description: DESCRIPTION,
      })
    }
    expect(fieldsEntry(selecting, 'articles_list', 'people')['description']).toBeUndefined()
    expect(fieldsEntry(document, 'articles_get', 'articles')['description']).toBeUndefined()
  })

  it('lets a narrowed attribute in the output miss any of its keys', () => {
    const totals = outputAttribute(selecting, 'articles_get', 'totals')
    expect(totals['required']).toBeUndefined()
    expect(totals['properties']).toMatchObject({ views: {}, shares: {} })
    expect(totals['additionalProperties']).toBe(false)
    expect(outputAttribute(selecting, 'articles_get', 'address')).toEqual(
      outputAttribute(document, 'articles_get', 'address'),
    )
  })

  it('lets a nested object a path narrows miss any of its keys', () => {
    const location = outputAttribute(selecting, 'articles_get', 'location')
    expect(location['required']).toBeUndefined()
    const geo = (location['properties'] as Record<string, JsonSchema>)['geo']!
    expect(geo['required']).toBeUndefined()
    expect(geo['properties']).toMatchObject({ lat: {}, lng: {} })
    expect(geo['additionalProperties']).toBe(false)
  })

  it('lets every item of a list a path narrows, and each object inside it, miss any of its keys', () => {
    const lines = outputAttribute(selecting, 'articles_get', 'lines')
    const item = lines['items'] as JsonSchema
    expect(item['required']).toBeUndefined()
    expect(item['properties']).toMatchObject({ sku: {}, quantity: {}, price: {} })
    expect(item['additionalProperties']).toBe(false)
    const price = (item['properties'] as Record<string, JsonSchema>)['price']!
    expect(price['required']).toBeUndefined()
    expect(price['properties']).toMatchObject({ amount: {}, currency: {} })
  })

  it('lets a union, as a list item or an attribute, miss any key but the one naming its variant', () => {
    const sections = outputAttribute(selecting, 'articles_get', 'sections')
    const item = sections['items'] as JsonSchema
    expect(item['anyOf']).toBeUndefined()
    expect(item['discriminator']).toEqual({ propertyName: 'kind' })
    const variants = item['oneOf'] as JsonSchema[]
    expect(variants.map((variant) => variant['required'])).toEqual([['kind'], ['kind'], ['kind']])
    for (const variant of variants) {
      expect((variant['properties'] as Record<string, JsonSchema>)['kind']!['const']).toBeDefined()
      expect(variant['additionalProperties']).toBe(false)
    }
    const size = (variants[1]!['properties'] as Record<string, JsonSchema>)['size']!
    expect(size['required']).toBeUndefined()
    expect(size['properties']).toMatchObject({ width: {}, height: {} })
  })

  it('lets a union attribute miss any key but the one naming its variant', () => {
    const hero = outputAttribute(selecting, 'articles_get', 'hero')
    expect(hero['anyOf']).toBeUndefined()
    expect(hero['discriminator']).toEqual({ propertyName: 'kind' })
    expect((hero['oneOf'] as JsonSchema[]).map((variant) => variant['required'])).toEqual([
      ['kind'],
      ['kind'],
      undefined,
    ])
  })

  it('describes a union attribute in the output by its shapes and the member naming them', () => {
    const hero = outputAttribute(selecting, 'articles_get', 'hero')
    expect(hero['description']).toBe(
      'One of these shapes, told apart by its `kind` member: `image` or `video`.',
    )
    const item = outputAttribute(selecting, 'articles_get', 'sections')['items'] as JsonSchema
    expect(item['description']).toBe(
      'One of these shapes, told apart by its `kind` member: `heading`, `figure` or `rule`.',
    )
  })

  it.each(['articles_create', 'articles_update'])(
    'gives %s a union attribute as closed shapes, each sending the value of its discriminator',
    (name) => {
      const hero = writeArgument(selecting, name, 'hero')
      expect(hero['description']).toBe(
        'One of these shapes, told apart by its `kind` member: `image` or `video`.',
      )
      const shapes = hero['anyOf'] as JsonSchema[]
      expect(shapes.map((shape) => shape['description'])).toEqual([
        'The `image` shape.',
        'The `video` shape.',
        undefined,
      ])
      expect(shapes.map((shape) => kindOf(shape))).toEqual([['image'], ['video'], undefined])
      expect(JSON.stringify(hero)).not.toMatch(/"(oneOf|discriminator|const)"/)
    },
  )

  it('keeps the value each list item shape fixes its discriminator to, beside the enum it is bound to', () => {
    const items = writeArgument(selecting, 'articles_create', 'sections')['items'] as JsonSchema
    expect(items['description']).toBe(
      'One of these shapes, told apart by its `kind` member: `heading`, `figure` or `rule`.',
    )
    const shapes = items['anyOf'] as JsonSchema[]
    expect(shapes.map((shape) => kindOf(shape))).toEqual([['heading'], ['figure'], ['rule']])
    expect(shapes.map((shape) => shape['description'])).toEqual([
      'The `heading` shape.',
      'The `figure` shape.',
      'The `rule` shape.',
    ])
  })

  it('sends a union attribute and the items of a union list without the nulls the conversion added', async () => {
    const { transport, requests } = fakeTransport(() => ({
      status: 201,
      json: { data: { type: 'articles', id: 'a-1', attributes: { title: 'Hi' } } },
    }))
    const session = await createJsonApiMcp({ ...modelOf(selecting), transport }).forRequest({
      context: {},
    })
    await session.callTool('articles_create', {
      title: 'Hello',
      hero: { kind: 'video', url: null },
      sections: [
        { kind: 'heading', text: 'Intro', level: null },
        { kind: 'figure', src: 'a.png', size: null },
        { kind: 'rule' },
      ],
    })
    const body = JSON.parse(requests[0]!.body!) as { data: { attributes: Record<string, unknown> } }
    expect(body.data.attributes['hero']).toEqual({ kind: 'video' })
    expect(body.data.attributes['sections']).toEqual([
      { kind: 'heading', text: 'Intro' },
      { kind: 'figure', src: 'a.png' },
      { kind: 'rule' },
    ])
  })

  it('describes a union a nested fieldset reaches inside an object, with its key patterns together', () => {
    const doc = structuredClone(selecting)
    const heroOf = (component: string) =>
      (
        (doc.components!.schemas![component] as JsonSchema)['properties'] as Record<
          string,
          JsonSchema
        >
      )['hero']!
    for (const component of [
      'ArticlesAttributes',
      'ArticlesCreateAttributes',
      'ArticlesUpdateAttributes',
    ]) {
      const location = (
        (doc.components!.schemas![component] as JsonSchema)['properties'] as Record<
          string,
          JsonSchema
        >
      )['location']!
      const media = structuredClone(heroOf(component))
      media['oneOf'] = (media['oneOf'] as JsonSchema[]).filter(
        (branch) => branch['type'] !== 'null',
      )
      ;(location['properties'] as Record<string, JsonSchema>)['media'] = media
    }
    const descriptor = buildDescriptor(doc as Parameters<typeof buildDescriptor>[0])
    const nested: ApiDescriptor = {
      ...descriptor,
      articles: {
        ...descriptor['articles']!,
        nestedFieldsets: { location: '(?:[a-z]+)' },
        nestedFieldsetPaths: {
          location: [
            ['media', '(?:src|alt)'],
            ['media', '(?:url)'],
          ],
        },
      },
    }
    const tools = createJsonApiMcp(modelOf(doc, nested)).tools
    const fields = (
      tools.find((entry) => entry.name === 'articles_get')!.inputSchema['properties'] as Record<
        string,
        JsonSchema
      >
    )['fields']!
    expect((fields['properties'] as Record<string, JsonSchema>)['articles']!['description']).toBe(
      'Besides whole fields, list `<attribute>.<key>` to return that attribute with only the named keys, for `location`, whose keys match `(?:[a-z]+)`. A resource without a named key leaves it out. List the attribute itself to return all of it. A key holding an object takes its own keys the same way, one more `.<key>` per level, for `location.media.<key>`, whose keys match `(?:src|alt)` or `(?:url)`; listing the key itself returns all of it. One value takes one of several shapes: `location.media`, whose `kind` is `image` or `video`. Such a value returns only the named keys its own shape takes, beside the member naming its shape.',
    )
    const create = tools.find((entry) => entry.name === 'articles_create')!.inputSchema
    const location = (create['properties'] as Record<string, JsonSchema>)['location']!
    const branches = (location['anyOf'] as JsonSchema[] | undefined) ?? [location]
    const object = branches.find((branch) => isObjectSchema(branch))!
    const media = (object['properties'] as Record<string, JsonSchema>)['media']!
    expect(media['description']).toBe(
      'One of these shapes, told apart by its `kind` member: `image` or `video`.',
    )
    const output = (
      (
        tools.find((entry) => entry.name === 'articles_get')!.outputSchema!['$defs'] as Record<
          string,
          JsonSchema
        >
      )['articles']!['properties'] as Record<string, JsonSchema>
    )['location']!
    expect(
      ((output['properties'] as Record<string, JsonSchema>)['media'] as JsonSchema)['description'],
    ).toBe('One of these shapes, told apart by its `kind` member: `image` or `video`.')
  })

  it('describes a union with no discriminator as one of several shapes', () => {
    const doc = structuredClone(selecting)
    for (const component of [
      'ArticlesAttributes',
      'ArticlesCreateAttributes',
      'ArticlesUpdateAttributes',
    ]) {
      const hero = (
        (doc.components!.schemas![component] as JsonSchema)['properties'] as Record<
          string,
          JsonSchema
        >
      )['hero']!
      delete hero['discriminator']
      for (const branch of hero['oneOf'] as JsonSchema[]) {
        delete (branch['properties'] as Record<string, JsonSchema> | undefined)?.['kind']
      }
    }
    const tools = createJsonApiMcp(modelOf(doc)).tools
    const hero = writeArgument(doc, 'articles_create', 'hero')
    expect(hero['description']).toBe('One of these shapes. Send the members of exactly one.')
    expect(outputAttribute(doc, 'articles_get', 'hero')['description']).toBe('One of these shapes.')
    const fields = (
      tools.find((entry) => entry.name === 'articles_get')!.inputSchema['properties'] as Record<
        string,
        JsonSchema
      >
    )['fields']!
    expect(
      (fields['properties'] as Record<string, JsonSchema>)['articles']!['description'],
    ).toContain(
      'each item of `sections`, whose `kind` is `heading`, `figure` or `rule`; and `hero`. Such a value',
    )
  })

  it('reads a narrowed union with no discriminator as any of its variants', () => {
    const doc = structuredClone(selecting)
    for (const component of [
      'ArticlesAttributes',
      'ArticlesCreateAttributes',
      'ArticlesUpdateAttributes',
    ]) {
      const sections = (
        (doc.components!.schemas![component] as JsonSchema)['properties'] as Record<
          string,
          JsonSchema
        >
      )['sections']!
      delete (sections['items'] as JsonSchema)['discriminator']
    }
    const item = outputAttribute(doc, 'articles_get', 'sections')['items'] as JsonSchema
    expect(item['oneOf']).toBeUndefined()
    expect((item['anyOf'] as JsonSchema[]).map((variant) => variant['required'])).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })

  it('describes a list inside an object and a list alone', () => {
    const descriptor = buildDescriptor(selecting as Parameters<typeof buildDescriptor>[0])
    const listed: ApiDescriptor = {
      ...descriptor,
      articles: {
        ...descriptor['articles']!,
        nestedFieldsets: { lines: '\\*', location: '(?:[a-z]+)' },
        nestedFieldsetPaths: {
          lines: [['\\*', '(?:sku|quantity|price)']],
          location: [
            ['visits', '\\*'],
            ['visits', '\\*', '(?:at|by)'],
          ],
        },
      },
    }
    const tools = createJsonApiMcp(modelOf(selecting, listed)).tools
    const fields = (
      tools.find((entry) => entry.name === 'articles_get')!.inputSchema['properties'] as Record<
        string,
        JsonSchema
      >
    )['fields']!
    const text = (fields['properties'] as Record<string, JsonSchema>)['articles']!['description']
    expect(text).toContain('a key holding a list takes `.*` before the keys of its items')
    expect(text).toContain('for `location.visits.*.<key>`, whose keys match `(?:at|by)`;')
    expect(text).not.toContain('`location.visits.<key>`')

    const alone: ApiDescriptor = {
      ...descriptor,
      articles: {
        ...descriptor['articles']!,
        nestedFieldsets: { lines: '\\*' },
        nestedFieldsetPaths: { lines: [['\\*', '[^.,*]+']] },
      },
    }
    const only = (
      (
        createJsonApiMcp(modelOf(selecting, alone)).tools.find(
          (entry) => entry.name === 'articles_get',
        )!.inputSchema['properties'] as Record<string, JsonSchema>
      )['fields']!['properties'] as Record<string, JsonSchema>
    )['articles']!['description']
    expect(only).toBe(
      'Besides whole fields, a list returns every item, in order, with only the named keys when you list `<attribute>.*.<key>`, for `lines.*.<key>`. An item without a named key leaves it out. List the attribute itself to return all of it.',
    )
  })

  it('names a key a path passes through by a pattern as any key', () => {
    const descriptor = buildDescriptor(selecting as Parameters<typeof buildDescriptor>[0])
    const scored: ApiDescriptor = {
      ...descriptor,
      articles: {
        ...descriptor['articles']!,
        nestedFieldsetPaths: { scores: [['(?:[a-z][a-z0-9_]*)', '[^.,]+']] },
      },
    }
    const tools = createJsonApiMcp(modelOf(selecting, scored)).tools
    const fields = (
      tools.find((entry) => entry.name === 'articles_get')!.inputSchema['properties'] as Record<
        string,
        JsonSchema
      >
    )['fields']!
    const articles = (fields['properties'] as Record<string, JsonSchema>)['articles']!
    expect(articles['description']).toContain('for `scores.<key>.<key>`; listing the key itself')
  })

  it('sends the nested fieldset members and returns the narrowed attribute', async () => {
    const { transport, requests } = fakeTransport(() => ({
      json: {
        data: { type: 'articles', id: 'a-1', attributes: { title: 'Hi', totals: { views: 3 } } },
      },
    }))
    const mcp = createJsonApiMcp({ ...modelOf(selecting), transport })
    const tools = await mcp.forRequest({ context: undefined })
    const result = await tools.callTool('articles_get', {
      id: 'a-1',
      fields: { articles: ['title', 'totals.views'] },
    })
    expect(decodeURIComponent(requests[0]!.url)).toContain('fields[articles]=title,totals.views')
    expect(result.structuredContent).toMatchObject({
      data: { id: 'a-1', type: 'articles', title: 'Hi', totals: { views: 3 } },
    })
  })

  it('leaves the input of every tool that reads no articles as it was', () => {
    const before = toolsOf(document).map((entry) => [entry.name, entry.inputSchema])
    const after = toolsOf(selecting)
      .filter(
        (entry) => !entry.name.startsWith('articles') && !entry.name.endsWith('articles_list'),
      )
      .map((entry) => [entry.name, entry.inputSchema])
    for (const [name, input] of after) {
      expect(before.find(([other]) => other === name)?.[1]).toEqual(input)
    }
  })
})
