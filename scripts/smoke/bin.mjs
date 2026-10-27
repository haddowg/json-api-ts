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

// The MCP generator's bin, the same way: a check of the committed model through a symlink.
const mcpCli = join(root, 'packages/mcp/dist/cli.mjs')
const mcpModel = join(root, 'packages/mcp/test/generated/music-catalog.mcp.gen.json')
const mcpDir = mkdtempSync(join(tmpdir(), 'japi-mcp-bin-'))
try {
  mkdirSync(join(mcpDir, 'node_modules/.bin'), { recursive: true })
  const bin = join(mcpDir, 'node_modules/.bin/json-api-mcp')
  symlinkSync(mcpCli, bin)
  const result = spawnSync('node', [bin, '--input', spec, '--output', mcpModel, '--check'], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `[bin] json-api-mcp exited ${result.status}: ${result.stderr}`)
  assert.match(result.stderr, /ok +.*music-catalog\.mcp\.gen\.json/)
} finally {
  rmSync(mcpDir, { recursive: true, force: true })
}

console.log('[bin] json-api-codegen and json-api-mcp ran through node_modules/.bin symlinks OK')
