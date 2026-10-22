# CLAUDE.md — json-api-ts

TypeScript client suite for `haddowg/json-api` servers: a pnpm/Turborepo monorepo with
`packages/client`, `packages/codegen`, `packages/query` and `packages/angular`, released to npm
by release-please. `CONTEXT.md` holds the design decisions and glossary, `docs/adr/` the ADRs
(format in `docs/adr/ADR-FORMAT.md`).

## Gates

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
pnpm build && pnpm codegen:check && pnpm lint:publish && pnpm smoke
```

CI runs all of them on every PR. The pre-commit hook runs oxfmt, oxlint, mkdocs `--strict` and a
typecheck of only the workspaces a commit touches, so CI is what proves the whole repo compiles.
Don't run oxfmt over `docs/`: it breaks MkDocs admonitions.

## Commits, PRs and merges

release-please files each commit on `main` under every package whose files it changes, so how a PR
lands decides which changelogs its entries reach (ADR 0008).

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
