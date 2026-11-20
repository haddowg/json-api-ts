import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import { AjvValidationError, createAjvValidator } from './ajv'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import type { TransportRequest, TransportResponse } from './transport'
import { type SchemaMap, sparseSchema, type Validator, type WireResource } from './validate'

const BASE = 'https://api.example'

const descriptor = {
  products: {
    attributes: { name: 'string', totals: 'object', lines: 'array', values: 'object' },
    relations: {
      maker: { cardinality: 'one', types: ['makers'], pivot: false },
    },
    paths: { fetchMany: '/products', fetchOne: '/products/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
    includable: ['maker'],
    selectableKeys: { totals: '[^.,]+', lines: '\\*', values: '[a-z]+' },
    selectableKeyPaths: {
      totals: [['geo', '(?:lat|lng)']],
      lines: [
        ['\\*', '(?:sku|qty|price)'],
        ['\\*', 'price', '(?:amount|currency)'],
      ],
    },
  },
  makers: {
    attributes: { name: 'string', country: 'string' },
    relations: {},
    paths: { fetchOne: '/makers/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

const price = {
  type: ['object', 'null'],
  properties: { amount: { type: 'number' }, currency: { type: 'string' } },
  required: ['amount', 'currency'],
  additionalProperties: false,
}

/** Every member required, as the server's per-type schemas mark them. */
const schemas: SchemaMap = {
  products: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:jsonapi:schema:products',
    type: 'object',
    properties: {
      type: { type: 'string', const: 'products' },
      id: { type: 'string' },
      attributes: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          totals: {
            type: 'object',
            properties: {
              views: { type: 'integer' },
              shares: { type: 'integer' },
              geo: { $ref: '#/$defs/geo' },
            },
            required: ['views', 'shares', 'geo'],
            additionalProperties: false,
          },
          lines: {
            type: ['array', 'null'],
            items: {
              type: 'object',
              properties: { sku: { type: 'string' }, qty: { type: 'integer' }, price },
              required: ['sku', 'qty', 'price'],
              additionalProperties: false,
            },
          },
          values: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: { cap: { type: 'integer' }, floor: { type: 'integer' } },
              required: ['cap', 'floor'],
            },
          },
        },
        required: ['name', 'totals', 'lines', 'values'],
        additionalProperties: false,
      },
      relationships: {
        type: 'object',
        properties: { maker: { type: 'object' } },
        required: ['maker'],
      },
    },
    required: ['type', 'id', 'attributes', 'relationships'],
    $defs: {
      geo: {
        anyOf: [
          {
            type: 'object',
            properties: { lat: { type: 'number' }, lng: { type: 'number' } },
            required: ['lat', 'lng'],
          },
          { type: 'null' },
        ],
      },
    },
  },
  makers: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:jsonapi:schema:makers',
    type: 'object',
    properties: {
      type: { type: 'string', const: 'makers' },
      id: { type: 'string' },
      attributes: {
        type: 'object',
        properties: { name: { type: 'string' }, country: { type: 'string' } },
        required: ['name', 'country'],
        additionalProperties: false,
      },
    },
    required: ['type', 'id'],
  },
}

const whole = {
  type: 'products',
  id: 'p-1',
  attributes: {
    name: 'Widget',
    totals: { views: 3, shares: 1, geo: { lat: 51.5, lng: -0.1 } },
    lines: [{ sku: 'a-1', qty: 2, price: { amount: 9.5, currency: 'GBP' } }],
    values: { eur: { cap: 3, floor: 1 } },
  },
  relationships: { maker: { data: { type: 'makers', id: 'm-1' } } },
}

const answering =
  (body: unknown): ((req: TransportRequest) => Promise<TransportResponse>) =>
  async () => ({ status: 200, headers: {}, body: JSON.stringify(body) })

/** A client validating with ajv, as the adapter or as the schema-driven config form. */
function clientFor(body: unknown, form: 'adapter' | 'config') {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const validate =
    form === 'adapter'
      ? createAjvValidator(ajv, schemas)
      : {
          schemas,
          validator: ((resource: WireResource, schema: unknown) => {
            const { type, id } = resource
            if (!ajv.validate(schema as object, resource)) {
              throw new AjvValidationError(type, id, [])
            }
          }) satisfies Validator,
        }
  return createClient(descriptor, { baseUrl: BASE, transport: answering(body), validate })
}

const read = (body: unknown, form: 'adapter' | 'config', fields?: Record<string, string[]>) =>
  clientFor(body, form).products.get('p-1', {
    include: ['maker'],
    ...(fields === undefined ? {} : { fields }),
  } as never)

const sparse = (attributes: Record<string, unknown>) => ({
  data: { type: 'products', id: 'p-1', attributes },
})

describe.each(['adapter', 'config'] as const)('validating a sparse read (%s)', (form) => {
  it('checks a whole read against every required member', async () => {
    await expect(read({ data: whole }, form)).resolves.toBeDefined()
    await expect(read(sparse({ name: 'Widget' }), form)).rejects.toThrow(AjvValidationError)
  })

  it('lets a sparse read leave out the members its fieldset omits', async () => {
    await expect(read(sparse({ name: 'Widget' }), form, { products: ['name'] })).resolves.toEqual(
      expect.objectContaining({ name: 'Widget' }),
    )
    // An empty fieldset renders no attributes or relationships at all.
    await expect(
      read({ data: { type: 'products', id: 'p-1' } }, form, { products: [] }),
    ).resolves.toBeDefined()
  })

  it('still checks the members a sparse read selects', async () => {
    await expect(read(sparse({ name: 7 }), form, { products: ['name'] })).rejects.toThrow(
      AjvValidationError,
    )
    await expect(
      read(sparse({ totals: { views: 3 } }), form, { products: ['name', 'totals'] }),
    ).rejects.toThrow(AjvValidationError)
  })

  it('relaxes a nested selection along its key path only', async () => {
    const fields = { products: ['totals.geo.lat'] }
    await expect(read(sparse({ totals: { geo: { lat: 51.5 } } }), form, fields)).resolves.toEqual(
      expect.objectContaining({ totals: { geo: { lat: 51.5 } } }),
    )
    // A selected key is still required and still typed.
    await expect(read(sparse({ totals: {} }), form, fields)).rejects.toThrow(AjvValidationError)
    await expect(read(sparse({ totals: { geo: { lat: 'north' } } }), form, fields)).rejects.toThrow(
      AjvValidationError,
    )
    // A key the fieldset also lists whole is rendered whole, so it is checked whole.
    await expect(
      read(sparse({ totals: { views: 3 } }), form, { products: ['totals', 'totals.views'] }),
    ).rejects.toThrow(AjvValidationError)
  })

  it('relaxes every item of a list a wildcard path selects', async () => {
    const fields = { products: ['lines.*.sku', 'lines.*.price.amount'] }
    await expect(
      read(
        sparse({
          lines: [
            { sku: 'a-1', price: { amount: 9.5 } },
            { sku: 'b-2', price: null },
          ],
        }),
        form,
        fields,
      ),
    ).resolves.toBeDefined()
    await expect(read(sparse({ lines: [{ price: null }] }), form, fields)).rejects.toThrow(
      AjvValidationError,
    )
    // `lines.*` alone selects each item whole.
    await expect(
      read(sparse({ lines: [{ sku: 'a-1' }] }), form, { products: ['lines.*'] }),
    ).rejects.toThrow(AjvValidationError)
  })

  it('relaxes a map value a pattern key selects', async () => {
    await expect(
      read(sparse({ values: { eur: { cap: 3 } } }), form, { products: ['values.eur.cap'] }),
    ).resolves.toBeDefined()
  })

  it('relaxes an included resource by its own type’s fieldset', async () => {
    const body = {
      data: whole,
      included: [{ type: 'makers', id: 'm-1', attributes: { name: 'Acme' } }],
    }
    await expect(read(body, form)).rejects.toThrow(AjvValidationError)
    await expect(read(body, form, { makers: ['name'] })).resolves.toBeDefined()
  })
})

const attributes = (schema: unknown) =>
  (schema as { properties: { attributes: Record<string, unknown> } }).properties.attributes

describe('sparseSchema', () => {
  it('keeps only the selected members required, and the resource needs neither member object', () => {
    const out = sparseSchema(schemas['products'], ['name', 'maker']) as Record<string, unknown>
    expect(out['required']).toEqual(['type', 'id'])
    expect(attributes(out)['required']).toEqual(['name'])
    expect(
      (out['properties'] as { relationships: Record<string, unknown> }).relationships['required'],
    ).toEqual(['maker'])
  })

  it('drops the $id, as the copy is a schema of its own', () => {
    expect(sparseSchema(schemas['products'], ['name'])).not.toHaveProperty('$id')
  })

  it('leaves the schema it was given unchanged', () => {
    const before = JSON.stringify(schemas['products'])
    sparseSchema(schemas['products'], ['lines.*.sku', 'totals.geo.lat'])
    expect(JSON.stringify(schemas['products'])).toBe(before)
  })

  it('narrows a nested path through a $ref and a list through its items', () => {
    const attrs = attributes(sparseSchema(schemas['products'], ['totals.geo.lat', 'lines.*.sku']))
    const props = attrs['properties'] as Record<string, Record<string, unknown>>
    expect(attrs['required']).toEqual(['totals', 'lines'])
    expect(props['totals']!['required']).toEqual(['geo'])
    expect(props['totals']!['properties']).toMatchObject({
      geo: { anyOf: [{ required: ['lat'] }, { type: 'null' }] },
    })
    expect(props['lines']!['items']).toMatchObject({ required: ['sku'] })
  })

  it('keeps a key of a shared map value required only when every selected key selects it', () => {
    const attrs = attributes(
      sparseSchema(schemas['products'], ['values.eur.cap', 'values.usd.cap', 'values.usd.floor']),
    )
    const values = (attrs['properties'] as Record<string, Record<string, unknown>>)['values']!
    expect(values['additionalProperties']).toMatchObject({ required: ['cap'] })
  })
})
