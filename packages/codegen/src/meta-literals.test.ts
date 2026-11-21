import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { emit } from './emit'
import type { OpenApiDocument, SchemaObject } from './openapi'
import { documentPath } from '../test/documents'

const load = (name: 'contract-witness.json' | 'music-catalog.openapi.json') =>
  JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument

const scratch = mkdtempSync(join(tmpdir(), 'json-api-meta-literals-'))
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

/** The `meta` object a component declares, in its `allOf` narrowing or as its own member. */
function metaOf(schemas: Record<string, SchemaObject>, component: string): SchemaObject {
  const schema = schemas[component]!
  const owner = schema.allOf?.[1] ?? schema
  return owner.properties!['meta'] as SchemaObject
}

/**
 * The witness with a member listing its values added to each kind of meta the bookings declare:
 * request, atomic request, resource, document, accepted, action, relationship request and
 * meta-only answer, pivot and identifier meta. They list them through `enum`, `const`, a `$ref` to
 * an enum component and a nullable `anyOf`, and the resource meta's open members list theirs.
 */
function withListedValues(): OpenApiDocument {
  const doc = load('contract-witness.json')
  const schemas = doc.components!.schemas!
  const add = (node: SchemaObject, name: string, member: SchemaObject) => {
    node.properties = { ...node.properties, [name]: member }
  }
  add(metaOf(schemas, 'BookingsCreateRequestDocument'), 'channel', {
    type: 'string',
    enum: ['web', 'desk'],
  })
  add(metaOf(schemas, 'BookingsDeleteRequestDocument'), 'by', { type: 'string', const: 'guest' })
  add(metaOf(schemas, 'BookingsConfirmActionPostRequestDocument'), 'status', {
    $ref: '#/components/schemas/Status',
  })
  add(metaOf(schemas, 'BookingsCreateAcceptedDocument'), 'lane', {
    anyOf: [{ type: 'string', enum: ['fast', 'slow'] }, { type: 'null' }],
  })
  add(metaOf(schemas, 'BookingsRoomsAddRelationshipRequestDocument'), 'shift', {
    type: 'integer',
    enum: [1, 2, 3],
  })
  add(metaOf(schemas, 'BookingsRoomsAddRelationshipDocument'), 'outcome', {
    type: 'string',
    enum: ['moved'],
  })
  add(schemas['BookingsResourceMeta']!, 'state', {
    type: ['string', 'null'],
    enum: ['held', 'paid', null],
  })
  schemas['BookingsResourceMeta']!['additionalProperties'] = {
    type: ['string', 'null'],
    enum: ['x', 'y', null],
  }
  add(schemas['BookingsRoomsPivot']!, 'board', { type: 'string', enum: ['full', 'half'] })
  add(schemas['BookingsRoomsWritePivot']!, 'board', { type: 'string', enum: ['full', 'half'] })
  add(schemas['BookingsRoomsIdentifierMeta']!, 'side', { type: 'string', enum: ['east', 'west'] })
  add(schemas['BookingsAtomicAddOperation']!.properties!['meta'] as SchemaObject, 'channel', {
    type: 'string',
    enum: ['web', 'desk'],
  })
  return doc
}

describe('meta members limited to listed values', () => {
  it("records each member's values beside its hint", () => {
    const bookings = buildDescriptor(withListedValues())['bookings']!
    expect(bookings.requestMeta?.create?.values).toEqual({ channel: ['web', 'desk'] })
    expect(bookings.atomicRequestMeta?.create?.values).toEqual({ channel: ['web', 'desk'] })
    expect(bookings.requestMeta?.delete?.values).toEqual({ by: ['guest'] })
    expect(bookings.actions?.['confirm']?.requestMeta?.values).toEqual({
      status: ['draft', 'published', 'archived'],
    })
    expect(bookings.accepted?.create?.meta?.values).toEqual({ lane: ['fast', 'slow'] })
    expect(bookings.resourceMeta?.read).toMatchObject({
      fields: { state: 'string' },
      values: { state: ['held', 'paid'] },
      additional: { format: 'string', nullable: true, values: ['x', 'y'] },
    })
    const rooms = bookings.relations['rooms']!
    expect(rooms.requestMeta?.add?.values).toEqual({ shift: [1, 2, 3] })
    expect(rooms.mutationMeta?.add?.values).toEqual({ outcome: ['moved'] })
    expect(rooms.readPivot?.values).toEqual({ board: ['full', 'half'] })
    expect(rooms.writePivot?.values).toEqual({ board: ['full', 'half'] })
    expect(rooms.identifierMeta?.values).toEqual({ side: ['east', 'west'] })
    expect(rooms.identifierMeta?.fields).toMatchObject({ side: 'string', view: 'string' })
  })

  it('records none for a member that takes any value of its hint', () => {
    for (const descriptor of Object.values(buildDescriptor(load('contract-witness.json')))) {
      expect(descriptor.requestMeta?.create?.values).toBeUndefined()
      expect(descriptor.resourceMeta?.read?.values).toBeUndefined()
      for (const relation of Object.values(descriptor.relations)) {
        expect(relation.readPivot?.values).toBeUndefined()
        expect(relation.identifierMeta?.values).toBeUndefined()
      }
    }
  })

  it("records the catalog's album source values, alone and inside a batch", () => {
    const albums = buildDescriptor(load('music-catalog.openapi.json'))['albums']!
    expect(albums.requestMeta?.create?.values).toEqual({ source: ['web', 'import', 'api'] })
    expect(albums.atomicRequestMeta?.create?.values).toEqual({ source: ['web', 'import', 'api'] })
  })

  it('compiles to a client that types each member as one of its values', () => {
    const doc = withListedValues()
    const probes = [
      "const api = createClient({ baseUrl: 'https://api.example' })",
      'export async function probe(): Promise<void> {',
      "  await api.bookings.create({ title: 'W' }, { meta: { idempotencyKey: 'k', channel: 'desk' } })",
      '  // @ts-expect-error -- channel is web or desk.',
      "  await api.bookings.create({ title: 'W' }, { meta: { idempotencyKey: 'k', channel: 'post' } })",
      "  await api.bookings.id('bk-1').delete({ meta: { cancellationReason: 'ill', by: 'guest' } })",
      '  // @ts-expect-error -- by is guest.',
      "  await api.bookings.id('bk-1').delete({ meta: { cancellationReason: 'ill', by: 'host' } })",
      "  await api.bookings.id('bk-1').actions.confirm({ meta: { status: 'draft' } })",
      '  // @ts-expect-error -- status is one of the Status values.',
      "  await api.bookings.id('bk-1').actions.confirm({ meta: { status: 'gone' } })",
      "  const booking = await api.bookings.get('bk-1')",
      "  const state: 'held' | 'paid' | null | undefined = booking.$meta?.state",
      "  const extra: 'x' | 'y' | 'held' | 'paid' | number | string | null | undefined = booking.$meta?.['other']",
      "  const rooms = await api.bookings.id('bk-1').rooms.get()",
      "  const side: 'east' | 'west' | undefined = rooms[0]?.$edge?.meta?.side",
      "  const board: 'full' | 'half' | undefined = rooms[0]?.$edge?.meta?.pivot?.board",
      "  const moved = await api.bookings.id('bk-1').rooms.add([{ type: 'rooms', id: 'rm-1', $pivot: { board: 'half' } }], { meta: { shift: 2 } })",
      "  const outcome: 'moved' | undefined = moved.outcome",
      "  const handle = api.bookings.id('bk-1')",
      '  // @ts-expect-error -- shift is 1, 2 or 3.',
      '  await handle.rooms.add([], { meta: { shift: 4 } })',
      '  // @ts-expect-error -- board is full or half.',
      "  await handle.rooms.add([{ type: 'rooms', id: 'rm-1', $pivot: { board: 'none' } }])",
      '  await api.atomic((tx) => [',
      '    // @ts-expect-error -- channel is web or desk inside a batch too.',
      "    tx.create({ type: 'bookings', title: 'W' }, { meta: { idempotencyKey: 'k', channel: 'post' } }),",
      '  ])',
      '  void [state, extra, side, board, outcome]',
      '}',
    ]
    const source = emit(doc, buildDescriptor(doc))
    expect(typecheck(`${source}\n${probes.join('\n')}\n`)).toEqual([])
  })

  it("refuses an album source the catalog doesn't list", () => {
    const doc = load('music-catalog.openapi.json')
    const probes = [
      "const api = createClient({ baseUrl: 'https://music.example' })",
      'export async function probe(): Promise<void> {',
      "  await api.albums.create({ title: 'x' } as never, { meta: { source: 'import' } })",
      '  // @ts-expect-error -- source is web, import or api.',
      "  await api.albums.create({ title: 'x' } as never, { meta: { source: 'nope' } })",
      '}',
    ]
    const source = emit(doc, buildDescriptor(doc))
    expect(typecheck(`${source}\n${probes.join('\n')}\n`)).toEqual([])
  })
})
