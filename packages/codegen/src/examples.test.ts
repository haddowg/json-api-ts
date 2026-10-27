import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { examples as catalogExamples } from '../test/generated/music-catalog.client.examples.gen'
import { buildDescriptor } from './build-descriptor'
import { buildExamples, operationExamples } from './build-examples'
import { checkContract } from './contract'
import { emit, EXAMPLE_DOC_MAX_LINES } from './emit'
import { emitExamples } from './emit-examples'
import type { OpenApiDocument, OperationObject } from './openapi'

function load(name: string): OpenApiDocument {
  const path = fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument
}

/** The document with every `example` removed, as a server before contract 12 projects it. */
function withoutExamples<T>(node: T): T {
  if (Array.isArray(node)) {
    return node.map(withoutExamples) as T
  }
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => key !== 'example')
        .map(([key, value]) => [key, withoutExamples(value)]),
    ) as T
  }
  return node
}

const JSON_API = 'application/vnd.api+json'

/** The JSDoc written above an action's entry in the generated `resourceMap`. */
function actionDocOf(source: string, name: string): string | undefined {
  const match = new RegExp(`(\\/\\*\\*(?:(?!\\*\\/)[\\s\\S])*\\*\\/)\\n\\s*"?${name}"?: \\{`).exec(
    source,
  )
  return match?.[1]
}

describe('generator contract 12 (operation examples)', () => {
  const witness = load('contract-witness.openapi.json')
  const examples = buildExamples(witness, buildDescriptor(witness))

  it('reads the witness, now at contract 17, without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(17)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('carries the request and each success response of an operation', () => {
    const create = examples['videos']?.operations?.['create']
    expect(create?.request?.[JSON_API]).toEqual({
      data: {
        type: 'videos',
        attributes: { url: 'https://cdn.example.com/intro.mp4', seconds: 90 },
      },
    })
    expect(Object.keys(create?.responses ?? {})).toEqual(['201'])
    expect(create?.responses?.['201']?.[JSON_API]).toMatchObject({
      data: { type: 'videos', id: 'vid-1' },
    })
  })

  it('keys a relation operation by its name and the relation, without the type', () => {
    const operations = examples['articles']?.operations ?? {}
    expect(operations['updateRelationship.attachments']?.request).toBeDefined()
    expect(operations['fetchRelated.tags']?.responses?.['200']).toBeDefined()
    expect(Object.keys(operations).every((name) => !name.includes('articles'))).toBe(true)
  })

  it('carries an action by name, with each media type it has an example for', () => {
    expect(examples['articles']?.actions?.['stats']).toEqual({
      responses: { '200': { [JSON_API]: { meta: { published: 12 } } } },
    })
    expect(examples['articles']?.actions?.['report']?.responses?.['200']).toEqual({
      'text/csv': 'id,title\n1,Hello\n',
    })
  })

  it('leaves out an operation, a part and a type with no example', () => {
    expect(examples['articles']?.operations?.['fetchCollection']).toBeUndefined()
    expect(examples['tags']?.operations?.['create']?.responses).toBeUndefined()
    expect(examples['people']).toBeUndefined()
    expect(examples['articles']?.actions?.['bulk-import']).toBeUndefined()
  })

  it('leaves out error responses and operations that belong to no type', () => {
    for (const resource of Object.values(examples)) {
      for (const op of [
        ...Object.values(resource.operations ?? {}),
        ...Object.values(resource.actions ?? {}),
      ]) {
        expect(Object.keys(op.responses ?? {}).every((status) => status.startsWith('2'))).toBe(true)
      }
    }
    expect(Object.keys(examples)).toEqual(['articles', 'images', 'tags', 'videos'])
  })

  it('emits the examples the music catalog declares, typed as ApiExamples', () => {
    const fetchOne = catalogExamples['albums']?.operations?.['fetchOne']
    expect(fetchOne?.responses?.['200']?.[JSON_API]).toMatchObject({
      data: { type: 'albums', id: '1', attributes: { title: 'Abbey Road' } },
    })
    expect(catalogExamples['albums']?.actions?.['reissue']?.request).toBeDefined()
  })
})

describe('a document without examples', () => {
  const older = withoutExamples(load('contract-witness.openapi.json'))
  older.info = { ...older.info, 'x-generator': { contract: 11 } }

  it('gives no examples', () => {
    expect(buildExamples(older, buildDescriptor(older))).toEqual({})
    expect(operationExamples(older.paths?.['/videos']?.post)).toBeUndefined()
  })

  it('writes no @example on an action', () => {
    const source = emit(older, buildDescriptor(older))
    expect(source).not.toContain('@example Request body')
    expect(source).not.toContain('@example Response')
  })
})

describe('an action @example', () => {
  const witness = load('contract-witness.openapi.json')

  function emitWith(edit: (stats: OperationObject, doc: OpenApiDocument) => void): string {
    const doc = structuredClone(witness)
    edit(doc.paths!['/articles/-actions/stats']!.get!, doc)
    return emit(doc, buildDescriptor(doc))
  }

  it('shows the first success response as pretty-printed JSON', () => {
    const doc = actionDocOf(emit(witness, buildDescriptor(witness)), 'stats')
    expect(doc).toBe(
      [
        '/**',
        '       * @example Response `200`',
        '       * ```json',
        '       * {',
        '       *   "meta": {',
        '       *     "published": 12',
        '       *   }',
        '       * }',
        '       * ```',
        '       */',
      ].join('\n'),
    )
  })

  it('names a media type other than JSON:API and shows a text body as is', () => {
    const doc = actionDocOf(emit(witness, buildDescriptor(witness)), 'report')
    expect(doc).toContain('@example Response `200` as `text/csv`')
    expect(doc).toContain('       * ```\n       * id,title\n       * 1,Hello\n       * ```')
  })

  it('shows the request body when there is one, over the response', () => {
    const source = emitWith((stats) => {
      stats.requestBody = {
        content: { [JSON_API]: { example: { data: { type: 'articles', id: '1' } } } },
      }
    })
    const doc = actionDocOf(source, 'stats')
    expect(doc).toContain('@example Request body\n')
    expect(doc).not.toContain('published')
  })

  it('keeps a */ or a run of backticks inside the example from ending the comment or the fence', () => {
    const source = emitWith((stats) => {
      stats.responses!['200']!.content![JSON_API]!.example = {
        meta: { note: 'ends */ here', code: '```ts\nx\n```' },
      }
    })
    const doc = actionDocOf(source, 'stats')!
    expect(doc).toContain('"note": "ends * / here"')
    expect(doc).toContain('* ````json')
    expect(doc.indexOf('*/')).toBe(doc.length - 2)
  })

  it(`names but leaves out an example over ${EXAMPLE_DOC_MAX_LINES} lines`, () => {
    const rows = Array.from({ length: EXAMPLE_DOC_MAX_LINES }, (_, i) => i)
    const source = emitWith((stats) => {
      stats.responses!['200']!.content![JSON_API]!.example = { meta: { rows } }
    })
    const doc = actionDocOf(source, 'stats')!
    expect(doc).toContain('@example Response `200`')
    expect(doc).toContain(
      `The example is ${EXAMPLE_DOC_MAX_LINES + 6} lines long, too long to show here.`,
    )
    expect(doc).not.toContain('```')
  })
})

describe('emitExamples', () => {
  it('writes the map as a literal typed ApiExamples, with a __proto__ key kept as an own key', () => {
    const doc: OpenApiDocument = { openapi: '3.1.0', info: { title: 'T', version: '1' } }
    const source = emitExamples(doc, {
      things: {
        operations: { fetchOne: { responses: { '200': { [JSON_API]: { ['__proto__']: 1 } } } } },
      },
    })
    expect(source).toContain("import type { ApiExamples } from '@haddowg/json-api-client'")
    expect(source).toContain('export const examples: ApiExamples = {')
    expect(source).toContain('["__proto__"]: 1')
  })
})
