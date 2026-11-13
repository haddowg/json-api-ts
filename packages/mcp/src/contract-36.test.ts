import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import { fixture, source } from './test-fixtures'

/**
 * Core's witness and the music catalog offer each error code only on the operations that raise
 * it, so most operations answer their error statuses with a document of their own and some shared
 * error responses are gone. A tool is built from an operation's success responses, so its error
 * documents never reach the tools.
 */
describe('generator contract 36 (error codes offered where the runtime raises them)', () => {
  it.each(['contract-witness', 'music-catalog'] as const)('reads the %s document', (name) => {
    expect(source(name).document.info?.['x-generator']?.contract).toBe(37)
    expect(createJsonApiMcp(fixture(name)).contract).toBe(37)
  })

  it('builds the same tools whichever error documents an operation answers with', () => {
    const { document } = source('contract-witness')
    expect(Object.keys(document.components?.schemas ?? {})).toContain('ArticlesFetchOne404')
    const tools = createJsonApiMcp(fixture('contract-witness')).tools.map((t) => t.name)
    expect(tools).toEqual(expect.arrayContaining(['articles_get', 'articles_list']))
  })
})
