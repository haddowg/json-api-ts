import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readDocument } from './reader'

const dir = await mkdtemp(join(tmpdir(), 'japi-reader-'))

afterAll(async () => {
  await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }))
})

describe('readDocument', () => {
  it('parses a JSON file', async () => {
    const path = join(dir, 'doc.json')
    await writeFile(path, JSON.stringify({ openapi: '3.1.0', paths: {} }))
    const doc = await readDocument(path)
    expect(doc.openapi).toBe('3.1.0')
  })

  it('parses a YAML file', async () => {
    const path = join(dir, 'doc.yaml')
    await writeFile(path, 'openapi: 3.1.0\npaths: {}\n')
    const doc = await readDocument(path)
    expect(doc.openapi).toBe('3.1.0')
  })

  it('falls back to a content sniff for an unknown extension', async () => {
    const path = join(dir, 'doc.txt')
    await writeFile(path, '{"openapi":"3.1.0"}')
    const doc = await readDocument(path)
    expect(doc.openapi).toBe('3.1.0')
  })
})
