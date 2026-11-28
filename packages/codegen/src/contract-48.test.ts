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

/** A schema node the atomic graft reads and writes: any JSON, walked without checks. */
// oxlint-disable-next-line typescript/no-explicit-any
type Node = any

/** The typed relations a relationship operation can answer for, in the order the server lists them. */
const TYPED_LINKAGE = [
  ['articles', 'author'],
  ['articles', 'tags'],
  ['articles', 'attachments'],
  ['articles', 'sponsors'],
  ['bookings', 'rooms'],
] as const

/** A component name's part for a type or relation name. */
const pascal = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

/**
 * The witness's atomic results as a server projects them now. Each relation typing its identifiers'
 * `meta` adds its response linkage to `AtomicResult.data`, described by the relation, and a type only
 * those relations link to leaves the shared identifier union. The mutation-locked relation declares
 * identifier meta where the witness declares any, and adds no branch.
 */
function atomicLinkage(copy: OpenApiDocument): void {
  const schemas = (copy as unknown as { components: { schemas: Record<string, Node> } }).components
    .schemas
  const branches: Node[] = []
  for (const [type, relation] of TYPED_LINKAGE) {
    const data =
      schemas[`${pascal(type)}${pascal(relation)}RelationshipDocument`]?.['properties']?.['data']
    const description = `The linkage of the "${relation}" relationship of the "${type}" type.`
    if (data?.['items']?.['allOf'] !== undefined) {
      branches.push({ type: 'array', description, items: data['items'] } as unknown as Node)
    } else if (data?.['anyOf']?.[0]?.['allOf'] !== undefined) {
      branches.push({ description, ...data['anyOf'][0] } as unknown as Node)
    }
  }
  const union = schemas['AtomicResult']!['properties']['data']['anyOf'] as unknown as Node[]
  for (const shared of [union[1]!, union[2]!['items']]) {
    shared['oneOf'] = (shared['oneOf'] as unknown as Node[]).filter(
      (entry) => entry['$ref'] !== ('#/components/schemas/TagsResourceIdentifier' as unknown),
    ) as unknown as Node
    delete shared['discriminator']['mapping']['tags']
  }
  union.splice(union.length - 1, 0, ...structuredClone(branches))

  if (schemas['ArticlesAttachmentsIdentifierMeta'] === undefined) {
    return
  }
  const meta = {
    type: 'object',
    properties: { lockedBy: { type: ['string', 'null'], examples: ['editor'] } },
    required: ['lockedBy'],
    additionalProperties: false,
  } as unknown as Node
  const entries = Object.entries(schemas)
  const at = entries.findIndex(([name]) => name === 'ArticlesLockedFetchRelationship404') + 1
  entries.splice(at, 0, ['ArticlesLockedIdentifierMeta', meta])
  for (const name of Object.keys(schemas)) {
    delete schemas[name]
  }
  Object.assign(schemas, Object.fromEntries(entries))
  for (const name of ['ArticlesLockedRelationship', 'ArticlesLockedRelationshipDocument']) {
    const data = schemas[name]!['properties']['data']
    data['items'] = {
      allOf: [
        data['items'],
        {
          type: 'object',
          properties: { meta: { $ref: '#/components/schemas/ArticlesLockedIdentifierMeta' } },
        },
      ],
    } as unknown as Node
  }
  const paths = (copy as unknown as { paths: Record<string, Node> }).paths
  const example =
    paths['/articles/{id}/relationships/locked']!['get']['responses']['200']['content'][
      'application/vnd.api+json'
    ]['example']
  example['data'][0]!['meta'] = { lockedBy: 'editor' } as unknown as Node
}

/** A generated module without its spec hash, which differs whenever the document does. */
const unhashed = (source: string) => source.replace(/Spec hash: +\w+/, '')

/**
 * The witness as a server projects it now: each response linkage identifier of a pivot relation
 * requires `meta`, and its `meta` requires `pivot`, inline or in the declared identifier meta it
 * refs. Its relationship object's example carries that `meta`, or it has none where a field
 * declares no example, its atomic results carry each typed relation's linkage, and the document
 * is stamped 48. No core release carries 48 yet, so this grafts that change onto the pinned witness.
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
  atomicLinkage(copy)
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
        if (type === 'articles' && name === 'locked') {
          // The mutation-locked relation declares identifier meta now, and nothing else moved.
          const { identifierMeta, ...unlocked } = rest
          expect(identifierMeta).toEqual({
            fields: { lockedBy: 'string' },
            nullable: ['lockedBy'],
            additional: false,
          })
          expect(unlocked).toEqual(before[type]!.relations[name])
          continue
        }
        expect(rest, `${type}.${name}`).toEqual(before[type]!.relations[name])
        expect(pivotRendered === true, `${type}.${name}`).toBe(relation.pivot === true)
      }
    }
  })

  it("carries each typed relation's linkage among the atomic results", () => {
    const union = (doc.components!.schemas!['AtomicResult']!.properties!['data'] as SchemaObject)
      .anyOf!
    const typed = union.filter((branch) => branch.description !== undefined)
    expect(typed.map((branch) => branch.description)).toEqual(
      TYPED_LINKAGE.map(
        ([type, rel]) => `The linkage of the "${rel}" relationship of the "${type}" type.`,
      ),
    )
    const sponsors = typed[3]!.items!.allOf![1]!
    expect(sponsors.required).toEqual(['meta'])
    expect((sponsors.properties!['meta'] as SchemaObject).required).toEqual(['pivot'])
    const shared = union[1]!.oneOf!.map((entry) => entry.$ref)
    expect(shared).not.toContain('#/components/schemas/TagsResourceIdentifier')
    expect(shared).toContain('#/components/schemas/PeopleResourceIdentifier')
    const baseUnion = (
      base.components!.schemas!['AtomicResult']!.properties!['data'] as SchemaObject
    ).anyOf!
    expect(baseUnion.filter((branch) => branch.description !== undefined)).toHaveLength(1)
  })

  it('builds the same descriptor and server constants whatever the atomic results carry', () => {
    const withoutResults = structuredClone(doc)
    withoutResults.components!.schemas!['AtomicResult'] =
      witness.components!.schemas!['AtomicResult']!
    expect(buildDescriptor(doc)).toEqual(buildDescriptor(withoutResults))
    expect(unhashed(emit(doc, buildDescriptor(doc)))).toBe(
      unhashed(emit(withoutResults, buildDescriptor(withoutResults))),
    )
  })

  it('does not mark a relation whose identifiers leave the pivot optional', () => {
    const relations = buildDescriptor(witness)['articles']!.relations
    expect(relations['sponsors']!.pivotRendered).toBeUndefined()
    expect(relations['tags']!.pivotRendered).toBeUndefined()
  })

  it('emits the mark on the relation', () => {
    expect(emit(doc, buildDescriptor(doc))).toMatch(/pivotRendered: true/)
  })

  it('compiles to a client typing the response pivot present, apart while pending, in an atomic result, and the request pivot optional', () => {
    const probes = [
      "const api = createClient({ baseUrl: 'https://api.example' })",
      'export async function probe(): Promise<void> {',
      "  const sponsors = await api.articles.id('a-1').sponsors.get()",
      '  const sponsor = sponsors[0]!',
      '  const rank: number = sponsor.$pivot.rank',
      "  if (sponsor.$optimistic !== 'pending') {",
      '    const since: string | null = sponsor.$edge.meta.pivot.since',
      '    void since',
      '  } else {',
      '    const unstamped: string | null | undefined = sponsor.$pivot.since',
      '    // @ts-expect-error -- a pending member lacks the pivot fields only the server sets.',
      '    const stamped: string | null = sponsor.$edge.meta.pivot.since',
      '    void [unstamped, stamped]',
      '  }',
      "  const tags = await api.articles.id('a-1').tags.get()",
      '  const position: number = tags[0]!.$edge.meta.pivot.position',
      '  const addedVia: string | null = tags[0]!.$edge.meta.addedVia',
      "  const rooms = await api.bookings.id('bk-1').rooms.get()",
      '  const room = rooms[0]!',
      "  const nights: number | null = room.$optimistic === 'pending' ? null : room.$pivot.nights",
      '  // @ts-expect-error -- a pending member may lack a field its write could leave out.',
      '  const unsent: number | null = room.$pivot.nights',
      "  const article = await api.articles.get('a-1')",
      '  const linked: number = article.tags[0]!.$edge.meta.pivot.position',
      '  const slot: number = article.tags[0]!.$pivot.position',
      '  const tag = article.tags[0]!',
      "  const tagged: boolean | null = tag.$optimistic === 'pending' ? null : tag.$pivot.primary",
      "  const related = await api.articles.id('a-1').tags.related()",
      '  // @ts-expect-error -- a related resource object may come without its pivot.',
      '  void related[0]!.$pivot.position',
      '  const [sponsored, retagged] = await api.atomic((tx) => [',
      "    tx.rel({ type: 'articles', id: 'a-1' }, 'sponsors').add([{ type: 'people', id: 'per-1', $pivot: { rank: 1 } }]),",
      "    tx.rel({ type: 'articles', id: 'a-1' }, 'tags').replace([{ type: 'tags', id: 't-1' }]),",
      '  ] as const)',
      '  const settled: string | null = sponsored.data![0]!.$pivot.since',
      '  const placed: number = retagged.data![0]!.$edge.meta.pivot.position',
      '  void [settled, placed]',
      "  await api.articles.id('a-1').tags.add([{ type: 'tags', id: 't-1' }])",
      "  await api.articles.id('a-1').tags.add([{ type: 'tags', id: 't-1', $pivot: { position: 1 } }])",
      '  void [rank, position, addedVia, nights, unsent, linked, slot, tagged]',
      '}',
    ]
    const source = emit(doc, buildDescriptor(doc))
    expect(typecheck(`${source}\n${probes.join('\n')}\n`)).toEqual([])
  })
})
