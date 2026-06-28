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

  it('warns that --schemas is a no-op but still generates', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const output = join(dir, 'schemas.gen.ts')
    const code = await run([
      '--input',
      fixturePath('music-catalog.openapi.json'),
      '--output',
      output,
      '--schemas',
      fixturePath('music-catalog.schemas.json'),
    ])
    expect(code).toBe(0)
    expect(warn.mock.calls.some((call) => String(call[0]).includes('--schemas'))).toBe(true)
  })
})
