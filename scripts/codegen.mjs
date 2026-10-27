// Regenerates — or, with `--check`, drift-checks — every generated client kept in the
// repo from its committed source spec. Run without a flag to regenerate all of them
// (`pnpm codegen`); run with `--check` (`pnpm codegen:check`, the CI gate) to fail if any
// committed client differs from what the current codegen would produce for its spec.
// The test snapshot and the example clients share the music-catalog fixture, which keeps
// them honest against the same wire contract. Only the test snapshot writes the examples
// module. The contract witness is core's own document, kept verbatim, for the structures the
// example app doesn't use. The MCP models are checked the same way, built with the MCP
// package's own CLI.
import { spawnSync } from 'node:child_process'

const CLI = 'packages/codegen/dist/cli.mjs'
const MUSIC_CATALOG = {
  input: 'packages/codegen/test/fixtures/music-catalog.openapi.json',
  schemas: 'packages/codegen/test/fixtures/music-catalog.schemas.json',
}

const TARGETS = [
  {
    ...MUSIC_CATALOG,
    output: 'packages/codegen/test/generated/music-catalog.client.gen.ts',
    examples: true,
  },
  { ...MUSIC_CATALOG, output: 'packages/example/src/generated/music-catalog.gen.ts' },
  { ...MUSIC_CATALOG, output: 'examples/spotify-clone/src/generated/music-catalog.gen.ts' },
  { ...MUSIC_CATALOG, output: 'examples/angular-catalog/src/generated/music-catalog.gen.ts' },
  {
    input: 'packages/codegen/test/fixtures/contract-witness.openapi.json',
    output: 'packages/codegen/test/generated/contract-witness.client.gen.ts',
  },
]

// The MCP models, written by the MCP package's generator CLI from the same specs.
const MCP_CLI = 'packages/mcp/dist/cli.mjs'
const MCP_TARGETS = [
  {
    input: MUSIC_CATALOG.input,
    output: 'packages/mcp/test/generated/music-catalog.mcp.gen.json',
  },
  {
    input: 'packages/codegen/test/fixtures/contract-witness.openapi.json',
    output: 'packages/mcp/test/generated/contract-witness.mcp.gen.json',
  },
]

const check = process.argv.includes('--check')

let failed = false
for (const { input, schemas, output, examples } of TARGETS) {
  const args = [CLI, '--input', input, '--output', output]
  if (schemas !== undefined) {
    args.push('--schemas', schemas)
  }
  if (examples) {
    args.push('--examples')
  }
  if (check) {
    args.push('--check')
  }
  const result = spawnSync('node', args, { stdio: 'inherit' })
  if (result.status !== 0) {
    failed = true
  }
}

for (const { input, output } of MCP_TARGETS) {
  const args = [MCP_CLI, '--input', input, '--output', output]
  if (check) {
    args.push('--check')
  }
  const result = spawnSync('node', args, { stdio: 'inherit' })
  if (result.status !== 0) {
    failed = true
  }
}

process.exit(failed ? 1 : 0)
