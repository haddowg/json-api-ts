// Generates everything this repo derives from the server documents: the codegen's reference
// clients, the clients the example apps import, and the MCP models. The documents are not
// committed. They are read from the exact versions of `@haddowg/json-api-symfony-specs` (the
// bundle's music-catalog example) and `@haddowg/json-api-witness` (core's contract witness)
// pinned in the root package.json, and the output is gitignored.
//
//   node scripts/generate.mjs              write every output in place (`pnpm generate`)
//   node scripts/generate.mjs --check      fail if an output on disk is missing or stale
//   node scripts/generate.mjs --out <dir>  write the reviewed outputs under <dir> instead,
//                                          for the CI generated-output report
//
// It runs the built CLIs, so build `@haddowg/json-api-codegen` and `@haddowg/json-api-mcp`
// first; `pnpm generate` does both.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const document = (specifier) => require.resolve(specifier)

const MUSIC_CATALOG = {
  input: document('@haddowg/json-api-symfony-specs/music-catalog.openapi.json'),
  schemas: document('@haddowg/json-api-symfony-specs/music-catalog.schemas.json'),
}
const CONTRACT_WITNESS = { input: document('@haddowg/json-api-witness/contract-witness.json') }

// `reviewed` outputs are the ones the generated-output report diffs. The example apps' clients
// are the reference client without `--examples`, so diffing them too would only repeat it.
const CLIENTS = [
  {
    ...MUSIC_CATALOG,
    output: 'packages/codegen/test/generated/music-catalog.client.gen.ts',
    examples: true,
    reviewed: true,
  },
  {
    ...CONTRACT_WITNESS,
    output: 'packages/codegen/test/generated/contract-witness.client.gen.ts',
    reviewed: true,
  },
  { ...MUSIC_CATALOG, output: 'packages/example/src/generated/music-catalog.gen.ts' },
  { ...MUSIC_CATALOG, output: 'examples/spotify-clone/src/generated/music-catalog.gen.ts' },
  { ...MUSIC_CATALOG, output: 'examples/angular-catalog/src/generated/music-catalog.gen.ts' },
]

const MCP_MODELS = [
  {
    input: MUSIC_CATALOG.input,
    output: 'packages/mcp/test/generated/music-catalog.mcp.gen.json',
    reviewed: true,
  },
  {
    input: CONTRACT_WITNESS.input,
    output: 'packages/mcp/test/generated/contract-witness.mcp.gen.json',
    reviewed: true,
  },
]

const argv = process.argv.slice(2)
const check = argv.includes('--check')
const outIndex = argv.indexOf('--out')
const out = outIndex === -1 ? undefined : argv[outIndex + 1]
if (outIndex !== -1 && (out === undefined || out.startsWith('--'))) {
  console.error('usage: node scripts/generate.mjs [--check | --out <dir>]')
  process.exit(2)
}

const selected = (targets) => (out === undefined ? targets : targets.filter((t) => t.reviewed))
const destination = (output) => (out === undefined ? output : join(out, output))

let failed = false
const run = (args) => {
  const result = spawnSync('node', args, { stdio: 'inherit' })
  if (result.status !== 0) {
    failed = true
  }
}

for (const { input, schemas, output, examples } of selected(CLIENTS)) {
  const args = ['packages/codegen/dist/cli.mjs', '--input', input, '--output', destination(output)]
  if (schemas !== undefined) {
    args.push('--schemas', schemas)
  }
  if (examples) {
    args.push('--examples')
  }
  if (check) {
    args.push('--check')
  }
  run(args)
}

for (const { input, output } of selected(MCP_MODELS)) {
  const args = ['packages/mcp/dist/cli.mjs', '--input', input, '--output', destination(output)]
  if (check) {
    args.push('--check')
  }
  run(args)
}

process.exit(failed ? 1 : 0)
