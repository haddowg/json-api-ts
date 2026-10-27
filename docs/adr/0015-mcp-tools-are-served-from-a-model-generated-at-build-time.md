# 0015 — MCP tools are served from a model generated at build time

- **Status:** Accepted
- **Date:** 2026-10-27

`@haddowg/json-api-mcp` first built its tools at runtime from the OpenAPI document and a
descriptor. That made every host load the codegen to build the descriptor, and the codegen is
ESM only and reads the document's components, so a CommonJS server such as a NestJS app had to
pull an ESM-only package into its runtime. The package now has a build-time generator, the
`json-api-mcp` CLI and the `@haddowg/json-api-mcp/generate` entry point, that writes one JSON
model, and the runtime serves only that. The host commits the model beside its spec and checks
it in CI, as it does a generated client.

The model carries the tools, the plan each call follows, and the descriptor, because the
client's `createClient` can't make a call without one. It records the document's generator
contract and content hash, and the runtime throws on a model format or contract it can't read
rather than serve tools it misreads. It's JSON, not a TypeScript module, so a CommonJS host can
`require` it and the runtime entry stays dual ESM and CommonJS with the client as its only
dependency. The codegen is an optional peer of the generator only. What we gave up is reading a
live document: a host whose API changes needs a regenerated, recommitted model to see it, and
the model repeats some schema between tools, which makes it larger than the document's own
schemas.
