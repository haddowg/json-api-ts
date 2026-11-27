import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract, MAXIMUM_CONTRACT } from './contract'
import { emit } from './emit'
import type { OpenApiDocument, SchemaObject } from './openapi'
import { documentPath } from '../test/documents'

const read = (name: 'contract-witness.json' | 'contract-witness-baseline.json') =>
  JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument

const witness = read('contract-witness.json')
const baseline = read('contract-witness-baseline.json')

const scratch = mkdtempSync(join(tmpdir(), 'json-api-pivot-rendered-'))
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

/** The `allOf` branch narrowing the `meta` of each member of a to-many relationship's linkage. */
function narrowing(doc: OpenApiDocument, component: string): SchemaObject {
  const data = doc.components!.schemas![component]!.properties!['data'] as SchemaObject
  return data.items!.allOf!.find((part) => part.properties?.['meta'] !== undefined)!
}

/**
 * The example a pivot relation's relationship object carries: its member's `meta.pivot` and
 * declared identifier meta, from each field's example. One with a field declaring no example has
 * none.
 */
const EXAMPLES: Record<string, unknown[]> = {
  ArticlesSponsorsRelationship: [
    {
      data: [
        {
          type: 'people',
          id: 'per-1',
          meta: { pivot: { rank: 1, since: '2026-01-01T00:00:00+00:00' } },
        },
      ],
    },
  ],
  BookingsRoomsRelationship: [
    { data: [{ type: 'rooms', id: 'rm-1', meta: { view: 'sea', pivot: { nights: 2 } } }] },
  ],
}

/**
 * The witness as a server projects it now: each response linkage identifier of a pivot relation
 * requires `meta`, and its `meta` requires `pivot`, inline or in the declared identifier meta it
 * refs. Its relationship object's example carries that `meta`, or it has none where a field
 * declares no example, and the document is stamped 48. No core release carries 48 yet, so this
 * grafts that change onto the pinned witness.
 */
function rendered(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc)
  const schemas = copy.components!.schemas!
  for (const [name, schema] of Object.entries(schemas)) {
    if (!/Relationship(Document)?$/.test(name) || /(Write|Request)Relationship$/.test(name)) {
      continue
    }
    const data = schema.properties?.['data'] as SchemaObject | undefined
    const part = data?.items?.allOf?.find((entry) => entry.properties?.['meta'] !== undefined)
    const meta = part?.properties?.['meta'] as SchemaObject | undefined
    const declared = meta?.$ref === undefined ? undefined : schemas[meta.$ref.split('/').pop()!]
    const target = declared ?? meta
    if (part === undefined || target?.properties?.['pivot'] === undefined) {
      continue
    }
    ;(part as { required?: string[] }).required = ['meta']
    if (!(target.required ?? []).includes('pivot')) {
      ;(target as { required?: string[] }).required = [...(target.required ?? []), 'pivot']
    }
    if (EXAMPLES[name] === undefined) {
      delete (schema as Record<string, unknown>)['examples']
    } else {
      ;(schema as Record<string, unknown>)['examples'] = EXAMPLES[name]
    }
  }
  copy.info!['x-generator'] = { contract: 48 }
  return copy
}

/**
 * A pivot relation's response linkage renders `meta.pivot` on every member, so its response
 * identifiers require `meta` and its `pivot`. The codegen records that as the relation's
 * `pivotRendered`, read through an inline `meta` and through the declared identifier meta a
 * `meta` refs. The request identifiers leave both optional, and the write pivot stays as it was.
 */
describe('generator contract 48 (a pivot rendered on every linkage member)', () => {
  const doc = rendered(witness)
  const base = rendered(baseline)

  it('reads the document without a warning, and warns past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(48)
    expect(narrowing(doc, 'ArticlesSponsorsRelationship')).toEqual({
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: { pivot: { $ref: '#/components/schemas/ArticlesSponsorsPivot' } },
          required: ['pivot'],
        },
      },
      required: ['meta'],
    })
    expect(doc.components!.schemas!['ArticlesTagsIdentifierMeta']!.required).toEqual([
      'addedVia',
      'pivot',
    ])
    expect(checkContract(doc)).toBeUndefined()
    expect(checkContract(base)).toBeUndefined()
    const newer = { ...doc, info: { ...doc.info!, 'x-generator': { contract: 49 } } }
    expect(checkContract(newer as OpenApiDocument)).toContain('reads up to 48')
  })

  it('marks each pivot relation rendering its pivot on every member', () => {
    const descriptor = buildDescriptor(doc)
    // Inline `meta`, over a polymorphic union.
    expect(descriptor['articles']!.relations['sponsors']!.pivotRendered).toBe(true)
    // `meta` refs the declared identifier meta, which requires `pivot`.
    expect(descriptor['articles']!.relations['tags']!.pivotRendered).toBe(true)
    expect(descriptor['bookings']!.relations['rooms']!.pivotRendered).toBe(true)
    expect(buildDescriptor(base)['articles']!.relations['tags']!.pivotRendered).toBe(true)
  })

  it('leaves the write pivot and every other relation as they were', () => {
    const before = buildDescriptor(witness)
    const after = buildDescriptor(doc)
    for (const [type, resource] of Object.entries(after)) {
      for (const [name, relation] of Object.entries(resource.relations)) {
        const { pivotRendered, ...rest } = relation
        expect(rest, `${type}.${name}`).toEqual(before[type]!.relations[name])
        expect(pivotRendered === true, `${type}.${name}`).toBe(relation.pivot === true)
      }
    }
  })

  it('does not mark a relation whose identifiers leave the pivot optional', () => {
    const relations = buildDescriptor(witness)['articles']!.relations
    expect(relations['sponsors']!.pivotRendered).toBeUndefined()
    expect(relations['tags']!.pivotRendered).toBeUndefined()
  })

  it('emits the mark on the relation', () => {
    expect(emit(doc, buildDescriptor(doc))).toMatch(/pivotRendered: true/)
  })

  it('compiles to a client typing the response pivot present and the request pivot optional', () => {
    const probes = [
      "const api = createClient({ baseUrl: 'https://api.example' })",
      'export async function probe(): Promise<void> {',
      "  const sponsors = await api.articles.id('a-1').sponsors.get()",
      '  const sponsor = sponsors[0]!',
      '  const rank: number = sponsor.$pivot.rank',
      '  const since: string | null = sponsor.$edge.meta.pivot.since',
      "  const tags = await api.articles.id('a-1').tags.get()",
      '  const position: number = tags[0]!.$edge.meta.pivot.position',
      '  const addedVia: string | null = tags[0]!.$edge.meta.addedVia',
      "  const rooms = await api.bookings.id('bk-1').rooms.get()",
      '  const nights: number | null = rooms[0]!.$pivot.nights',
      "  const article = await api.articles.get('a-1')",
      '  const linked: number = article.tags[0]!.$edge.meta.pivot.position',
      '  const slot: number = article.tags[0]!.$pivot.position',
      '  const tagged: boolean | null = article.tags[0]!.$pivot.primary',
      "  const related = await api.articles.id('a-1').tags.related()",
      '  // @ts-expect-error -- a related resource object may come without its pivot.',
      '  void related[0]!.$pivot.position',
      "  await api.articles.id('a-1').tags.add([{ type: 'tags', id: 't-1' }])",
      "  await api.articles.id('a-1').tags.add([{ type: 'tags', id: 't-1', $pivot: { position: 1 } }])",
      '  void [rank, since, position, addedVia, nights, linked, slot, tagged]',
      '}',
    ]
    const source = emit(doc, buildDescriptor(doc))
    expect(typecheck(`${source}\n${probes.join('\n')}\n`)).toEqual([])
  })
})
