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

const result = spawnSync(
  'pnpm',
  ['exec', 'turbo', 'run', 'typecheck', ...workspaces.map((dir) => `--filter=./${dir}`)],
  { stdio: 'inherit' },
)

process.exit(result.status ?? 1)
