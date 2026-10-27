import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDescriptor, hashJson } from '@haddowg/json-api-codegen'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main, parseArgs } from './cli'
import { generateMcpModel, serialiseMcpModel, writeMcpModel } from './generate'
import { createJsonApiMcp } from './mcp'
import { MODEL_FORMAT, MODEL_GENERATOR } from './model'
import { source } from './test-fixtures'

const spec = fileURLToPath(
  new URL('../../codegen/test/fixtures/music-catalog.openapi.json', import.meta.url),
)
const committed = fileURLToPath(
  new URL('../test/generated/music-catalog.mcp.gen.json', import.meta.url),
)

describe('generateMcpModel', () => {
  it('records the format, contract and source hash, and carries the descriptor', async () => {
    const { document } = source('music-catalog')
    const model = await generateMcpModel(document)
    expect(model.format).toBe(MODEL_FORMAT)
    expect(model.generator).toBe(MODEL_GENERATOR)
    expect(model.contract).toBe(18)
    expect(model.source.hash).toBe(hashJson(document))
    expect(model.baseUrl).toBe('https://music.example')
    expect(model.descriptor).toEqual(
      buildDescriptor(document as Parameters<typeof buildDescriptor>[0]),
    )
  })

  it('keeps an operation light: extensions in, parameters, bodies and responses out', async () => {
    const { document } = source('music-catalog')
    const albums = document.paths!['/albums']!
    albums.get!['x-feature'] = 'catalogue'
    const model = await generateMcpModel(document)
    const list = model.tools.find((t) => t.operation.operationId === 'fetchCollection.albums')!
    expect(list.operation.operation).toMatchObject({
      operationId: 'fetchCollection.albums',
      'x-feature': 'catalogue',
    })
    expect(Object.keys(list.operation.operation)).not.toEqual(
      expect.arrayContaining(['parameters']),
    )
    expect(list.operation.operation['responses']).toBeUndefined()
  })

  it('serves the same tools after a round trip through JSON', async () => {
    const { document } = source('music-catalog')
    const model = await generateMcpModel(document, { defaultPageSize: 25 })
    const fromJson = createJsonApiMcp({ model: JSON.parse(serialiseMcpModel(model)) })
    expect(fromJson.tools).toEqual(createJsonApiMcp({ model }).tools)
    const list = fromJson.tools.find((t) => t.name === 'albums_list')!
    expect(JSON.stringify(list.inputSchema)).toContain('Leave null for 25.')
  })

  it('loads the committed model the way a CommonJS host would, with require', () => {
    const require = createRequire(import.meta.url)
    const mcp = createJsonApiMcp({ model: require(committed) })
    expect(mcp.contract).toBe(18)
    expect(mcp.tools.map((t) => t.name)).toContain('albums_list')
  })
})

describe('writeMcpModel and the CLI', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'json-api-mcp-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the model, and a check passes until the model changes', async () => {
    const output = join(dir, 'api.mcp.json')
    expect(await writeMcpModel({ input: spec, output, check: true })).toEqual({
      path: output,
      upToDate: false,
    })
    await writeMcpModel({ input: spec, output })
    expect(readFileSync(output, 'utf8')).toBe(readFileSync(committed, 'utf8'))
    expect((await writeMcpModel({ input: spec, output, check: true })).upToDate).toBe(true)

    // Whitespace a formatter changes isn't drift; content is.
    const model = JSON.parse(readFileSync(output, 'utf8')) as {
      tools: { tool: { name: string } }[]
    }
    writeFileSync(output, JSON.stringify(model))
    expect((await writeMcpModel({ input: spec, output, check: true })).upToDate).toBe(true)
    model.tools[0]!.tool.name = 'renamed'
    writeFileSync(output, JSON.stringify(model))
    expect((await writeMcpModel({ input: spec, output, check: true })).upToDate).toBe(false)
  })

  it('parses its arguments', () => {
    expect(
      parseArgs([
        '--input',
        'a.json',
        '--output',
        'b.json',
        '--default-page-size',
        '20',
        '--check',
      ]),
    ).toEqual({ input: 'a.json', output: 'b.json', defaultPageSize: 20, check: true })
    expect(parseArgs(['--include-depth', '2'])).toEqual({ includeDepth: 2 })
    expect(parseArgs(['--include-depth', 'all'])).toEqual({ includeDepth: null })
  })

  it('records the include depth it was given, 1 by default', async () => {
    const output = join(dir, 'api.mcp.json')
    await writeMcpModel({ input: spec, output, includeDepth: 2 })
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ includeDepth: 2 })
    await writeMcpModel({ input: spec, output, includeDepth: null })
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ includeDepth: null })
    expect(JSON.parse(readFileSync(committed, 'utf8'))).toMatchObject({ includeDepth: 1 })
  })

  it('exits 1 with usage or a reason, 0 when it writes or the check passes', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const output = join(dir, 'api.mcp.json')
    expect(await main(['--input', spec])).toBe(1)
    expect(await main(['--input', spec, '--output', output, '--default-page-size', '0'])).toBe(1)
    expect(await main(['--input', spec, '--output', output, '--include-depth', '-1'])).toBe(1)
    expect(await main(['--input', spec, '--output', output, '--include-depth', 'deep'])).toBe(1)
    expect(await main(['--input', spec, '--output', output, '--check'])).toBe(1)
    expect(await main(['--input', spec, '--output', output])).toBe(0)
    expect(await main(['--input', spec, '--output', output, '--check'])).toBe(0)
    expect(await main(['--input', join(dir, 'missing.json'), '--output', output])).toBe(1)
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/is out of date/)
    error.mockRestore()
  })
})
