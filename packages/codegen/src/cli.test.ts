import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { isEntry, parseArgs, run, USAGE } from './cli'

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
    vi.spyOn(console, 'error').mockImplementation(() => {})
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

  it('says which files it wrote', async () => {
    const output = join(dir, 'reported.gen.ts')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await run([
      '--input',
      fixturePath('music-catalog.openapi.json'),
      '--output',
      output,
      '--schemas',
      fixturePath('music-catalog.schemas.json'),
    ])
    expect(error).toHaveBeenCalledWith(`wrote ${output}`)
    expect(error).toHaveBeenCalledWith(`wrote ${join(dir, 'reported.schemas.gen.ts')}`)
  })

  it('warns when the document declares no resource types', async () => {
    const input = join(dir, 'empty.openapi.json')
    await writeFile(input, JSON.stringify({ openapi: '3.1.0', paths: {} }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await run(['--input', input, '--output', join(dir, 'empty.gen.ts')])).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('found no JSON:API resource types'))
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

describe('isEntry', () => {
  it('matches the bin when node runs it through a package-manager symlink', async () => {
    const target = join(dir, 'pkg', 'dist', 'cli.mjs')
    const link = join(dir, 'node_modules', '.bin', 'json-api-codegen')
    await mkdir(join(dir, 'pkg', 'dist'), { recursive: true })
    await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true })
    await writeFile(target, '')
    await symlink(target, link)
    expect(isEntry(pathToFileURL(target).href, link)).toBe(true)
  })

  it('does not match a module imported by another script', () => {
    const importer = fileURLToPath(import.meta.url)
    expect(isEntry(pathToFileURL(fixturePath('music-catalog.openapi.json')).href, importer)).toBe(
      false,
    )
    expect(isEntry(import.meta.url, undefined)).toBe(false)
  })
})
