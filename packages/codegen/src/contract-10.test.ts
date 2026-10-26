import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient } from '../test/generated/contract-witness.client.gen'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'

function loadWitness(): OpenApiDocument {
  const path = fileURLToPath(
    new URL('../test/fixtures/contract-witness.openapi.json', import.meta.url),
  )
  return JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument
}

const witness = loadWitness()

// The witness has no action listing several request media types, so this copy gives its
// `import` action four, the way an adapter projects a raw input that takes several.
function withMultiTypeImport(): OpenApiDocument {
  const doc = loadWitness()
  const op = doc.paths!['/articles/-actions/import']!.post!
  op.requestBody = {
    content: {
      'text/csv': { schema: { type: 'string' } },
      'image/*': { schema: { type: 'string', format: 'binary' } },
      'multipart/form-data': { schema: { type: 'object' } },
      'application/json': { schema: { $ref: '#/components/schemas/ArticleSummary' } },
    },
  }
  return doc
}

describe('generator contract 10 (raw action responses)', () => {
  it('reads the witness without a warning', () => {
    // Core's witness carries every scoped structure, so it is stamped with the highest contract.
    expect(witness.info?.['x-generator']?.contract).toBe(11)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('records each raw response media type and how its body is read, in document order', () => {
    const actions = buildDescriptor(witness)['articles']!.actions!
    expect(actions['report']!.rawOutput).toEqual([
      { mediaType: 'text/csv', kind: 'text' },
      { mediaType: 'application/pdf', kind: 'binary' },
      { mediaType: 'application/json', kind: 'json' },
    ])
    expect(actions['report']!.output).toBe('meta')
    expect(actions['cover']!.rawOutput).toEqual([{ mediaType: 'image/png', kind: 'binary' }])
    expect(actions['cover']!.output).toBe('none')
    expect(actions['publish']!.rawOutput).toBeUndefined()
    expect(actions['import']!.inputMedia).toBeUndefined()
  })

  it('types a JSON-like raw response by its component, emitted once under its own name', () => {
    const source = emit(witness, buildDescriptor(witness))
    expect(source).toContain(
      'export type ArticleSummary = { total: number; byStatus?: Record<string, unknown> }',
    )
    expect(source).toContain(
      "report: { responses: { 'application/json': ArticleSummary } }".replace(/'/g, '"'),
    )
  })

  it("carries an author's summary and description into the action's JSDoc", () => {
    const source = emit(witness, buildDescriptor(witness))
    expect(source).toContain('      /** Publish the article */\n      publish: {')
    expect(source).toContain('      /** Save a draft revision. */\n      draft: {')
    // The projector's stand-in prose for an undescribed action adds nothing, so it is left out.
    expect(source).not.toContain('Invoke the `report` action')
    expect(source).not.toContain('Invokes the `publish` custom action')
  })

  it('types the generated methods per media type', () => {
    const client = createClient({ baseUrl: 'https://api.example' })
    // oxlint-disable-next-line no-constant-condition -- type-level probes only, never run
    if (false as boolean) {
      expectTypeOf(client.articles.actions.report()).resolves.toEqualTypeOf<
        Record<string, unknown>
      >()
      expectTypeOf(client.articles.id('art-1').actions.cover()).resolves.toEqualTypeOf<Blob>()
      expectTypeOf(client.articles.actions.report({ accept: 'text/csv' })).resolves.toBeString()
      expectTypeOf(
        client.articles.actions.report({ accept: 'application/pdf', responseType: 'arrayBuffer' }),
      ).resolves.toEqualTypeOf<ArrayBuffer>()
      expectTypeOf(client.articles.actions.report({ accept: 'application/json' }))
        .resolves.toHaveProperty('total')
        .toEqualTypeOf<number>()
      // @ts-expect-error -- the action does not answer in HTML.
      void client.articles.actions.report({ accept: 'text/html' })
    }
  })
})

describe('several request media types', () => {
  it('records each request media type and how the client sends it', () => {
    const action = buildDescriptor(withMultiTypeImport())['articles']!.actions!['import']!
    expect(action.input).toBe('raw')
    expect(action.contentType).toBe('text/csv')
    expect(action.inputMedia).toEqual([
      { mediaType: 'text/csv', kind: 'text' },
      { mediaType: 'image/*', kind: 'binary' },
      { mediaType: 'multipart/form-data', kind: 'multipart' },
      { mediaType: 'application/json', kind: 'json' },
    ])
  })

  it('types a JSON-like request body by its component', () => {
    const doc = withMultiTypeImport()
    const source = emit(doc, buildDescriptor(doc))
    expect(source).toContain(
      "import: { requests: { 'application/json': ArticleSummary } }".replace(/'/g, '"'),
    )
  })

  it('reads a JSON:API document listed beside other media types as the document input', () => {
    const doc = loadWitness()
    const draft = doc.paths!['/articles/{id}/-actions/draft']!.post!
    draft.requestBody!.content!['text/plain'] = { schema: { type: 'string' } }
    const action = buildDescriptor(doc)['articles']!.actions!['draft']!
    expect(action.input).toBe('document')
    expect(action.inputType).toBe('articles')
    expect(action.inputMedia).toEqual([
      { mediaType: 'application/vnd.api+json', kind: 'document' },
      { mediaType: 'text/plain', kind: 'text' },
    ])
  })
})

describe('generator contract 11 (accepted request bodies)', () => {
  it("records each body core's witness accepts, in document order", () => {
    const action = buildDescriptor(witness)['articles']!.actions!['bulk-import']!
    expect(action.input).toBe('raw')
    expect(action.contentType).toBe('text/csv')
    expect(action.inputMedia).toEqual([
      { mediaType: 'text/csv', kind: 'text' },
      { mediaType: 'image/*', kind: 'binary' },
      { mediaType: 'multipart/form-data', kind: 'multipart' },
      { mediaType: 'application/json', kind: 'json' },
    ])
  })

  it('types the generated method per request media type', () => {
    const client = createClient({ baseUrl: 'https://api.example' })
    // oxlint-disable-next-line no-constant-condition -- type-level probes only, never run
    if (false as boolean) {
      void client.articles.actions['bulk-import']('id,title\n')
      void client.articles.actions['bulk-import'](new Blob([]), { contentType: 'image/png' })
      void client.articles.actions['bulk-import'](new FormData(), {
        contentType: 'multipart/form-data',
      })
      void client.articles.actions['bulk-import']([{ title: 'Hello' }], {
        contentType: 'application/json',
      })
      // @ts-expect-error -- a JSON body follows the ArticleImportRow schema.
      void client.articles.actions['bulk-import']([{ name: 'Hello' }], {
        contentType: 'application/json',
      })
      // @ts-expect-error -- the action takes no PDF.
      void client.articles.actions['bulk-import'](new Blob([]), { contentType: 'application/pdf' })
    }
  })
})
