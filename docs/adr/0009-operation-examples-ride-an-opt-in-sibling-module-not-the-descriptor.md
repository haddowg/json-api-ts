# Operation examples ride an opt-in sibling module, not the descriptor

A tool that describes each operation, such as an MCP server, wants its worked examples, but the descriptor is runtime data every app ships to the browser and the examples are several times the size of the client. So they go to `<output>.examples.gen.ts`, written only with `--examples` and typed by `ApiExamples`, while an action's JSDoc still carries one `@example`, since a hover costs nothing at runtime.

## Consequences

Examples are off by default, and a CRUD method's hover shows none because those methods come from the generic runtime.
