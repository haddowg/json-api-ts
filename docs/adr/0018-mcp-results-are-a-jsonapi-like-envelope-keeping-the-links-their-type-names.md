# MCP results are a JSON:API-like envelope whose resources keep the links their type names

Every structured result is shaped like the document it came from (`{ data, meta? }`, `{ data, links, meta? }` with only pagination links, `{ data: null }` for a delete, `{ meta }` for a meta-only action), so a model learns one shape and the document's meta has a home. A flattened resource keeps under `links` the links its type names, its declared and action links such as a presigned upload URL a next step needs, and drops the generic `self`, `related` and `describedby` and the resource's meta, which cost tokens and give a model nothing to act on.

## Consequences

A type that names links and has a field called `links` can't be flattened, so the generator fails on it. A model in an older format still loads and returns the shapes its stored schemas describe, so upgrading the package changes nothing until the host regenerates.
