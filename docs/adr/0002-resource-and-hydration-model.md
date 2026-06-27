# 0002 — Flattened resource objects with `$`-prefixed envelope accessors, per-edge views, and include-driven hydration

- **Status:** Accepted
- **Date:** 2026-06-27

A read returns a self-contained hydrated graph built from the response's `included`.
Included relations become nested resource objects; non-included relations are
`Identifier | undefined` (absent is a valid shape — links-only relations exist). The
**return type is computed from the `include` argument**, which is tractable because the
spec hands us a bounded, pre-expanded enum of allowed include paths per endpoint (so the
type machinery is a union over a finite set, not open recursion).

Each resource object **flattens its data** (`type`, `id`, attributes, and
hydrated/identifier relations) as own *enumerable* properties — so `{...res}` and
`JSON.stringify(res)` are clean — and exposes its envelope through non-enumerable,
**`$`-prefixed accessors** (`$meta`, `$links`, `$self`, `$document`, `$edge`, `$pivot`,
`$rel`, `$raw`). `$` is collision-proof because JSON:API forbids it in member names;
`type`/`id` stay plain because the spec reserves them. To-many relationship values are
**augmented arrays** (a real `T[]` carrying `$page`/`$links`/`$meta`/`$next()`); every
materialised related value carries its own `$edge` (and `$pivot` for pivot members), so
a related resource is a **per-edge view** — it reads through to the normalized node for
attributes but carries edge-local data.

The alternative — returning raw JSON:API documents, or store-resolved accessor handles —
either abandons the headline ergonomics or makes the return type unable to promise
hydration. Consequence: identity is by `type:id`, never object reference (the same
resource reached via two edges is two views); and edge-local data (`$pivot`/`$edge`)
must never be merged into the shared normalized node.
