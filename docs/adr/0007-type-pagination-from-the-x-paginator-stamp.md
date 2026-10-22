# 0007 — Pagination is typed from the server's x-paginator stamp, with a menu picked by kind

- **Status:** Accepted
- **Date:** 2026-10-22

Page keys can be renamed on the server, and a `MultiPaginator` offers several strategies at once,
so member names alone can't say how a collection paginates or what a menu answers by default.
`haddowg/json-api` now stamps each page schema with `x-paginator` (generator contract 3), and the
PHP codegen reads it under the same rules: the stamp decides the strategy and keys, name inference
on canonical keys is the fallback, and anything unrecognised generates as unpaginated with a warning.

The descriptor's `paginator` grows from a bare kind to a bare kind, `{ strategy, keys }`, or a menu
of arms with a default. The `page` argument is typed per collection from it, and a menu is a union
discriminated on `kind`, plus the default arm untagged. `$page` is typed by the strategy that will
answer, inferred from the `page` argument through a `const` type parameter on `list()` and the
relation reads. The runtime resolves the same answer from the request and carries `keys` and the
picked `arm` on `$page`.

This changes published types: `PaginatorKind` no longer describes every descriptor, `Collection`
takes a page type, the `navigate` seam receives a resolved paginator instead of a kind, and the
Angular `nextPage()` returns counts as numbers. A bare kind still means the canonical keys, so a
descriptor generated before this keeps working.
