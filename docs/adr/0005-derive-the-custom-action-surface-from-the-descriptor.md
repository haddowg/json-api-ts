# 0005 — Derive the custom-action client surface from the descriptor, not a generated alias map

- **Status:** Accepted
- **Date:** 2026-07-02

The generated client typed a custom action from per-action `<Type><Action>Input`/`Output`
aliases that structurally expanded the OpenAPI request/response _documents_. That put the
typed contract at odds with the runtime on three counts: a document-output action's result
was typed as the raw wire envelope (`result.data.attributes.title`) while `runAction`
returns the materialised resource (`result.title`); a meta-only action (a `200`
`MetaDocument`) was mis-typed as a resource document and its payload silently dropped; and
codegen only read each `-actions` path's `post` operation, so a non-POST action (and its
runtime dispatch, hardcoded to `POST`) simply vanished.

The descriptor now carries the resolved facts — `method`, `inputType`, `outputType`,
`outputCardinality`, and a `'meta'` output mode — and the client's action types derive from
them: a document output is the materialised `ReadResult` of its `outputType` (matching the
read path), a document input is the FLAT `CreateInput` of its `inputType` (envelope built +
`422` pointers remapped like `create`, with a raw-envelope fallback for a bespoke command
document), a `meta` output returns the document's top-level `meta`, and `runAction`
dispatches over `action.method`. The per-action alias map (`ActionTypes`, the client's
fourth type argument) is retained only as a fallback for a not-yet-regenerated client, so
older generated clients keep compiling.

The consequence: the action surface is now a public-API contract expressed in the descriptor
rather than in emitted aliases, so regenerating an old client is a breaking change to those
actions' input/output types — the price of making the "typesafe" client actually match what
it sends and returns.
