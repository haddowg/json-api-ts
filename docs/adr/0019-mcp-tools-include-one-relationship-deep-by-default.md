# MCP tools include one relationship deep by default

Servers declare include paths several relationships deep, so in a well-connected API every tool's output schema carried most of the API's types and every `tools/list` repeated them. The generator caps the depth at 1 by default (`--include-depth all` keeps every declared path), and the runtime refuses any other path and cuts a deeper related resource back to its id, so a server's default includes can't return a shape the schema doesn't describe.

## Consequences

A model follows ids with further calls rather than fetching a deep graph in one.
