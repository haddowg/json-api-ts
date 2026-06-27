# 0004 — Light structural guards + opt-in validation seam; "minimal/shallow/well-maintained" deps, not hard zero-dep

- **Status:** Accepted
- **Date:** 2026-06-27

The core runtime does only **light structural guards** (is this a JSON:API document?
does `data` carry `type`+`id`?) and otherwise trusts the wire — we own both ends (the
same spec generates the bundle's output _and_ this client) and the envelope is invariant,
so full per-field validation by default would add cost for little benefit. Full
validation is **opt-in** through a pluggable `validate?` seam fed by the bundle's JSON
Schemas, validating each resource object by its `type`; the validation _engine_ (e.g.
ajv) is brought by the user or an optional adapter, never in the core dependency tree.
Missing-include is handled **gracefully** — leave the relation as an identifier (+
dev-mode warning), never throw at the boundary.

This supersedes the original "zero runtime deps" goal. The real intent is avoiding npm
supply-chain exposure and bundle bloat, not dogmatic zero: a runtime dependency is
acceptable when it is **tiny or very actively/well-maintained and has a shallow
dependency tree**; a heavy or deep-tree dependency is rejected. (Build/dev tooling is
judged on stability and reproducibility, not dep count, since it never reaches
consumers.)

Consequence: consumers who need hard validation (e.g. against a drifting third-party
server) opt into the seam and supply an engine; everyone else pays nothing. The bundle
must serve its JSON Schemas over HTTP for the seam to have a source (tracked as a
bundle-side enrichment).
