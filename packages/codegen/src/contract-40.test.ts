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

const load = (name: 'contract-witness.json' | 'contract-witness-baseline.json') =>
  JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument
const singleton = load('contract-witness.json')
// Core's second witness leaves out every structure only some documents carry, the singleton too.
const baseline = load('contract-witness-baseline.json')

const scratch = mkdtempSync(join(tmpdir(), 'json-api-singleton-'))
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
 * A singleton type serves each caller one resource at a path with no `{id}`, which its
 * `<Type>Resource` names in `x-singleton`. It has no collection or create for the codegen to find
 * it from, so the codegen reads its paths from that extension.
 */
describe('generator contract 40 (singleton types)', () => {
  it('reads a document stamped 40 without a warning, and warns past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(40)
    expect(singleton.info?.['x-generator']?.contract).toBe(40)
    expect(checkContract(singleton)).toBeUndefined()
    const newer = { ...singleton, info: { ...singleton.info!, 'x-generator': { contract: 41 } } }
    expect(checkContract(newer as OpenApiDocument)).toContain('reads up to 40')
  })

  it('routes a singleton at its own path, with no collection, create or delete', () => {
    const inboxes = buildDescriptor(singleton)['inboxes']!
    expect(inboxes.singleton).toBe(true)
    expect(inboxes.paths).toEqual({
      fetchOne: '/inbox',
      fetchRelated: '/inbox/{rel}',
      fetchRelationship: '/inbox/relationships/{rel}',
      update: '/inbox',
    })
    expect(inboxes.clientId).toBe('forbidden')
    expect(inboxes.paginator).toBe('none')
    // Its <Type>Collection component stays for to-many relations, and names no collection read.
    expect(singleton.components?.schemas?.['InboxesCollection']).toBeDefined()
    expect(inboxes.sortable).toBeUndefined()
    expect(inboxes.filterable).toBeUndefined()
    expect(inboxes.countable).toBeUndefined()
  })

  it('reads its relations, actions and relatedQuery under that path', () => {
    const inboxes = buildDescriptor(singleton)['inboxes']!
    expect(inboxes.relations['owner']).toMatchObject({
      cardinality: 'one',
      types: ['people'],
      relatedQuery: true,
      mutations: { set: true },
    })
    expect(inboxes.relations['owner']?.related).toBeUndefined()
    expect(inboxes.relations['owner']?.relationship).toBeUndefined()
    expect(inboxes.actions).toEqual({
      'mark-all-read': {
        scope: 'resource',
        path: '/inbox/-actions/mark-all-read',
        input: 'none',
        output: 'document',
        outputType: 'inboxes',
        outputCardinality: 'one',
        relatedQuery: true,
      },
    })
    expect(inboxes.relatedQuery).toMatchObject({
      operations: ['fetchOne', 'update'],
      relations: ['owner'],
    })
    expect(inboxes.scopes).toEqual({
      'fetchRelated.owner': ['people:read'],
      'fetchRelationship.owner': ['people:read'],
    })
  })

  it('marks no type of a document without a singleton', () => {
    expect(baseline.info?.['x-generator']?.contract).toBe(39)
    const descriptor = buildDescriptor(baseline)
    expect(descriptor['inboxes']).toBeUndefined()
    expect(Object.values(descriptor).some((type) => type.singleton !== undefined)).toBe(false)
  })

  it('generates the singleton beside the other types', () => {
    const source = emit(singleton, buildDescriptor(singleton))
    expect(source).toContain('    singleton: true,\n')
    expect(source).toContain('      fetchOne: "/inbox",\n')
    expect(source).toContain('  inboxes: { update: InboxesUpdateAttributes }\n')
    expect(source).toContain('  "update.inboxes":')
    expect(source).not.toContain('InboxesCreateAttributes')
  })

  it('compiles to a client that reaches the singleton without an id', () => {
    const probes = [
      "const api = createClient({ baseUrl: 'https://api.example' })",
      'export async function probe(): Promise<void> {',
      '  const inbox = await api.inboxes.get()',
      '  const unread: number | null = inbox.unread',
      '  void unread',
      "  await api.inboxes.update({ id: inbox.id, seenUpTo: '2026-11-16T09:30:00+00:00' })",
      '  await api.inboxes.owner.related()',
      "  await api.inboxes.owner.set({ type: 'people', id: 'per-2' })",
      "  await api.inboxes.actions['mark-all-read']()",
      "  await api.people.id('per-1').get()",
      '  // @ts-expect-error -- the update body needs the id.',
      "  await api.inboxes.update({ seenUpTo: '2026-11-16T09:30:00+00:00' })",
      '  // @ts-expect-error -- a singleton has no id handle.',
      "  void api.inboxes.id('42')",
      '  // @ts-expect-error -- nor a collection read.',
      '  void api.inboxes.list()',
      '}',
    ]
    const source = emit(singleton, buildDescriptor(singleton))
    expect(typecheck(`${source}\n${probes.join('\n')}\n`)).toEqual([])
  })
})
