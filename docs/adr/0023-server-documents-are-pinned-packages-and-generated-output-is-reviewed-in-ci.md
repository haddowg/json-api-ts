# Server documents are pinned packages and their generated output is reviewed in CI

The documents this repo generates and tests against, the bundle's music-catalog example and core's contract witness, were committed copies, and so was everything generated from them. The copies drifted from the servers that publish them, and every refresh was a large diff nobody could read. They are now devDependencies on `@haddowg/json-api-symfony-specs` and `@haddowg/json-api-witness`, each pinned to one exact version, and the clients and MCP models are generated from `node_modules` before the typecheck and the tests and gitignored. The file snapshots that caught changes to the output gave way to a CI job that generates it on a pull request's base and head, posts the difference as one comment and fails until the `generated-output` label acknowledges it, the same report the servers run on their own documents.

## Consequences

- Both packages are on GitHub Packages, so every install, locally and in CI, needs a token that can read packages. The `@haddowg` scope is mapped there in `.npmrc`, and since npm resolves a scoped package's registry from that mapping before its `publishConfig.registry` or a `--@haddowg:registry` flag, the release workflow drops the mapping before it publishes, and each package also names npmjs in its `publishConfig`.
- A pull request may pin a server pull request's prerelease to test against it, with a warning, but `main` and release pull requests refuse one (`pnpm check:pins`), because a prerelease is deleted when its pull request closes.
