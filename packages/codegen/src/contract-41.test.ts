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

const load = (
  name: 'contract-witness.json' | 'contract-witness-baseline.json' | 'music-catalog.openapi.json',
) => JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument
const typed = load('contract-witness.json')
// Core's second witness leaves out every structure only some documents carry, typed meta too.
const baseline = load('contract-witness-baseline.json')
const catalog = load('music-catalog.openapi.json')

const scratch = mkdtempSync(join(tmpdir(), 'json-api-document-meta-'))
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

const COLLECTION_META = {
  fields: { digest: 'string', page: 'object', total: 'integer', unread: 'integer' },
  required: ['unread'],
  nullable: ['digest'],
}

/**
 * An operation declaring its top-level `meta` answers with a document component of its own, an
 * `allOf` of the shared document and a narrowing of `meta`, marked `x-document-meta`. The codegen
 * reads the shared document through it and records the declared members in the descriptor.
 */
describe('generator contract 41 (typed document meta)', () => {
  it('reads a document stamped 41 without a warning', () => {
    expect(typed.info?.['x-generator']?.contract).toBe(44)
    expect(checkContract(typed)).toBeUndefined()
  })

  it('records the meta each operation declares, and none for the create', () => {
    const notices = buildDescriptor(typed)['notices']!
    expect(notices.documentMeta).toEqual({
      fetchMany: COLLECTION_META,
      fetchOne: { fields: { etag: 'string' } },
      update: { fields: { etag: 'string' }, required: [], nullable: ['etag'] },
      delete: { fields: { archived: 'integer' } },
    })
    expect(notices.relations['replies']?.documentMeta).toEqual(COLLECTION_META)
  })

  it('reads the shared document through each per-operation component', () => {
    const notices = buildDescriptor(typed)['notices']!
    expect(notices.paths).toMatchObject({ fetchMany: '/notices', fetchOne: '/notices/{id}' })
    expect(notices.paginator).toBe('page')
    expect(notices.actions?.['mark-read']).toEqual({
      scope: 'collection',
      path: '/notices/-actions/mark-read',
      input: 'none',
      output: 'document',
      outputType: 'notices',
      outputCardinality: 'one',
      relatedQuery: true,
      documentMeta: { '200': { fields: { marked: 'integer' } } },
    })
    // A collection read whose document narrows `<Type>Collection` still names the collection path.
    const readOnly = structuredClone(typed)
    delete readOnly.paths!['/notices']!.post
    expect(buildDescriptor(readOnly)['notices']?.paths['fetchMany']).toBe('/notices')
  })

  it('answers a meta-only 200 beside a 201 with either', () => {
    const snapshot = buildDescriptor(typed)['notices']!.actions?.['snapshot']
    expect(snapshot).toEqual({
      scope: 'resource',
      path: '/notices/{id}/-actions/snapshot',
      input: 'none',
      output: 'document',
      metaResult: true,
      outputType: 'notices',
      outputCardinality: 'one',
      relatedQuery: true,
      documentMeta: {
        '200': { fields: { unchanged: 'boolean' } },
        '201': { fields: { snapshotOf: 'string' } },
      },
    })
    // A meta-only action narrowing MetaDocument stays meta-only.
    const metaOnly = structuredClone(typed)
    delete metaOnly.paths!['/notices/{id}/-actions/snapshot']!.post!.responses!['201']
    const action = buildDescriptor(metaOnly)['notices']!.actions?.['snapshot']
    expect(action?.output).toBe('meta')
    expect(action?.metaResult).toBeUndefined()
    expect(action?.documentMeta).toEqual({ '200': { fields: { unchanged: 'boolean' } } })
  })

  it('records no meta for a document that declares none', () => {
    expect(baseline.info?.['x-generator']?.contract).toBe(44)
    const descriptor = buildDescriptor(baseline)
    expect(descriptor['notices']).toBeUndefined()
    for (const type of Object.values(descriptor)) {
      expect(type.documentMeta).toBeUndefined()
      for (const action of Object.values(type.actions ?? {})) {
        expect(action.documentMeta).toBeUndefined()
      }
    }
  })

  it('reads the meta the music catalog declares', () => {
    const albums = buildDescriptor(catalog)['albums']!
    expect(albums.documentMeta).toEqual({
      fetchMany: {
        fields: { explicitCount: 'integer', page: 'object', total: 'integer' },
        required: ['explicitCount'],
      },
    })
    expect(albums.actions?.['reissue']?.documentMeta).toEqual({
      '200': { fields: { previousReleasedAt: 'date-time' }, nullable: ['previousReleasedAt'] },
    })
    expect(buildDescriptor(catalog)['artists']!.relations['albums']?.documentMeta).toEqual(
      albums.documentMeta?.fetchMany,
    )
  })

  it('documents each declared member on its descriptor entry', () => {
    const source = emit(typed, buildDescriptor(typed))
    expect(source).toContain('          /**\n           * How many notices are unread.\n')
    expect(source).toContain('* How many notices this call marked read.')
  })

  it('compiles to a client that types each declared meta', () => {
    const probes = [
      "const api = createClient({ baseUrl: 'https://api.example' })",
      'export async function probe(): Promise<void> {',
      '  const notices = await api.notices.list()',
      '  const unread: number = notices.$meta.unread',
      '  const digest: string | null | undefined = notices.$meta.digest',
      '  const total: number | undefined = notices.$meta.total',
      '  const page: Record<string, unknown> | undefined = notices.$meta.page',
      '  const next = await notices.$next()',
      '  const nextUnread: number | undefined = next?.$meta.unread',
      "  const notice = await api.notices.get('n-1')",
      '  const etag: string = notice.$document.meta.etag',
      "  const updated = await api.notices.id('n-1').update({ message: 'Hi' })",
      '  const updatedEtag: string | null | undefined = updated.$document.meta?.etag',
      "  const created = await api.notices.create({ message: 'Hi' })",
      '  const createdMeta: Record<string, unknown> | undefined = created.$document.meta',
      "  const archived: number = (await api.notices.id('n-1').delete()).archived",
      "  const replies = await api.notices.id('n-1').replies.related()",
      '  const repliesUnread: number = replies.$meta.unread',
      "  const marked = await api.notices.actions['mark-read']()",
      '  const markedCount: number = marked.$document.meta.marked',
      "  const snapshot = await api.notices.id('n-1').actions.snapshot()",
      "  if ('unchanged' in snapshot) {",
      '    const unchanged: boolean = snapshot.unchanged',
      '    void unchanged',
      '  } else {',
      '    const of: string = snapshot.$document.meta.snapshotOf',
      '    void of',
      '  }',
      '  const articles = await api.articles.list()',
      '  const loose: Record<string, unknown> | undefined = articles.$meta',
      "  const removed: void = await api.articles.id('a-1').delete()",
      '  // @ts-expect-error -- unread is an integer.',
      '  const wrong: string = notices.$meta.unread',
      '  // @ts-expect-error -- the collection meta is closed to undeclared members.',
      '  void notices.$meta.missing',
      '  void [unread, digest, total, page, nextUnread, etag, updatedEtag, createdMeta, archived]',
      '  void [repliesUnread, markedCount, loose, removed, wrong]',
      '}',
    ]
    const source = emit(typed, buildDescriptor(typed))
    expect(typecheck(`${source}\n${probes.join('\n')}\n`)).toEqual([])
  })
})
