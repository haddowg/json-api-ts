import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { OpenApiDocument } from './openapi'
import { documentPath, modelOf } from './test-fixtures'

const text = readFileSync(documentPath('contract-witness'), 'utf8')

/**
 * The witness as a server writes it once whole floats keep their fraction: the articles' `rating`
 * bounds read `0.0` and `10.0`, and the `reading` union's bound reads `1.0`.
 */
const withFractions = text
  .replaceAll('"exclusiveMinimum": 0,', '"exclusiveMinimum": 0.0,')
  .replaceAll(/"exclusiveMaximum": 10(\s)/g, '"exclusiveMaximum": 10.0$1')
  .replaceAll(/"maximum": 1(\s)/g, '"maximum": 1.0$1')

describe('a document whose whole floats keep their fraction', () => {
  it('builds the same tools', () => {
    expect(withFractions).not.toBe(text)
    const tools = (json: string) =>
      createJsonApiMcp(modelOf(JSON.parse(json) as OpenApiDocument)).tools
    expect(tools(withFractions)).toEqual(tools(text))
  })
})
