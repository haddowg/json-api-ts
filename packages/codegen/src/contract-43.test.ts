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
import { baselineWithClosedPivots, withTypedRequestMeta } from '../test/typed-request-meta'

const load = (
  name: 'contract-witness.json' | 'contract-witness-baseline.json' | 'music-catalog.openapi.json',
) => JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument
const witness = load('contract-witness.json')
const typed = withTypedRequestMeta(witness)
const baseline = load('contract-witness-baseline.json')
const closedBaseline = baselineWithClosedPivots(baseline)

const scratch = mkdtempSync(join(tmpdir(), 'json-api-typed-request-meta-'))
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

const IDEMPOTENCY = { fields: { idempotencyKey: 'string' } }
const REASON = { fields: { reason: 'string' }, required: [] }
const CANCELLATION = { fields: { cancellationReason: 'string' } }
const CHANGED_BY = {
  fields: { changedBy: 'string' },
  required: [],
  additional: { format: 'unknown' },
}

/**
 * A write declaring its request `meta` takes a request document of its own marked `x-request-meta`,
 * a type declaring its resource objects' `meta` gets components marked `x-resource-meta`, and every
 * declared `meta` object says whether it is open. The codegen records each in the descriptor.
 */
describe('generator contract 43 (typed request and resource object meta)', () => {
  it('reads a document stamped 43 without a warning, and warns past it', () => {
    expect(MAXIMUM_CONTRACT).toBe(43)
    expect(typed.info?.['x-generator']?.contract).toBe(43)
    expect(checkContract(typed)).toBeUndefined()
    expect(checkContract(closedBaseline)).toBeUndefined()
    const newer = { ...typed, info: { ...typed.info!, 'x-generator': { contract: 44 } } }
    expect(checkContract(newer as OpenApiDocument)).toContain('reads up to 43')
  })

  it('records the meta each write takes, alone and inside an atomic batch', () => {
    const bookings = buildDescriptor(typed)['bookings']!
    expect(bookings.requestMeta).toEqual({
      create: IDEMPOTENCY,
      update: REASON,
      delete: CANCELLATION,
    })
    expect(bookings.atomicRequestMeta).toEqual({
      create: IDEMPOTENCY,
      update: REASON,
      delete: CANCELLATION,
    })
    // The create and update still answer at their paths through the narrowed request documents.
    expect(bookings.paths).toMatchObject({ create: '/bookings', update: '/bookings/{id}' })
  })

  it("records a type's resource object meta in each direction, open or closed", () => {
    const descriptor = buildDescriptor(typed)
    expect(descriptor['bookings']!.resourceMeta).toEqual({
      read: {
        fields: { heldUntil: 'date-time', nights: 'integer' },
        required: [],
        nullable: ['heldUntil', 'nights'],
        additional: { format: 'string', nullable: true },
      },
      create: { fields: { source: 'string' }, required: [], additional: { format: 'string' } },
      update: { fields: { source: 'string' }, required: [], additional: { format: 'string' } },
    })
    // A pivot target keeps the pivot its related endpoints render; its writes take no member.
    expect(descriptor['rooms']!.resourceMeta).toEqual({
      read: { fields: { floor: 'integer', pivot: 'object' }, required: [], nullable: ['floor'] },
      create: { fields: {} },
      update: { fields: {} },
    })
    expect(descriptor['rooms']!.requestMeta).toBeUndefined()
    expect(descriptor['rooms']!.atomicRequestMeta).toBeUndefined()
  })

  it('reads the pivot an identifier meta lists among its own members, and its closure', () => {
    const descriptor = buildDescriptor(typed)
    const rooms = descriptor['bookings']!.relations['rooms']!
    expect(rooms.pivot).toBe(true)
    expect(rooms.readPivot).toEqual({
      fields: { nights: 'integer' },
      nullable: ['nights'],
      additional: { format: 'string', nullable: true },
    })
    expect(rooms.writePivot).toEqual({
      fields: { nights: 'integer' },
      required: [],
      additional: { format: 'string' },
    })
    expect(rooms.identifierMeta).toEqual({
      fields: { view: 'string' },
      nullable: ['view'],
      additional: { format: 'unknown' },
    })
    const tags = descriptor['articles']!.relations['tags']!
    expect(tags.pivot).toBe(true)
    expect(tags.identifierMeta).toEqual({
      fields: { addedVia: 'string' },
      nullable: ['addedVia'],
      additional: false,
    })
    expect(descriptor['articles']!.relations['author']!.identifierMeta?.additional).toBe(false)
  })

  it("records each relationship write's meta and the meta-only answer it declares", () => {
    const rooms = buildDescriptor(typed)['bookings']!.relations['rooms']!
    expect(rooms.requestMeta).toEqual({ add: CHANGED_BY, remove: CHANGED_BY, replace: CHANGED_BY })
    expect(rooms.mutationMeta).toEqual({ add: { fields: { moved: 'integer' } } })
    const guest = buildDescriptor(typed)['bookings']!.relations['guest']!
    expect(guest.requestMeta).toBeUndefined()
    expect(guest.mutationMeta).toBeUndefined()
  })

  it("records an action's request meta, and a meta-only request as no input", () => {
    const actions = buildDescriptor(typed)['bookings']!.actions!
    expect(actions['confirm']).toMatchObject({
      input: 'none',
      requestMeta: { fields: { silent: 'boolean' }, required: [] },
    })
    expect(actions['confirmPatch']?.requestMeta).toBeUndefined()
    expect(actions['quote']).toMatchObject({
      input: 'document',
      inputType: 'bookings',
      requestMeta: { fields: { currency: 'string' } },
    })
  })

  it('reads the job type and meta of an accepted document', () => {
    const bookings = buildDescriptor(typed)['bookings']!
    const accepted = {
      jobType: 'jobs',
      meta: { fields: { queuePosition: 'integer' }, required: [], nullable: ['queuePosition'] },
    }
    expect(bookings.accepted).toEqual({ create: accepted })
    expect(bookings.actions?.['confirm']?.accepted).toEqual(accepted)
    expect(bookings.actions?.['confirmPatch']?.accepted).toEqual(accepted)
  })

  it('leaves every type the graft does not add as it was, but for the closed identifier meta', () => {
    const before = buildDescriptor(withFieldSelection(witness))
    const after = buildDescriptor(typed)
    for (const [type, descriptor] of Object.entries(before)) {
      const relations = Object.fromEntries(
        Object.entries(after[type]!.relations).map(([name, relation]) => {
          const { identifierMeta, ...rest } = relation
          if (identifierMeta === undefined) {
            return [name, relation]
          }
          const { additional, ...open } = identifierMeta
          expect(additional).toBe(false)
          return [name, { ...rest, identifierMeta: open }]
        }),
      )
      expect({ ...after[type], relations }).toEqual(descriptor)
    }
    expect(Object.keys(after).filter((type) => !(type in before))).toEqual([
      'bookings',
      'jobs',
      'rooms',
    ])
  })

  it('reads the baseline with its pivots closed as it read it before', () => {
    expect(closedBaseline.info?.['x-generator']?.contract).toBe(43)
    expect(buildDescriptor(closedBaseline)).toEqual(buildDescriptor(baseline))
  })

  it('records no request or resource meta where no document declares any', () => {
    for (const doc of [witness, baseline, load('music-catalog.openapi.json')]) {
      for (const descriptor of Object.values(buildDescriptor(doc))) {
        expect(descriptor.requestMeta).toBeUndefined()
        expect(descriptor.atomicRequestMeta).toBeUndefined()
        expect(descriptor.resourceMeta).toBeUndefined()
        for (const relation of Object.values(descriptor.relations)) {
          expect(relation.requestMeta).toBeUndefined()
          expect(relation.mutationMeta).toBeUndefined()
          expect(relation.identifierMeta?.additional).toBeUndefined()
        }
      }
    }
  })

  it('documents each declared member on its descriptor entry', () => {
    const source = emit(typed, buildDescriptor(typed))
    for (const entry of [
      '          /**\n           * @minLength 1\n           * @example k-1\n           */\n          idempotencyKey: "string"',
      '          /** @example web */\n          source: "string"',
      '              /** @example desk */\n              changedBy: "string"',
      '              /** @example 1 */\n              moved: "integer"',
      '            /** @example true */\n            silent: "boolean"',
    ]) {
      expect(source).toContain(entry)
    }
  })

  it('compiles to a client that types every declared meta', () => {
    const probes = [
      "const api = createClient({ baseUrl: 'https://api.example' })",
      'export async function probe(): Promise<void> {',
      "  const created = await api.bookings.create({ title: 'Weekend', $meta: { source: 'web', extra: 'x' } }, { meta: { idempotencyKey: 'k-1' } })",
      "  if ('$meta' in created) {",
      '    const nights: number | null | undefined = created.$meta?.nights',
      '    const held: string | null | undefined = created.$meta?.heldUntil',
      "    const other: string | number | null | undefined = created.$meta?.['other']",
      '    void [nights, held, other]',
      '  } else {',
      '    const position: number | null | undefined = created.meta?.queuePosition',
      '    void position',
      '  }',
      '  // @ts-expect-error -- the create must send its idempotency key.',
      "  await api.bookings.create({ title: 'Weekend' })",
      '  // @ts-expect-error -- the create declares no such member.',
      "  await api.bookings.create({ title: 'Weekend' }, { meta: { idempotencyKey: 'k', other: 1 } })",
      '  // @ts-expect-error -- undeclared resource meta members are strings.',
      "  await api.bookings.create({ title: 'W', $meta: { extra: 1 } }, { meta: { idempotencyKey: 'k' } })",
      "  await api.bookings.id('bk-1').update({ title: 'Weekend' })",
      "  await api.bookings.id('bk-1').update({ title: 'Weekend' }, { meta: { reason: 'late' } })",
      "  await api.bookings.id('bk-1').delete({ meta: { cancellationReason: 'ill' } })",
      '  // @ts-expect-error -- the delete must send its reason.',
      "  await api.bookings.id('bk-1').delete()",
      "  await api.rooms.id('rm-1').delete()",
      '  // @ts-expect-error -- a delete declaring no meta takes no body.',
      "  await api.rooms.id('rm-1').delete({ meta: {} })",
      "  const room = await api.rooms.get('rm-1')",
      '  const floor: number | null | undefined = room.$meta?.floor',
      '  // @ts-expect-error -- a room renders no such member.',
      "  void room.$meta?.['other']",
      '  // @ts-expect-error -- a room write takes no resource meta member.',
      '  await api.rooms.create({ $meta: { floor: 1 } })',
      "  const moved: number = (await api.bookings.id('bk-1').rooms.add([{ type: 'rooms', id: 'rm-1', $pivot: { nights: 2, label: 'x' } }], { meta: { changedBy: 'desk', anything: 1 } })).moved",
      "  const linkage = await api.bookings.id('bk-1').rooms.remove([{ type: 'rooms', id: 'rm-1' }])",
      "  await api.bookings.id('bk-1').guest.set({ type: 'rooms', id: 'rm-1' })",
      "  const members = await api.bookings.id('bk-1').rooms.get()",
      '  const view: string | null | undefined = members[0]?.$edge?.meta?.view',
      '  const pivotNights: number | null | undefined = members[0]?.$edge?.meta?.pivot?.nights',
      "  const extra: unknown = members[0]?.$edge?.meta?.['anything']",
      "  const tags = await api.articles.id('a-1').tags.get()",
      '  const addedVia: string | null | undefined = tags[0]?.$edge?.meta?.addedVia',
      '  const tagPosition: number | undefined = tags[0]?.$edge?.meta?.pivot?.position',
      '  // @ts-expect-error -- the tags identifier meta is closed.',
      "  void tags[0]?.$edge?.meta?.['other']",
      "  const confirmed = await api.bookings.id('bk-1').actions.confirm({ meta: { silent: true } })",
      "  await api.bookings.id('bk-1').actions.confirm()",
      '  // @ts-expect-error -- confirm declares no such member.',
      "  await api.bookings.id('bk-1').actions.confirm({ meta: { loud: true } })",
      "  await api.bookings.actions.quote({ title: 'Weekend' }, { meta: { currency: 'EUR' } })",
      '  // @ts-expect-error -- the quote must send its currency.',
      "  await api.bookings.actions.quote({ title: 'Weekend' })",
      '  const results = await api.atomic((tx) => [',
      "    tx.create({ type: 'bookings', title: 'Weekend', $meta: { source: 'import' } }, { meta: { idempotencyKey: 'k-2' } }),",
      "    tx.delete({ type: 'bookings', id: 'bk-1' }, { meta: { cancellationReason: 'ill' } }),",
      "    tx.create({ type: 'rooms' }),",
      '  ])',
      '  // @ts-expect-error -- an atomic add of a booking must send its idempotency key.',
      "  await api.atomic((tx) => [tx.create({ type: 'bookings', title: 'Weekend' })])",
      '  void [floor, moved, linkage, view, pivotNights, extra, addedVia, tagPosition, confirmed, results]',
      '}',
    ]
    const source = emit(typed, buildDescriptor(typed))
    expect(typecheck(`${source}\n${probes.join('\n')}\n`)).toEqual([])
  })
})
