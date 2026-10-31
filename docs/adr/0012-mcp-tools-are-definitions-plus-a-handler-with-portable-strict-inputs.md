# MCP tools are definitions plus a handler, with portable strict inputs

`@haddowg/json-api-mcp` returns tool definitions and a call handler rather than an MCP server, typed structurally rather than importing `@modelcontextprotocol/sdk`, because a host already has a server with its own transport, auth and rate limits, and the SDK brings a dozen more packages; a test holds the structural types assignable to the SDK's. Every input schema is valid under both OpenAI's and Anthropic's strict tool modes, because a host can't know which model it serves, so a parameter the API doesn't require is nullable with `null` meaning "not given".

## Consequences

An update can't null a field by passing `null`, so it takes a `clear` list instead. Constraints strict mode rejects move into descriptions, and a tool whose every request body is binary is left out.
