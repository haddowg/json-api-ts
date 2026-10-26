# 0014 — MCP tools are definitions plus a handler, with portable strict inputs

- **Status:** Accepted
- **Date:** 2026-10-26

`@haddowg/json-api-mcp` returns tool definitions and a call handler instead of an MCP server,
and types them structurally instead of importing `@modelcontextprotocol/sdk`. A host already has
a server, with its own transport, auth and rate limits, and the SDK brings express, hono, zod and
a dozen more packages. The structural types are aliases written to assign to the SDK's `Tool` and
`CallToolResult`, and a test holds them to that, so the package depends only on the client.

Every input schema is valid under both OpenAI's strict function calling and Anthropic's strict
tool use, because a host can't know which model its client sends the tools to. OpenAI's strict
mode requires every property, so a parameter the API doesn't require is nullable and `null`
means "not given". That costs one argument: an update can't set a field to `null` by passing
`null`, so it takes a `clear` list of the nullable fields to null instead. Constraints strict
mode won't take move into descriptions, and a value with no strict-mode shape is taken as JSON
text. A tool whose every request body is binary is left out, since no model can send one.
