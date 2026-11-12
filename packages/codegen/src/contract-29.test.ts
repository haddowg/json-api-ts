import { readFileSync } from 'node:fs'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  ArticlesAttributes,
  ArticlesCreateAttributes,
  ArticlesUpdateAttributes,
} from '../test/generated/contract-witness.client.gen'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'

const witness = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument

type Row = { Key: string } & Record<string, string | null>

/** A one-type document whose `sheets` attributes are the given schemas. */
function sheets(properties: Record<string, unknown>): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'Sheets', version: '1.0.0', 'x-generator': { contract: 29 } },
    paths: {
      '/sheets/{id}': {
        get: {
          operationId: 'sheets.fetchOne',
          responses: {
            '200': {
              description: 'A sheet.',
              content: {
                'application/vnd.api+json': {
                  schema: {
                    type: 'object',
                    properties: { data: { $ref: '#/components/schemas/SheetsResource' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        SheetsResource: {
          type: 'object',
          required: ['type', 'id'],
          properties: {
            type: { const: 'sheets' },
            id: { type: 'string' },
            attributes: { $ref: '#/components/schemas/SheetsAttributes' },
          },
        },
        SheetsAttributes: { type: 'object', properties, additionalProperties: false },
      },
    },
  } as unknown as OpenApiDocument
}

/**
 * Core's witness declares objects open to members they do not declare: `labels` takes any
 * string, each `rows` element requires `Key` and takes any other header as a nullable string,
 * and `metrics` takes read-only integers, so its write schemas stay closed.
 */
describe('generator contract 29 (open objects)', () => {
  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(34)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('types an open object with no declared members as a record of its member type', () => {
    expectTypeOf<ArticlesAttributes['labels']>().toEqualTypeOf<Record<
      string,
      string | null
    > | null>()
    expectTypeOf<ArticlesCreateAttributes['labels']>().toEqualTypeOf<
      Record<string, string> | undefined
    >()
    expectTypeOf<ArticlesAttributes['metrics']>().toEqualTypeOf<Record<
      string,
      number | null
    > | null>()
  })

  it('intersects declared members with a record of the member type', () => {
    expectTypeOf<ArticlesCreateAttributes['rows']>().toEqualTypeOf<Row[] | undefined>()
    expectTypeOf<ArticlesUpdateAttributes['rows']>().toEqualTypeOf<Row[] | undefined>()
    const row: Row = { Key: 'RFP-123', Vendor: 'Acme Media', CPL: '42' }
    expect(row.Vendor).toBe('Acme Media')
  })

  it('emits the open types inline', () => {
    const source = emit(witness, buildDescriptor(witness))
    expect(source).toContain('  labels: Record<string, string | null> | null\n')
    expect(source).toContain('  rows?: ({ Key: string } & Record<string, string | null>)[]\n')
  })

  it('types a member schema the way it types an attribute', () => {
    const document = sheets({
      cells: {
        type: 'object',
        additionalProperties: { type: ['integer', 'null'], minimum: 0 },
      },
      tagged: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: {
          type: 'object',
          properties: { on: { type: 'boolean' } },
          additionalProperties: false,
        },
      },
      closed: {
        type: 'object',
        properties: { id: { type: 'string' } },
        additionalProperties: false,
      },
    })
    const source = emit(document, buildDescriptor(document))
    expect(source).toContain('  cells: Record<string, number | null>\n')
    expect(source).toContain('  tagged: { id: string } & Record<string, { on?: boolean }>\n')
    expect(source).toContain('  closed: { id?: string }\n')
  })
})
