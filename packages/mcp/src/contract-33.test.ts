import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { OpenApiDocument } from './openapi'
import { modelOf, source } from './test-fixtures'

/** The witness with every error response swapped for a bare one naming no document. */
function withoutErrorDocuments(document: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(document) as {
    paths?: Record<string, Record<string, { responses?: Record<string, unknown> }>>
  }
  for (const item of Object.values(copy.paths ?? {})) {
    for (const operation of Object.values(item)) {
      for (const status of Object.keys(operation.responses ?? {})) {
        if (Number(status) >= 400) {
          operation.responses![status] = { description: 'An error.' }
        }
      }
    }
  }
  return copy as OpenApiDocument
}

/**
 * Core's witness answers each operation raising scoped codes with an inline error response and an
 * error document named for the operation, such as `ArticlesUpdate409`. A tool is built from the
 * operation's parameters, request body and success responses, so its error responses change
 * nothing.
 */
describe('generator contract 33 (error documents named for the operation)', () => {
  const { document, descriptor } = source('contract-witness')
  const mcp = createJsonApiMcp(modelOf(document, descriptor))

  it('reads the witness', () => {
    expect(document.info?.['x-generator']?.contract).toBe(34)
    expect(mcp.contract).toBe(34)
  })

  it('builds the same tools without the error documents', () => {
    const bare = createJsonApiMcp(modelOf(withoutErrorDocuments(document), descriptor))
    expect(mcp.tools).toEqual(bare.tools)
  })

  it('names no error document in any tool schema', () => {
    for (const { inputSchema, outputSchema } of mcp.tools) {
      const text = JSON.stringify([inputSchema, outputSchema ?? {}])
      expect(text).not.toMatch(/ArticlesUpdate409|AtomicOperations409|ErrorDocument/)
    }
  })
})
