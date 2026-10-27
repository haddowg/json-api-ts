# 0019 — MCP tools include one relationship deep by default

- **Status:** Accepted
- **Date:** 2026-10-27

A tool's output schema already held only the types its declared include paths reach, but servers declare paths several relationships deep, and in a well-connected API such as convertr's v5 that is most types. Every tool then carried most of the API's resource schemas, and every `tools/list` repeated them. The generator now takes an include depth, 1 by default and `null` for every declared path. A tool lists only the declared paths within it as an enum on its `include` argument, has no `include` when none are left, and its `$defs` cover only the types those paths reach. The runtime refuses any other path as a tool error before calling the API, and cuts a related resource deeper than the cap back to its id, so a server's default includes can't return a shape the schema doesn't describe. What we gave up is a model fetching a deep graph in one call: it now follows ids with further calls, unless the host raises the depth.

The model also stored each operation's security three times: on the raw operation object, normalised beside it, and as `scopes`. It now stores an operation's own `security` once, the document's once at the top level, and no `scopes`. The runtime puts `security` back on the operation object and reads `scopes` from the descriptor, so hooks see what they saw before. The descriptor keeps its scopes, because hooks read the descriptor entry too and its relationship-endpoint keys can't be rebuilt from the tools.

Both change what the model stores and what the runtime must enforce, so the format goes to 3. An older runtime refuses a format 3 model rather than accept deep includes its output schemas don't describe. The runtime still reads formats 1 and 2 with no include cap and their stored security and scopes.
