# 0001 — Generate a runtime descriptor with types derived from it, not per-endpoint client code

- **Status:** Accepted
- **Date:** 2026-06-27

JSON:API's wire shape is invariant, so all real work — serialise, deserialise,
normalise, resolve includes — is generic runtime machinery; only the *type catalogue*
varies per API. We therefore generate a single **runtime descriptor object** (`as const
satisfies ApiDescriptor`) carrying what types alone can't express at runtime
(attribute-vs-relation, cardinality, related type(s), per-operation path templates that
respect `uriType`/server prefixes, paginator kind, create client-id policy), and
**derive the TypeScript types from it**. The generic runtime in `json-api-client` is
parameterised by this descriptor; the codegen only *reads* the OpenAPI spec — it never
templates per-path client code.

The alternative, templating a client method per OpenAPI operation (the typical OpenAPI
3.1 generator), produces large, brittle output and fights JSON:API's regularity. The
descriptor approach yields tiny generated output, sidesteps most 3.1-generator pain, and
is genuinely JSON:API-idiomatic.

Consequence: the descriptor is the contract between codegen and runtime, so its shape is
load-bearing and changing it is a breaking change across both packages. We accept that
coupling in exchange for a minimal, uniform, fully-generic runtime.
