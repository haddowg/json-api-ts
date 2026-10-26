# 0011 — Operation examples ride an opt-in sibling module, not the descriptor

- **Status:** Accepted
- **Date:** 2026-10-26

Generator contract 12 puts a whole worked example on every operation's request and success
responses. A tool that describes each operation, such as an MCP server, wants them without
reading the OpenAPI document. The obvious home is the descriptor, but `resourceMap` is runtime
data passed to `createClient`, so every app would ship the examples to the browser. For the
music catalog they are about 230 KB of generated source against a 50 KB client. They go to a
sibling `<output>.examples.gen.ts` instead, written only with `--examples`, the way `--schemas`
writes the validation map, and typed by the client's `ApiExamples`. An action's JSDoc still
carries one `@example`, because a hover is where a developer looks and it costs nothing at
runtime.

We gave up having the examples on by default. A consumer that wants them has to pass the flag,
and a CRUD method's hover shows none because those methods come from the generic runtime, not
from generated code.
