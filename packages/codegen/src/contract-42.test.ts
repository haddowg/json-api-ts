import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract, MAXIMUM_CONTRACT } from './contract'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'
import { withFieldSelection } from '../test/field-selection'

const load = (
  name: 'contract-witness.json' | 'contract-witness-baseline.json' | 'music-catalog.openapi.json',
) => JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument
const witness = load('contract-witness.json')
const selecting = withFieldSelection(witness)

const scratch = mkdtempSync(join(tmpdir(), 'json-api-field-selection-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Type-check a generated module against the client's source, returning the error messages. */
function typecheck(code: string): string[] {
  const file = join(scratch, 'client.gen.ts')
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

/**
 * A `fields[<type>]` parameter accepting single keys of an attribute has items that are an `anyOf`
 * of the member enum and one pattern per such attribute, `^<attribute>\.<key>$`. The codegen
 * records each attribute with its key pattern, and the client types `<attribute>.${string}`.
 */
describe('generator contract 42 (field selection)', () => {
  it('reads a document stamped 42 without a warning, and warns past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(42)
    expect(selecting.info?.['x-generator']?.contract).toBe(42)
    expect(checkContract(selecting)).toBeUndefined()
    const newer = { ...selecting, info: { ...selecting.info!, 'x-generator': { contract: 43 } } }
    expect(checkContract(newer as OpenApiDocument)).toContain('reads up to 42')
  })

  it('records each attribute that takes single keys, with the pattern its key matches', () => {
    const articles = buildDescriptor(selecting)['articles']!
    expect(articles.selectableKeys).toEqual({
      scores: '(?:[a-z][a-z0-9_]*)',
      totals: '[^,]+',
    })
    expect(articles.attributes).toMatchObject({ scores: 'object', totals: 'object' })
  })

  it('records none where every fields parameter lists only members', () => {
    for (const doc of [
      witness,
      load('contract-witness-baseline.json'),
      load('music-catalog.openapi.json'),
    ]) {
      for (const descriptor of Object.values(buildDescriptor(doc))) {
        expect(descriptor.selectableKeys).toBeUndefined()
      }
    }
  })

  it('leaves every other type as it was, and the articles but for the new attributes', () => {
    const before = buildDescriptor(witness)
    const after = buildDescriptor(selecting)
    for (const [type, descriptor] of Object.entries(before)) {
      if (type !== 'articles') {
        expect(after[type]).toEqual(descriptor)
      }
    }
    const { selectableKeys, attributes, ...articles } = after['articles']!
    const { attributes: beforeAttributes, ...beforeArticles } = before['articles']!
    expect(articles).toEqual(beforeArticles)
    expect(attributes).toEqual({ ...beforeAttributes, scores: 'object', totals: 'object' })
    expect(selectableKeys).toBeDefined()
  })

  it('reads a pattern only by the attribute it names', () => {
    const doc = structuredClone(selecting)
    const items = doc.paths!['/articles/{id}']!.get!.parameters!.find(
      (param) => param.name === 'fields[articles]',
    )!.schema!.items!
    const [members] = items.anyOf!
    // A pattern naming no member, or not anchored at its end, is not read.
    ;(items as { anyOf: unknown[] }).anyOf = [
      members,
      { type: 'string', pattern: '^missing\\.[^,]+$' },
      { type: 'string', pattern: '^scores\\.[a-z]+' },
    ]
    for (const item of Object.values(doc.paths!)) {
      for (const op of Object.values(item)) {
        for (const param of op?.parameters ?? []) {
          if (param.name === 'fields[articles]') param.schema = { type: 'array', items }
        }
      }
    }
    expect(buildDescriptor(doc)['articles']?.selectableKeys).toBeUndefined()
  })

  it('compiles to a client whose fields take key members and narrow the attribute', () => {
    const probes = [
      "const api = createClient({ baseUrl: 'https://api.example' })",
      'export async function probe(): Promise<void> {',
      "  const article = await api.articles.get('a-1', {",
      "    fields: { articles: ['title', 'scores.maths', 'totals.views'] },",
      '  })',
      '  const title: string = article.title',
      '  const maths: number | null | undefined = article.scores?.maths',
      '  const views: number | null | undefined = article.totals?.views',
      '  // @ts-expect-error -- shares was not selected.',
      '  void article.totals?.shares',
      '  // @ts-expect-error -- metrics was not selected.',
      '  void article.metrics',
      '  const selected: Readonly<Record<string, readonly string[]>> = article.$keySelection',
      '  const listed = await api.articles.list({',
      "    fields: { articles: ['scores', 'scores.maths'] },",
      '  })',
      '  const whole: Record<string, number | null> | null | undefined = listed[0]?.scores',
      '  // @ts-expect-error -- title takes no single keys.',
      "  await api.articles.list({ fields: { articles: ['title.first'] } })",
      '  void [title, maths, views, selected, whole]',
      '}',
    ]
    const source = emit(selecting, buildDescriptor(selecting))
    expect(source).toContain(
      '    selectableKeys: {\n      scores: "(?:[a-z][a-z0-9_]*)",\n      totals: "[^,]+"\n    },',
    )
    expect(typecheck(`${source}\n${probes.join('\n')}\n`)).toEqual([])
  })
})
