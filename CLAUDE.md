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

Don't record generator-contract history. `info.x-generator.contract` is a compatibility check for
the codegen, not a changelog: describe what the codegen reads and the client does now, and never
write which contract introduced it ("from generator contract 17…") in `docs/`, `CONTEXT.md`, this
file or a code comment. The server's changelog records when it arrived.

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
- Never merge a release-please PR yourself; it publishes to npm.
