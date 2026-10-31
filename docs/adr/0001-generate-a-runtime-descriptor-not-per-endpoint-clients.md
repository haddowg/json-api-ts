# Generate a runtime descriptor and derive the client's types from it, not per-endpoint client code

JSON:API's wire shape is invariant, so serialising, materialising and resolving includes is generic work and only the type catalogue varies per API. The codegen therefore emits one runtime descriptor (`as const satisfies ApiDescriptor`) carrying what types can't express at runtime, a generic runtime is parameterised by it, and every client type derives from it, a custom action's input and output included. Templating a client method per OpenAPI operation, the usual OpenAPI generator approach, gives large, brittle output that fights JSON:API's regularity.

## Consequences

The descriptor is the contract between codegen and runtime, so changing its shape is a breaking change across both packages. A custom action is typed from the descriptor's facts (method, input and output type, cardinality, output mode) rather than from aliases expanded from its request and response documents, so its typed result is the materialised resource the runtime returns; the per-action alias map survives only as a fallback type argument.
