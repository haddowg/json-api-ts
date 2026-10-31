# MCP tools are served from a model generated at build time

Building tools at runtime made every host load the ESM-only codegen, which a CommonJS host such as a NestJS app can't do cleanly. So a build-time generator writes one JSON model (the tools, each call's plan, the descriptor, and the document's contract and hash) that the host commits and checks in CI, and the runtime, dual ESM and CommonJS with only the client as a dependency, serves that and refuses a model format or contract it can't read rather than serve tools it misreads.

## Consequences

Nothing reads a live document: an API change needs a regenerated model, and the model repeats some schema between tools.
