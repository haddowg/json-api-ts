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

const LANES = { type: 'array', items: { type: 'string', enum: ['fast', 'slow'] } } as const

/**
 * The witness with a list member whose items list their values added to each kind of meta: the
 * bookings' request, atomic request, resource, accepted, action, relationship request and
 * meta-only answer meta, pivots and identifier meta, and the notices' document meta. The items
 * list them through `enum`, `const`, a `$ref` to an enum component, an `anyOf` and a `oneOf` of
 * literals, one list is nullable, and the resource meta's open members are such lists too.
 */
function withListedLists(): OpenApiDocument {
  const doc = load('contract-witness.json')
  const schemas = doc.components!.schemas!
  const add = (node: SchemaObject, name: string, member: SchemaObject) => {
    node.properties = { ...node.properties, [name]: member }
  }
  add(metaOf(schemas, 'BookingsCreateRequestDocument'), 'lanes', LANES)
  add(schemas['BookingsAtomicAddOperation']!.properties!['meta'] as SchemaObject, 'lanes', LANES)
  add(metaOf(schemas, 'BookingsDeleteRequestDocument'), 'by', {
    type: 'array',
    items: { type: 'string', const: 'guest' },
  })
  add(metaOf(schemas, 'BookingsConfirmActionPostRequestDocument'), 'statuses', {
    type: 'array',
    items: { $ref: '#/components/schemas/Status' },
  })
  add(metaOf(schemas, 'BookingsCreateAcceptedDocument'), 'lanes', {
    anyOf: [LANES, { type: 'null' }],
  })
  add(metaOf(schemas, 'BookingsRoomsAddRelationshipRequestDocument'), 'shifts', {
    type: 'array',
    items: { anyOf: [{ const: 1 }, { const: 2 }] },
  })
  add(metaOf(schemas, 'BookingsRoomsAddRelationshipDocument'), 'outcomes', {
    type: 'array',
    items: {
      oneOf: [
        { type: 'string', const: 'moved' },
        { type: 'string', const: 'kept' },
      ],
    },
  })
  add(schemas['BookingsResourceMeta']!, 'states', {
    type: ['array', 'null'],
    items: { type: 'string', enum: ['held', 'paid'] },
  })
  schemas['BookingsResourceMeta']!['additionalProperties'] = LANES
  add(schemas['BookingsCreateResourceMeta']!, 'channels', {
    type: 'array',
    items: { type: 'string', enum: ['web', 'desk'] },
  })
  add(schemas['BookingsRoomsPivot']!, 'boards', LANES)
  add(schemas['BookingsRoomsWritePivot']!, 'boards', LANES)
  add(schemas['BookingsRoomsIdentifierMeta']!, 'sides', LANES)
  add(metaOf(schemas, 'NoticesFetchCollectionDocument'), 'regions', {
    type: 'array',
    items: { type: 'string', enum: ['eu', 'us'] },
  })
  add(metaOf(schemas, 'NoticesFetchOneDocument'), 'loose', {
    type: 'array',
    items: { type: ['string', 'null'], enum: ['a', null] },
  })
  return doc
}

describe('list meta members whose items list their values', () => {
  it("records each list's item values beside its array hint", () => {
    const descriptor = buildDescriptor(withListedLists())
    const bookings = descriptor['bookings']!
    const lanes = ['fast', 'slow']
    expect(bookings.requestMeta?.create).toMatchObject({
      fields: { lanes: 'array' },
      values: { lanes },
    })
    expect(bookings.atomicRequestMeta?.create?.values).toEqual({ lanes })
    expect(bookings.requestMeta?.delete?.values).toEqual({ by: ['guest'] })
    expect(bookings.actions?.['confirm']?.requestMeta?.values).toEqual({
      statuses: ['draft', 'published', 'archived'],
    })
    expect(bookings.accepted?.create?.meta?.values).toEqual({ lanes })
    expect(bookings.resourceMeta?.read).toMatchObject({
      values: { states: ['held', 'paid'] },
      nullable: expect.arrayContaining(['states']) as unknown,
      additional: { format: 'array', values: lanes },
    })
    expect(bookings.resourceMeta?.create?.values).toEqual({ channels: ['web', 'desk'] })
    const rooms = bookings.relations['rooms']!
    expect(rooms.requestMeta?.add?.values).toEqual({ shifts: [1, 2] })
    expect(rooms.mutationMeta?.add?.values).toEqual({ outcomes: ['moved', 'kept'] })
    expect(rooms.readPivot?.values).toEqual({ boards: lanes })
    expect(rooms.writePivot?.values).toEqual({ boards: lanes })
    expect(rooms.identifierMeta?.values).toEqual({ sides: lanes })
    const notices = descriptor['notices']!
    expect(notices.documentMeta?.fetchMany?.values).toEqual({ regions: ['eu', 'us'] })
    // Items that may be null aren't limited to literals.
    expect(notices.documentMeta?.fetchOne?.values).toBeUndefined()
  })

  it('compiles to a client that types each list as a list of its item values', () => {
    const doc = withListedLists()
    const probes = [
      "const api = createClient({ baseUrl: 'https://api.example' })",
      'export async function probe(): Promise<void> {',
      "  await api.bookings.create({ title: 'W' }, { meta: { idempotencyKey: 'k', lanes: ['fast'] } })",
      '  // @ts-expect-error -- each lane is fast or slow.',
      "  await api.bookings.create({ title: 'W' }, { meta: { idempotencyKey: 'k', lanes: ['medium'] } })",
      '  // @ts-expect-error -- lanes is a list.',
      "  await api.bookings.create({ title: 'W' }, { meta: { idempotencyKey: 'k', lanes: 'fast' } })",
      '  await api.atomic((tx) => [',
      '    // @ts-expect-error -- inside a batch too.',
      "    tx.create({ type: 'bookings', title: 'W' }, { meta: { idempotencyKey: 'k', lanes: ['medium'] } }),",
      '  ])',
      "  const handle = api.bookings.id('bk-1')",
      "  await handle.delete({ meta: { cancellationReason: 'ill', by: ['guest'] } })",
      '  // @ts-expect-error -- by lists guest.',
      "  await handle.delete({ meta: { cancellationReason: 'ill', by: ['host'] } })",
      "  await handle.actions.confirm({ meta: { statuses: ['draft', 'archived'] } })",
      '  // @ts-expect-error -- each status is one of the Status values.',
      "  await handle.actions.confirm({ meta: { statuses: ['gone'] } })",
      "  const booking = await api.bookings.get('bk-1')",
      "  const states: readonly ('held' | 'paid')[] | null | undefined = booking.$meta?.states",
      "  const created = await api.bookings.create({ title: 'W', $meta: { channels: ['desk'] } }, { meta: { idempotencyKey: 'k', lanes: [] } })",
      "  const jobLanes: readonly ('fast' | 'slow')[] | null | undefined = 'meta' in created ? created.meta?.lanes : undefined",
      '  // @ts-expect-error -- each channel is web or desk.',
      "  await api.bookings.create({ title: 'W', $meta: { channels: ['post'] } }, { meta: { idempotencyKey: 'k', lanes: [] } })",
      '  const rooms = await handle.rooms.get()',
      "  const sides: readonly ('fast' | 'slow')[] | undefined = rooms[0]?.$edge?.meta?.sides",
      "  const boards: readonly ('fast' | 'slow')[] | undefined = rooms[0]?.$edge?.meta?.pivot?.boards",
      "  const moved = await handle.rooms.add([{ type: 'rooms', id: 'rm-1', $pivot: { boards: ['slow'] } }], { meta: { shifts: [1, 2] } })",
      "  const outcomes: readonly ('moved' | 'kept')[] | undefined = moved.outcomes",
      '  // @ts-expect-error -- each shift is 1 or 2.',
      '  await handle.rooms.add([], { meta: { shifts: [3] } })',
      '  // @ts-expect-error -- each board is fast or slow.',
      "  await handle.rooms.add([{ type: 'rooms', id: 'rm-1', $pivot: { boards: ['none'] } }])",
      '  const notices = await api.notices.list()',
      "  const regions: readonly ('eu' | 'us')[] | undefined = notices.$meta.regions",
      "  const notice = await api.notices.get('n-1')",
      '  const loose: readonly unknown[] | undefined = notice.$document.meta.loose',
      '  void [states, jobLanes, sides, boards, outcomes, regions, loose]',
      '}',
    ]
    const source = emit(doc, buildDescriptor(doc))
    expect(typecheck(`${source}\n${probes.join('\n')}\n`)).toEqual([])
  })
})
