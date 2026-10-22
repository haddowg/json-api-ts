// Runs the built codegen bin the way a package manager installs it: through a symlink in
// node_modules/.bin. Node reports the symlink in process.argv[1], so a main-module check that
// compares it to import.meta.url without resolving it exits 0 having written nothing.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const cli = join(root, 'packages/codegen/dist/cli.mjs')
const spec = join(root, 'packages/codegen/test/fixtures/music-catalog.openapi.json')

const dir = mkdtempSync(join(tmpdir(), 'japi-codegen-bin-'))
try {
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true })
  const bin = join(dir, 'node_modules/.bin/json-api-codegen')
  symlinkSync(cli, bin)
  const output = join(dir, 'client.gen.ts')

  const result = spawnSync('node', [bin, '--input', spec, '--output', output], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `[bin] exited ${result.status}: ${result.stderr}`)
  assert.ok(existsSync(output), '[bin] ran through a symlink but wrote no output')
  assert.match(readFileSync(output, 'utf8'), /export const resourceMap = \{/)
  assert.match(result.stderr, /wrote .*client\.gen\.ts/)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(
  '[bin] json-api-codegen ran through a node_modules/.bin symlink and wrote the client OK',
)
