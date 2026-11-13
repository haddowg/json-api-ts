import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkContract } from './contract'
import { readErrorCatalogue } from './error-codes'
import type { OpenApiDocument } from './openapi'
import { documentPath, type DocumentName } from '../test/documents'

const read = (name: DocumentName): OpenApiDocument =>
  JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument

const witness = read('contract-witness.json')
const catalog = read('music-catalog.openapi.json')
const admin = read('music-catalog-admin.openapi.json')

type Json = Record<string, unknown>

/**
 * What each document says about its error codes, worked out straight from the JSON rather than
 * through the reader: every error response's document and that document's codes.
 */
function oracle(doc: OpenApiDocument) {
  const schemas = (doc.components?.schemas ?? {}) as Record<string, Json>
  const responses = (doc.components?.responses ?? {}) as Record<string, Json>
  const tail = (ref: unknown) => String(ref).split('/').pop()!
  const shapeCodes = (name: string): string[] => {
    const shape = schemas[name] ?? {}
    return [shape, ...((shape['allOf'] as Json[] | undefined) ?? [])].flatMap((layer) => {
      const code = (layer['properties'] as Record<string, Json> | undefined)?.['code']
      return ((code?.['anyOf'] as Json[] | undefined) ?? []).map((b) => b['const'] as string)
    })
  }
  const documentCodes = (name: string): string[] => {
    const errors = (schemas[name]?.['properties'] as Record<string, Json> | undefined)?.['errors']
    const branches = ((errors?.['items'] as Json | undefined)?.['anyOf'] as Json[]) ?? []
    return branches.flatMap((branch) => shapeCodes(tail(branch['$ref'])))
  }
  const answers: { operationId: string; status: number; document: string }[] = []
  for (const item of Object.values(doc.paths ?? {})) {
    for (const op of Object.values(item as Record<string, Json>)) {
      for (const [status, raw] of Object.entries((op['responses'] as Record<string, Json>) ?? {})) {
        if (Number(status) < 400) continue
        const response = raw['$ref'] === undefined ? raw : responses[tail(raw['$ref'])]
        const content = response?.['content'] as Record<string, Json> | undefined
        const schema = content?.['application/vnd.api+json']?.['schema'] as Json | undefined
        if (schema?.['$ref'] !== undefined) {
          answers.push({
            operationId: op['operationId'] as string,
            status: Number(status),
            document: tail(schema['$ref']),
          })
        }
      }
    }
  }
  const shared = (status: number) => new Set(documentCodes(`ErrorDocument${status}`))
  const byStatus = new Map<number, Set<string>>()
  const byOperation = new Map<string, Set<string>>()
  for (const { operationId, status, document } of answers) {
    const codes = documentCodes(document)
    byStatus.set(status, new Set([...(byStatus.get(status) ?? []), ...codes]))
    if (/^ErrorDocument\d*$/.test(document)) continue
    const scoped = byOperation.get(operationId) ?? new Set<string>()
    for (const code of codes) {
      if (!shared(status).has(code)) scoped.add(code)
    }
    byOperation.set(operationId, scoped)
  }
  const every = new Set([
    ...documentCodes('ErrorDocument'),
    ...[...byStatus.values()].flatMap((codes) => [...codes]),
  ])
  return { schemas, responses, answers, documentCodes, byStatus, byOperation, every }
}

// oxlint-disable-next-line no-array-sort -- sorting a freshly-created array
const sorted = (codes: Iterable<string>) => [...codes].sort()

/**
 * Core offers each of its error codes only on the operations whose runtime raises it, narrowed
 * by facts from the resource definitions and the adapters, and checks `include` on relationship
 * endpoints. The adapters catalogue `VALIDATION_FAILED` and the `ATOMIC_*` codes. Most operations
 * now answer 400, 403, 404, 409 and 422 with a document of their own, the shared 403, 404 and 422
 * documents offer no specific code, and a server where no operation answers a status from the
 * shared responses has no shared component for it.
 */
describe('generator contract 36 (error codes offered where the runtime raises them)', () => {
  it('reads the witness and both catalog servers without a warning', () => {
    for (const doc of [witness, catalog, admin]) {
      expect(doc.info?.['x-generator']?.contract).toBe(38)
      expect(checkContract(doc)).toBeUndefined()
    }
  })

  it.each([
    ['contract witness', witness],
    ['music catalog', catalog],
    ['music catalog admin', admin],
  ])('reads the %s catalogue exactly as its documents state it', (_, doc) => {
    const expected = oracle(doc)
    const catalogue = readErrorCatalogue(doc)
    expect(catalogue.codes.map((entry) => entry.code)).toEqual(sorted(expected.every))
    expect([...catalogue.byStatus]).toEqual(
      // oxlint-disable-next-line no-array-sort -- sorting a freshly-created array
      [...expected.byStatus].sort(([a], [b]) => a - b).map(([s, codes]) => [s, sorted(codes)]),
    )
    expect(Object.fromEntries(catalogue.byOperation)).toEqual(
      Object.fromEntries([...expected.byOperation].map(([id, codes]) => [id, sorted(codes)])),
    )
  })

  it('names the 404 shapes for their codes and keeps the parameter codes out of Error400Parameter', () => {
    const { schemas, documentCodes } = oracle(witness)
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining(['Error404ResourceNotFound', 'Error404RelationshipNotExists']),
    )
    expect(Object.keys(schemas)).not.toContain('Error404')
    expect(documentCodes('ErrorDocument404')).toEqual([])
    expect(documentCodes('ErrorDocument403')).toEqual([])
    expect(documentCodes('ErrorDocument422')).toEqual([])
    const catalogue = readErrorCatalogue(witness)
    expect(catalogue.byStatus.get(404)).toEqual(['RELATIONSHIP_NOT_EXISTS', 'RESOURCE_NOT_FOUND'])
    expect(catalogue.byStatus.get(400)).toEqual(
      expect.arrayContaining([
        'SORTING_UNRECOGNIZED',
        'FILTERING_UNRECOGNIZED',
        'INCLUSION_UNRECOGNIZED',
      ]),
    )
  })

  it('offers the parameter codes only on the operations that read the parameter', () => {
    const catalogue = readErrorCatalogue(witness)
    expect(catalogue.byOperation.get('delete.articles')).toEqual([
      'ARTICLE_LOCKED',
      'INSUFFICIENT_SCOPE',
      'RESOURCE_NOT_FOUND',
    ])
    expect(catalogue.byOperation.get('fetchOne.articles')).toEqual(
      expect.arrayContaining([
        'RESOURCE_NOT_FOUND',
        'SORTING_UNRECOGNIZED',
        'INCLUSION_UNRECOGNIZED',
      ]),
    )
    // A relationship endpoint checks include from the parent, mutations echoing linkage too.
    expect(catalogue.byOperation.get('fetchRelationship.articles.author')).toContain(
      'INCLUSION_UNRECOGNIZED',
    )
    expect(catalogue.byOperation.get('addRelationship.articles.tags')).toContain(
      'INCLUSION_UNRECOGNIZED',
    )
  })

  it('reads a status whose codes live only in operation documents on a server with no shared component for it', () => {
    const schemas = Object.keys(admin.components?.schemas ?? {})
    const responses = Object.keys(admin.components?.responses ?? {})
    expect(schemas).not.toContain('ErrorDocument404')
    expect(schemas).not.toContain('ErrorDocument422')
    expect(responses).not.toContain('NotFound')
    expect(responses).not.toContain('UnprocessableEntity')
    const catalogue = readErrorCatalogue(admin)
    expect(catalogue.byStatus.get(404)).toEqual([
      'ATOMIC_TARGET_TYPE_UNKNOWN',
      'RELATIONSHIP_NOT_EXISTS',
      'RESOURCE_NOT_FOUND',
    ])
    expect(catalogue.byStatus.get(422)).toEqual([
      'ASYNC_WRITE_IN_ATOMIC_OPERATION',
      'ATTRIBUTE_VALUE_INVALID',
      'VALIDATION_FAILED',
    ])
    expect(catalogue.byOperation.get('fetchOne.albums')).toContain('RESOURCE_NOT_FOUND')
  })

  it('still reads every code when no shared document or response is left', () => {
    const schemas = Object.fromEntries(
      Object.entries(witness.components?.schemas ?? {}).filter(
        ([name]) => !/^ErrorDocument\d{3}$/.test(name),
      ),
    )
    const stripped: OpenApiDocument = {
      ...witness,
      components: { ...witness.components, schemas, responses: {} },
    }
    const full = readErrorCatalogue(witness)
    const catalogue = readErrorCatalogue(stripped)
    expect(catalogue.codes.map((entry) => entry.code)).toEqual(
      full.codes.map((entry) => entry.code),
    )
    expect(catalogue.byOperation.get('delete.articles')).toEqual(
      full.byOperation.get('delete.articles'),
    )
    expect(catalogue.byStatus.get(401)).toBeUndefined()
  })

  it('catalogues the codes the adapters raise', () => {
    const catalogue = readErrorCatalogue(catalog)
    const codes = catalogue.codes.map((entry) => entry.code)
    const adapter = [
      'ASYNC_WRITE_IN_ATOMIC_OPERATION',
      'ATOMIC_HREF_INVALID',
      'ATOMIC_HREF_UNRESOLVABLE',
      'ATOMIC_OPERATIONS_NOT_SUPPORTED',
      'ATOMIC_OPERATIONS_UNAVAILABLE',
      'ATOMIC_OPERATION_NOT_EXPOSED',
      'ATOMIC_TARGET_TYPE_UNKNOWN',
      'VALIDATION_FAILED',
    ]
    expect(codes).toEqual(expect.arrayContaining(adapter))
    expect(catalogue.byOperation.get('atomic.operations')).toEqual(expect.arrayContaining(adapter))
    expect(catalogue.byOperation.get('create.albums')).toContain('VALIDATION_FAILED')
    expect(catalogue.byOperation.get('fetchOne.albums')).not.toContain('VALIDATION_FAILED')
  })
})
