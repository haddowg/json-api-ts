# 0018 — An action answering with a URL returns the URL and never follows it

- **Status:** Accepted
- **Date:** 2026-10-27

Generator contract 17 lets an action hand out a URL, such as a presigned download link. Core answers a request preferring JSON:API with a `200` location document and every other request with a `303` (core ADR 0185), because `fetch()` follows a `303` itself and can't read its `Location` with `redirect: 'manual'`. The client always asks for JSON:API, so it gets the document. We return the URL as `{ url, type, expiresAt? }` rather than fetching it: the target is usually object storage on another origin, where the client's auth headers don't belong, and a browser downloads a file better through a link or navigation than through a `Blob` in memory. The MCP tools return the same object for the same reasons, plus that a model has no use for the bytes of a file it can't open.

The codegen marks the action in the descriptor with `location: { mediaType }`, and with a new `output: 'location'` when the URL is all it answers with, so the client and the MCP package read the descriptor instead of inferring the shape from schemas. An action that also declares its own document gets a union return, told apart at runtime by the document's shape: a location document has no `data`. Adding `location` to `ActionOutput` widens a published union, which only a hand-written exhaustive switch over it would notice.
