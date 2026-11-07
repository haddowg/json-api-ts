// Typechecks only the workspaces the given files belong to, for the pre-commit hook.
// A commit can then change one package without the others compiling against it yet;
// CI's `pnpm typecheck` still checks every workspace before anything reaches main.
// Turbo builds each checked package's workspace dependencies first (`^build`), so a
// package is still checked against the current source of the packages it imports.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const workspaceOf = (file) => {
  const match = /^(packages|examples)\/([^/]+)\//.exec(file)
  if (match === null) {
    return null
  }
  const dir = `${match[1]}/${match[2]}`
  return existsSync(`${dir}/package.json`) ? dir : null
}

const workspaces = [
  ...new Set(
    process.argv
      .slice(2)
      .map(workspaceOf)
      .filter((dir) => dir !== null),
  ),
].sort()

if (workspaces.length === 0) {
  process.exit(0)
}

// The generated clients the workspaces import are not committed. Write them from the pinned
// server documents first if this checkout has none yet.
const GENERATED = [
  'packages/codegen/test/generated/music-catalog.client.gen.ts',
  'packages/example/src/generated/music-catalog.gen.ts',
  'examples/spotify-clone/src/generated/music-catalog.gen.ts',
  'examples/angular-catalog/src/generated/music-catalog.gen.ts',
]
if (!GENERATED.every((file) => existsSync(file))) {
  const generated = spawnSync('pnpm', ['generate'], { stdio: 'inherit' })
  if (generated.status !== 0) {
    process.exit(generated.status ?? 1)
  }
}

const result = spawnSync(
  'pnpm',
  ['exec', 'turbo', 'run', 'typecheck', ...workspaces.map((dir) => `--filter=./${dir}`)],
  { stdio: 'inherit' },
)

process.exit(result.status ?? 1)
