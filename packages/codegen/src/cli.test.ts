import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs, run, USAGE } from './cli'

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url))
}

const dir = await mkdtemp(join(tmpdir(), 'japi-codegen-cli-'))

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('parseArgs', () => {
  it('parses every known flag and its value', () => {
    expect(
      parseArgs([
        '--input',
        'a.json',
        '--output',
        'out.ts',
        '--server',
        'admin',
        '--schemas',
        's.json',
      ]),
    ).toEqual({ input: 'a.json', output: 'out.ts', server: 'admin', schemas: 's.json' })
  })

  it('ignores unknown flags and a trailing flag with no value', () => {
    expect(parseArgs(['--bogus', 'x', '--input'])).toEqual({})
  })

  it('parses --check as a valueless boolean flag', () => {
    expect(parseArgs(['--input', 'a.json', '--output', 'out.ts', '--check'])).toEqual({
      input: 'a.json',
      output: 'out.ts',
      check: true,
    })
  })
})

describe('run', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('prints usage and returns 1 when input/output are missing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await run([])).toBe(1)
    expect(error).toHaveBeenCalledWith(USAGE)
  })

  it('generates a client and returns 0 for a valid invocation', async () => {
    const output = join(dir, 'client.gen.ts')
    expect(
      await run(['--input', fixturePath('music-catalog.openapi.json'), '--output', output]),
    ).toBe(0)
    expect(await readFile(output, 'utf8')).toContain('export const resourceMap = {')
  })

  it('emits a schema artifact beside the client when --schemas is supplied', async () => {
    const output = join(dir, 'with-schemas.gen.ts')
    const code = await run([
      '--input',
      fixturePath('music-catalog.openapi.json'),
      '--output',
      output,
      '--schemas',
      fixturePath('music-catalog.schemas.json'),
    ])
    expect(code).toBe(0)
    const schemas = await readFile(join(dir, 'with-schemas.schemas.gen.ts'), 'utf8')
    expect(schemas).toContain('export const schemas = {')
    expect(schemas).toContain('"const": "albums"')
  })

  it('returns 0 in --check mode when the committed client is up to date', async () => {
    const output = join(dir, 'check-ok.gen.ts')
    await run(['--input', fixturePath('music-catalog.openapi.json'), '--output', output])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(
      await run([
        '--input',
        fixturePath('music-catalog.openapi.json'),
        '--output',
        output,
        '--check',
      ]),
    ).toBe(0)
  })

  it('returns 1 in --check mode when the committed client has drifted', async () => {
    const output = join(dir, 'check-drift.gen.ts')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    // No prior generation: a missing committed file is drift.
    expect(
      await run([
        '--input',
        fixturePath('music-catalog.openapi.json'),
        '--output',
        output,
        '--check',
      ]),
    ).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('out of date'))
  })
})
