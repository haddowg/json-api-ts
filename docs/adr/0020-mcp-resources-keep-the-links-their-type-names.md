# 0020 — MCP resources keep the links their type names

- **Status:** Accepted
- **Date:** 2026-10-30

A flattened resource used to drop every link, so a tool returning a resource whose next step is a link, such as convertr's `files_create` answering with a pending file and its presigned upload URL, left the model with no way to take that step. A flattened resource now keeps the links its type names, its declared links and its action links, under `links`, and drops the generic ones every resource may carry, such as `self`, `related` and `describedby`. Those are what the model can act on, and the rest only cost tokens. Each link is `{ href, type?, title?, meta? }`, with a bare URL string normalised to `{ href }`, so a model reads one shape whichever way the server renders it. Its output schema types each link from the document's link schema, meta members included.

The descriptor doesn't carry link names, so the model records them per type as `resourceLinks`. Putting them under `links` beside the attributes means a type with an attribute or relationship called `links` can't be flattened, and the generator fails on one rather than let either shadow the other. What we gave up is resource meta and the links no type names, which stay dropped.
