// Regenerates — or, with `--check`, drift-checks — every generated client kept in the
// repo from the single committed source spec (the music-catalog fixture). Run without a
// flag to regenerate all of them (`pnpm codegen`); run with `--check` (`pnpm codegen:check`,
// the CI gate) to fail if any committed client differs from what the current codegen would
// produce for that spec. Keeping the test snapshot and the two example clients on one
// source keeps them honest against the same wire contract.
import { spawnSync } from 'node:child_process'

const CLI = 'packages/codegen/dist/cli.mjs'
const INPUT = 'packages/codegen/test/fixtures/music-catalog.openapi.json'
const SCHEMAS = 'packages/codegen/test/fixtures/music-catalog.schemas.json'

const OUTPUTS = [
  'packages/codegen/test/generated/music-catalog.client.gen.ts',
  'packages/example/src/generated/music-catalog.gen.ts',
  'examples/spotify-clone/src/generated/music-catalog.gen.ts',
]

const check = process.argv.includes('--check')

let failed = false
for (const output of OUTPUTS) {
  const args = [CLI, '--input', INPUT, '--output', output, '--schemas', SCHEMAS]
  if (check) {
    args.push('--check')
  }
  const result = spawnSync('node', args, { stdio: 'inherit' })
  if (result.status !== 0) {
    failed = true
  }
}

process.exit(failed ? 1 : 0)
