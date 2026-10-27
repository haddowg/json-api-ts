# 0016 — A relation is polymorphic by its flag, and scopes ride the descriptor

- **Status:** Accepted
- **Date:** 2026-10-27

Generator contract 16 projects a polymorphic relation over one type as a one-member union, so a
generator can tell a `MorphTo` from a `BelongsTo` before a second type exists. Counting `types`
can't, so the codegen marks any union `polymorphic: true` and everything downstream asks
`isPolymorphic()`, which falls back to the count for a descriptor without the flag. The MCP tools
are where it shows: a polymorphic relation takes `{ type, id }` from its first type, so adding a
second type later doesn't change a tool's input. The same contract writes each operation's
scopes into its `security`. They go into the descriptor as optional lists keyed the way the
examples module keys operations, because the descriptor is what the MCP model and any other
consumer already carry, and an absent list is cheaper than an empty one in every browser bundle.

The flag is set for a union of several types too, so every generated client with a polymorphic
relation gains a line on regeneration. The TypeScript client already takes `{ type, id }` for
every relation, so only the MCP inputs and outputs change shape. Scopes are read only under a
scheme whose `type` is `oauth2`; a document listing scopes under another scheme, which core
reports as a diagnostic, generates none.
