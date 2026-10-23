# 0008 — Multi-package PRs are rebase-merged with package-scoped commits

- **Status:** Accepted
- **Date:** 2026-10-22

release-please attributes each commit on `main` to every package whose files it changes. A
squash-merged PR that spans packages is one commit touching all of them, so every changelog line
reached every package's notes. A `BEGIN_COMMIT_OVERRIDE` block rewrites the messages but can't
scope them per package. A PR that changes one package is still squash-merged; one that changes
several is rebase-merged, its commits each scoped to one package, so each release lists only its
own changes. Splitting such work into one PR per package was rejected: a change like typed
pagination would need a stack of PRs merged in order.

To make package-scoped commits practical, the pre-commit typecheck covers only the workspaces a
commit touches, and the full typecheck runs in CI before merge.
