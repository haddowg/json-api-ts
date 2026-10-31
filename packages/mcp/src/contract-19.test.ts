import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { OpenApiDocument } from './openapi'
import { toPortable } from './portable'
import { fixture } from './test-fixtures'

const doc: OpenApiDocument = {
  components: {
    schemas: {
      PeopleResourceIdentifier: {
        type: 'object',
        properties: { type: { type: 'string', const: 'people' }, id: { type: 'string' } },
        required: ['type', 'id'],
      },
      RobotsResourceIdentifier: {
        type: 'object',
        properties: { type: { type: 'string', const: 'robots' }, id: { type: 'string' } },
        required: ['type', 'id'],
      },
    },
  },
}

const union = (...types: string[]) => ({
  oneOf: types.map((type) => ({ $ref: `#/components/schemas/${type}ResourceIdentifier` })),
  discriminator: {
    propertyName: 'type',
    mapping: Object.fromEntries(
      types.map((type) => [type.toLowerCase(), `#/components/schemas/${type}ResourceIdentifier`]),
    ),
  },
})

describe('generator contract 19 (discriminated unions)', () => {
  const mcp = createJsonApiMcp(fixture('contract-witness'))

  it('reads the witness', () => {
    expect(mcp.contract).toBe(19)
  })

  it('keeps the type discriminator out of every tool schema', () => {
    for (const tool of mcp.tools) {
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain('"discriminator"')
      const schemas = JSON.stringify([tool.inputSchema, tool.outputSchema])
      expect(schemas, tool.name).not.toContain('"discriminator":{"propertyName":"type"')
    }
  })

  it('converts a discriminated union to a portable anyOf of its members', () => {
    const { schema } = toPortable(doc, union('People', 'Robots'))
    expect(JSON.stringify(schema)).not.toContain('discriminator')
    expect(schema['anyOf']).toHaveLength(2)
  })

  it('converts a one-member union to its member, and a nullable one admits null', () => {
    const single = toPortable(doc, union('People')).schema
    expect(single['type']).toBe('object')
    expect(single).not.toHaveProperty('discriminator')

    const nullable = toPortable(doc, { anyOf: [union('People'), { type: 'null' }] }).schema
    expect(JSON.stringify(nullable)).not.toContain('discriminator')
    expect(JSON.stringify(nullable)).toContain('"null"')
  })
})
