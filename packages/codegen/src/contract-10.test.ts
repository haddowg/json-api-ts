import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, expectTypeOf, it } from 'vitest'
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
    expect(witness.info?.['x-generator']?.contract).toBe(19)
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
    expect(source).toContain(
      '      /**\n       * Publish the article\n       *\n       * Needs the OAuth scope `articles:publish`.\n       */\n      publish: {',
    )
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

const scratch = mkdtempSync(join(tmpdir(), 'json-api-form-fields-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Type-check a generated module against the client's source, returning the error messages. */
function typecheck(code: string): string[] {
  const file = join(scratch, `client-${Math.random().toString(36).slice(2)}.gen.ts`)
  writeFileSync(file, code)
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    paths: {
      '@haddowg/json-api-client': [
        fileURLToPath(new URL('../../client/src/index.ts', import.meta.url)),
      ],
    },
  })
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

describe('typed form fields', () => {
  // The witness's multipart body lists no properties, so this copy gives it some, and a URL-encoded
  // sibling, the way an adapter projects a form whose fields it knows.
  function withFormFields(additional?: unknown): OpenApiDocument {
    const doc = loadWitness()
    const op = doc.paths!['/articles/-actions/bulk-import']!.post!
    const content = op.requestBody!.content!
    content['multipart/form-data'] = {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          cover: { type: 'string', format: 'binary' },
          tags: { type: 'array', items: { type: 'string' } },
          count: { type: 'integer' },
          status: { type: 'string', enum: ['draft', 'live'] },
        },
        required: ['title'],
        ...(additional === undefined ? {} : { additionalProperties: additional }),
      },
    }
    content['application/x-www-form-urlencoded'] = {
      schema: {
        type: 'object',
        properties: { title: { type: 'string' }, draft: { type: 'boolean' } },
        required: ['title'],
      },
    }
    return doc
  }

  function source(doc: OpenApiDocument): string {
    return emit(doc, buildDescriptor(doc))
  }

  it('types a multipart body from its properties, binary parts as files', () => {
    expect(source(withFormFields())).toContain(
      'export type ArticlesBulkImportMultipartFormDataInput = { title: string; cover?: Blob | File; tags?: string[]; count?: number; status?: "draft" | "live" }',
    )
  })

  it('types a URL-encoded body from its properties', () => {
    expect(source(withFormFields())).toContain(
      'export type ArticlesBulkImportApplicationXWwwFormUrlencodedInput = { title: string; draft?: boolean }',
    )
  })

  it('maps both onto the action', () => {
    expect(source(withFormFields())).toContain(
      '"bulk-import": { requests: { "multipart/form-data": ArticlesBulkImportMultipartFormDataInput; "application/json": ArticleImportRow; "application/x-www-form-urlencoded": ArticlesBulkImportApplicationXWwwFormUrlencodedInput } }',
    )
  })

  it('adds an index signature for additional fields', () => {
    expect(source(withFormFields(true))).toContain(
      '; [field: string]: string | Blob | File | string[] | number | "draft" | "live" | boolean | undefined }',
    )
    expect(source(withFormFields({ type: 'string' }))).toContain(
      '; [field: string]: string | Blob | File | string[] | number | "draft" | "live" | undefined }',
    )
    expect(source(withFormFields(false))).not.toContain('[field: string]')
  })

  it('compiles against the client, the fields checked and FormData still taken', () => {
    const probes = [
      "const api = createClient({ baseUrl: 'https://api.example' })",
      "const multipart = { contentType: 'multipart/form-data' } as const",
      "const form = { contentType: 'application/x-www-form-urlencoded' } as const",
      "void api.articles.actions['bulk-import']({ title: 'x', cover: new Blob([]), tags: ['a'] }, multipart)",
      "void api.articles.actions['bulk-import'](new FormData(), multipart)",
      "void api.articles.actions['bulk-import']({ title: 'x', draft: true }, form)",
      '// @ts-expect-error -- `title` is required.',
      "void api.articles.actions['bulk-import']({ cover: new Blob([]) }, multipart)",
      '// @ts-expect-error -- `count` is a number.',
      "void api.articles.actions['bulk-import']({ title: 'x', count: 'many' }, multipart)",
    ]
    expect(typecheck(`${source(withFormFields())}\n${probes.join('\n')}\n`)).toEqual([])
  })

  it('keeps a body with no properties a plain FormData', () => {
    expect(source(witness)).not.toContain('MultipartFormDataInput =')
  })

  it('types a multipart body that is the only one an action takes', () => {
    const doc = loadWitness()
    doc.paths!['/articles/-actions/import']!.post!.requestBody = {
      content: {
        'multipart/form-data': {
          schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
        },
      },
    }
    const out = source(doc)
    expect(out).toContain(
      'export type ArticlesImportMultipartFormDataInput = { file?: Blob | File }',
    )
    expect(out).toContain(
      'import: { requests: { "multipart/form-data": ArticlesImportMultipartFormDataInput } }',
    )
  })
})

describe('text and any-JSON request bodies', () => {
  // Core projects a schemaless text entry as a plain string and a schemaless JSON entry as `{}`.
  function withDefaultBodies(): OpenApiDocument {
    const doc = loadWitness()
    const content = doc.paths!['/articles/-actions/bulk-import']!.post!.requestBody!.content!
    content['text/csv'] = { schema: { type: 'string' } }
    content['application/json'] = { schema: {} }
    return doc
  }

  it('types an any-JSON body as unknown', () => {
    const doc = withDefaultBodies()
    expect(emit(doc, buildDescriptor(doc))).toContain(
      'export type ArticlesBulkImportApplicationJsonInput = unknown',
    )
  })

  it('takes a string or a Blob for a text body', () => {
    const doc = withDefaultBodies()
    const probes = [
      "const api = createClient({ baseUrl: 'https://api.example' })",
      "void api.articles.actions['bulk-import']('id,title\\n')",
      "void api.articles.actions['bulk-import'](new Blob(['id,title\\n']))",
      "void api.articles.actions['bulk-import']({ any: ['json'] }, { contentType: 'application/json' })",
      '// @ts-expect-error -- a text body is not a number.',
      "void api.articles.actions['bulk-import'](42)",
    ]
    expect(typecheck(`${emit(doc, buildDescriptor(doc))}\n${probes.join('\n')}\n`)).toEqual([])
  })
})
