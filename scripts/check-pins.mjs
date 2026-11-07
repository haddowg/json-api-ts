// Guards the pins on the server documents this repo generates from. Every
// `@haddowg/json-api-witness` and `@haddowg/json-api-symfony-specs` dependency in the workspace
// must name one exact version that exists in the registry. A prerelease (a server pull request's
// `0.0.0-pr.<n>.<sha>`, deleted when that pull request closes) is only tolerated on an ordinary
// pull request, with a warning. A release-please pull request, `main` and any other CI run fail
// on one, so nothing released was tested against a document that is about to disappear.
//
// Reads the registry through npm, so it needs the same GitHub Packages token as the install.
//
//   node scripts/check-pins.mjs   (`pnpm check:pins`)
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PINNED = ['@haddowg/json-api-witness', '@haddowg/json-api-symfony-specs']
const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const event = process.env.GITHUB_EVENT_NAME ?? ''
const headRef = process.env.GITHUB_HEAD_REF ?? ''
const releasePullRequest = headRef.startsWith('release-please--')
// Outside CI (a developer's machine) a prerelease is tolerated, as on a pull request.
const prereleaseAllowed =
  !releasePullRequest && (event === 'pull_request' || process.env.CI === undefined)

const manifests = ['package.json']
for (const dir of ['packages', 'examples']) {
  for (const name of readdirSync(dir)) {
    if (existsSync(join(dir, name, 'package.json'))) {
      manifests.push(join(dir, name, 'package.json'))
    }
  }
}
manifests.push('scripts/smoke/package.json')

const errors = []
const warnings = []
const pins = []
for (const manifest of manifests) {
  const json = JSON.parse(readFileSync(manifest, 'utf8'))
  for (const field of FIELDS) {
    for (const name of PINNED) {
      const version = json[field]?.[name]
      if (version !== undefined) {
        pins.push({ manifest, field, name, version })
      }
    }
  }
}

for (const name of PINNED) {
  if (!pins.some((pin) => pin.name === name)) {
    errors.push(`${name} is not pinned in any package.json.`)
  }
}

for (const { manifest, field, name, version } of pins) {
  const where = `${manifest} ${field} ${name}@${version}`
  if (!EXACT.test(version)) {
    errors.push(`${where} is not an exact version. Pin one version, with no range or tag.`)
    continue
  }
  let published = ''
  try {
    published = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    const detail = String(error.stderr ?? error.message)
      .split('\n')
      .find((line) => line.includes('ERR') || line.includes('error'))
    errors.push(
      `${where} could not be read from the registry${detail === undefined ? '' : ` (${detail.trim()})`}. ` +
        'Reading GitHub Packages needs a token with read:packages.',
    )
    continue
  }
  if (published !== version) {
    errors.push(`${where} does not exist in the registry.`)
    continue
  }
  if (version.includes('-')) {
    const message = `${where} is a prerelease, which is deleted when its pull request closes. Pin the release that ships it before this is released.`
    if (prereleaseAllowed) {
      warnings.push(message)
    } else {
      errors.push(`${message} Prereleases are refused on main and on release pull requests.`)
    }
  }
}

const annotate = process.env.GITHUB_ACTIONS === 'true'
for (const message of warnings) {
  console.warn(annotate ? `::warning::${message}` : `warning: ${message}`)
}
for (const message of errors) {
  console.error(annotate ? `::error::${message}` : `error: ${message}`)
}
if (errors.length === 0) {
  for (const { name, version } of pins) {
    console.log(`${name}@${version} is pinned and published.`)
  }
}
process.exit(errors.length === 0 ? 0 : 1)
