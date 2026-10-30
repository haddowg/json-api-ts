# 0021 — MCP results are a JSON:API-like envelope

- **Status:** Accepted
- **Date:** 2026-10-30

Results came in several shapes: `{ item }` from a get, a bare resource from a create or update, `{ items, links, meta }` from a list, a bare meta object or URL from an action, and text from a delete. A model had to learn which tool answered how, and a bare resource had nowhere to put the document's meta. Every structured result is now an envelope shaped like the JSON:API document it came from: `{ data, meta? }` for one resource, `{ data, links, meta? }` for a collection, `{ data: null, meta? }` for a delete, and `{ meta }` with no `data` for a meta-only action, because that is the document the API sent. A URL an action answers with is `{ data: { url, type, expiresAt? } }`. The top-level `links` only carries pagination, so it never competes with a resource's own `links`.

The output schemas change with the results, so the model format goes to 4 and an older runtime refuses a format 4 model rather than return shapes its schemas don't describe. A newer runtime still loads formats 1 to 3 and returns the 1.2 shapes their stored schemas describe, so upgrading the package changes nothing until the host regenerates. The shapes change for every caller that regenerates, which is a breaking change in what a tool returns. It ships as a minor because the package has one consumer, convertr's unified-ai, and isn't yet documented on jsonapi.rest.
