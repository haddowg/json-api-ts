# CLAUDE.md — json-api-ts

TypeScript client suite for `haddowg/json-api` servers: a pnpm/Turborepo monorepo with
`packages/client`, `packages/codegen`, `packages/query`, `packages/angular` and `packages/mcp`,
released to npm by release-please. `CONTEXT.md` is the glossary, `docs/` describes the behaviour,
and `docs/adr/` holds the decisions (format in `docs/adr/ADR-FORMAT.md`). The toolchain is Vite+'s
underlying tools wired directly (pnpm, Turborepo, tsdown, Vitest, oxlint, oxfmt); move to the `vp`
wrapper only once it reaches 1.0.

## Gates

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
pnpm build && pnpm codegen:check && pnpm lint:publish && pnpm smoke
```

CI runs all of them on every PR. The pre-commit hook runs oxfmt, oxlint, mkdocs `--strict` and a
typecheck of only the workspaces a commit touches, so CI is what proves the whole repo compiles.
Don't run oxfmt over `docs/`: it breaks MkDocs admonitions.

The server documents are exact devDependency pins on `@haddowg/json-api-symfony-specs` and
`@haddowg/json-api-witness`, read from GitHub Packages (install needs a `read:packages` token), and
everything generated from them is gitignored and written by `pnpm generate` (ADR 0023). To move to a
newer document, bump the pin and refresh the lockfile; then read the `Generated output` PR comment
before adding the `generated-output` label. `pnpm check:pins` refuses a prerelease pin on `main`
and release PRs.

Don't record generator-contract history. `info.x-generator.contract` is a compatibility check for
the codegen, not a changelog: describe what the codegen reads and the client does now, and never
write which contract introduced it ("from generator contract 17…") in `docs/`, `CONTEXT.md`, this
file or a code comment. The server's changelog records when it arrived.

## Release passes

A release ships only when its work is complete across every repo it touches: core
(`haddowg/json-api`), the Symfony bundle, the Laravel adapter and json-api-ts. A feature,
enhancement or fix is not released while it has open questions, known bugs or follow-up tasks.
Related work found while building it, in any of those repos, belongs to the same pass. Separate
PRs keep each change small and reviewable and merge when green, but the release PRs wait until
the whole pass is polished.

- Before releasing, every caveat, edge case and deferred item from the pass is either done or
  decided. Each new rule has its consumers in step: documented parameters and the error codes
  they cause, runtime behaviour in both adapters, the TS client types and the MCP.
- Build the adapters against unreleased core locally, so Laravel parity and byte-compatibility
  hold before core releases.
- A generator contract bump ships with codegen and MCP already accepting it, released ahead of
  the documents that carry it.
- Release core, then the bundle, then Laravel, then json-api-ts, approving each release PR's
  workflow runs and reviewing its generated output.
- A released regression that blocks a consumer ships as a patch straight away, and it is complete
  too: related bugs or gaps found while fixing it go into the same patch pass across every repo.

## Commits, PRs and merges

release-please files each commit on `main` under every package whose files it changes, so how a PR
lands decides which changelogs its entries reach. A squashed multi-package PR would put every line in
every package's notes, and a `BEGIN_COMMIT_OVERRIDE` block can't scope them per package.

- **One package changed:** squash-merge. The PR title is the Conventional Commit.
- **Several packages changed:** rebase-merge (`gh pr merge --rebase`). Make every commit a
  Conventional Commit scoped to one package (`feat(client): …`, `fix(angular): …`), fold fixups in
  before merging, and leave out any `BEGIN_COMMIT_OVERRIDE` block.
- Commit a cross-package change as one commit per package, dependencies first (client before
  angular). The per-workspace hook allows an intermediate commit where a dependent doesn't compile
  yet; the PR as a whole must pass CI.
- Mark a breaking change with `!` or a `BREAKING CHANGE:` footer only when the published
  API breaks for generated-client users. Tightening types that were too loose, which only affects
  hand-written descriptors or mocks, ships as a minor with a note in the commit body.
- A release-please PR publishes to npm. Merge it only as the last step of a complete release
  pass, with its workflow runs approved and its generated output reviewed. It follows core, the
  bundle and Laravel, except when codegen and MCP must accept a new generator contract: that
  release goes out before the core release that carries the contract.
