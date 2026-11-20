import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
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
 * of the member enum and one pattern per such attribute, `^<attribute>\.<key>$`, then one per path
 * into a nested object, `^<attribute>\.<key>\.<key>$`. A list whose items take keys has the key
 * `\*`, `^<attribute>\.\*$`, and its item paths follow it. The codegen records each attribute with
 * its key pattern and its nested paths, and the client types `<attribute>.${string}`.
 */

/** The paths into the items of the articles' `lines`, each starting at the list's `\*`. */
const LINE_PATHS = [
  ['\\*', '(?:sku|quantity|price)'],
  ['\\*', 'price', '(?:amount|currency)'],
]

/**
 * The paths into the items of the articles' `sections`, a union whose `heading` and `figure`
 * variants each declare their own keys and whose `rule` declares none.
 */
const SECTION_PATHS = [
  ['\\*', '(?:text|level)'],
  ['\\*', '(?:src|size)'],
  ['\\*', 'size', '(?:width|height)'],
]

describe('generator contract 42 (field selection)', () => {
  it('reads a document stamped 42 without a warning', () => {
    expect(selecting.info?.['x-generator']?.contract).toBe(42)
    expect(checkContract(selecting)).toBeUndefined()
  })

  it('records each attribute that takes single keys, with the pattern its key matches', () => {
    const articles = buildDescriptor(selecting)['articles']!
    expect(articles.selectableKeys).toEqual({
      scores: '(?:[a-z][a-z0-9_]*)',
      totals: '[^.,*]+',
      location: '(?:[a-z]+)',
      lines: '\\*',
      sections: '\\*',
      hero: '(?:src|alt)',
    })
    expect(articles.selectableKeyPaths).toEqual({
      location: [['geo', '(?:lat|lng)']],
      lines: LINE_PATHS,
      sections: SECTION_PATHS,
    })
    expect(articles.attributes).toMatchObject({
      scores: 'object',
      totals: 'object',
      location: 'object',
      lines: 'array',
      sections: 'array',
      hero: 'unknown',
    })
  })

  it('splits a nested path only at a full stop outside a group or class', () => {
    const doc = structuredClone(selecting)
    const items = doc.paths!['/articles/{id}']!.get!.parameters!.find(
      (param) => param.name === 'fields[articles]',
    )!.schema!.items!
    ;(items as { anyOf: unknown[] }).anyOf.push(
      { type: 'string', pattern: '^scores\\.(?:[a-z][a-z0-9_]*)\\.(?:a\\.b|[.])$' },
      { type: 'string', pattern: '^location\\.geo\\.[^.,]+\\.[^.,]+$' },
      { type: 'string', pattern: '^location\\.lat\\.long$' },
    )
    for (const item of Object.values(doc.paths!)) {
      for (const op of Object.values(item)) {
        for (const param of op?.parameters ?? []) {
          if (param.name === 'fields[articles]') param.schema = { type: 'array', items }
        }
      }
    }
    const articles = buildDescriptor(doc)['articles']!
    // The attribute's own key pattern is the one with no full stop, whichever comes first.
    expect(articles.selectableKeys).toMatchObject({ location: '(?:[a-z]+)' })
    expect(articles.selectableKeyPaths).toEqual({
      scores: [['(?:[a-z][a-z0-9_]*)', '(?:a\\.b|[.])']],
      location: [
        ['geo', '(?:lat|lng)'],
        ['geo', '[^.,]+', '[^.,]+'],
        ['lat', 'long'],
      ],
      lines: LINE_PATHS,
      sections: SECTION_PATHS,
    })
  })

  it('records none where every fields parameter lists only members', () => {
    for (const doc of [
      witness,
      load('contract-witness-baseline.json'),
      load('music-catalog.openapi.json'),
    ]) {
      for (const descriptor of Object.values(buildDescriptor(doc))) {
        expect(descriptor.selectableKeys).toBeUndefined()
        expect(descriptor.selectableKeyPaths).toBeUndefined()
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
    const { selectableKeys, selectableKeyPaths, attributes, ...articles } = after['articles']!
    const { attributes: beforeAttributes, ...beforeArticles } = before['articles']!
    expect(articles).toEqual(beforeArticles)
    expect(attributes).toEqual({
      ...beforeAttributes,
      scores: 'object',
      totals: 'object',
      location: 'object',
      lines: 'array',
      sections: 'array',
      hero: 'unknown',
    })
    expect(selectableKeys).toBeDefined()
    expect(selectableKeyPaths).toBeDefined()
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
      "  const located = await api.articles.get('a-1', {",
      "    fields: { articles: ['location.postcode', 'location.geo.lat'] },",
      '  })',
      '  const lat: number | null | undefined = located.location?.geo?.lat',
      '  const postcode: string | null | undefined = located.location?.postcode',
      '  // @ts-expect-error -- lng was not selected.',
      '  void located.location?.geo?.lng',
      "  const geo = await api.articles.get('a-1', {",
      "    fields: { articles: ['location.geo', 'location.geo.lat'] },",
      '  })',
      '  const lng: number | null | undefined = geo.location?.geo?.lng',
      '  // @ts-expect-error -- postcode was not selected.',
      '  void geo.location?.postcode',
      "  const lined = await api.articles.get('a-1', {",
      "    fields: { articles: ['lines.*.sku', 'lines.*.price.amount'] },",
      '  })',
      '  const sku: string | null | undefined = lined.lines?.[0]?.sku',
      '  const amount: number | null | undefined = lined.lines?.[0]?.price?.amount',
      '  // @ts-expect-error -- quantity was not selected.',
      '  void lined.lines?.[0]?.quantity',
      '  // @ts-expect-error -- currency was not selected.',
      '  void lined.lines?.[0]?.price?.currency',
      "  const items = await api.articles.get('a-1', { fields: { articles: ['lines.*', 'lines.*.sku'] } })",
      '  const quantity: number | null | undefined = items.lines?.[0]?.quantity',
      "  const sectioned = await api.articles.get('a-1', {",
      "    fields: { articles: ['sections.*.text', 'sections.*.size.width'] },",
      '  })',
      '  const section = sectioned.sections?.[0]',
      '  // Every item keeps the member naming its variant, and only the keys its variant has.',
      "  const kind: 'heading' | 'figure' | 'rule' = sectioned.sections![0]!.kind",
      "  const text: string | null | undefined = section?.kind === 'heading' ? section.text : undefined",
      "  const width: number | null | undefined = section?.kind === 'figure' ? section.size?.width : undefined",
      '  // @ts-expect-error -- level was not selected.',
      "  void (section?.kind === 'heading' ? section.level : undefined)",
      '  // @ts-expect-error -- src was not selected.',
      "  void (section?.kind === 'figure' ? section.src : undefined)",
      '  // @ts-expect-error -- height was not selected.',
      "  void (section?.kind === 'figure' ? section.size?.height : undefined)",
      "  const listed2 = await api.articles.get('a-1', { fields: { articles: ['sections.*'] } })",
      "  const level: number | null | undefined = listed2.sections?.[0]?.kind === 'heading' ? listed2.sections[0].level : undefined",
      '  void [title, maths, views, selected, whole, lat, postcode, lng, sku, amount, quantity]',
      "  const covered = await api.articles.get('a-1', { fields: { articles: ['hero.alt'] } })",
      '  const hero = covered.hero',
      "  const heroKind: 'image' | 'video' = covered.hero!.kind",
      "  const alt: string | null | undefined = hero?.kind === 'image' ? hero.alt : undefined",
      '  // @ts-expect-error -- src was not selected.',
      "  void (hero?.kind === 'image' ? hero.src : undefined)",
      '  // @ts-expect-error -- url was not selected, and the video variant takes no keys.',
      "  void (hero?.kind === 'video' ? hero.url : undefined)",
      '  void [kind, text, width, level, heroKind, alt]',
      '}',
    ]
    const source = emit(selecting, buildDescriptor(selecting))
    expect(source).toContain(
      '    selectableKeys: {\n      scores: "(?:[a-z][a-z0-9_]*)",\n      totals: "[^.,*]+",\n      location: "(?:[a-z]+)",\n      lines: "\\\\*",\n      sections: "\\\\*",\n      hero: "(?:src|alt)"\n    },',
    )
    expect(typecheck(`${source}\n${probes.join('\n')}\n`)).toEqual([])
  })
})
