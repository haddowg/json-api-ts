# @haddowg/json-api-mcp

> **Part of the [jsonapi.rest](https://jsonapi.rest) suite** — a complete, spec-compliant
> JSON:API 1.1 stack: a framework-agnostic PHP [core](https://github.com/haddowg/json-api), a
> [Symfony bundle](https://github.com/haddowg/json-api-symfony), a
> [Laravel package](https://github.com/haddowg/json-api-laravel), and the **typed TypeScript
> client**, bound together by one conformance-tested OpenAPI 3.1 contract.
> Full documentation: **[haddowg.github.io/json-api-ts](https://haddowg.github.io/json-api-ts/)**.

MCP tool definitions and a call handler for a `haddowg/json-api` server. A build-time
generator turns the server's OpenAPI document into one JSON model, which you commit; the
runtime serves one tool per collection, resource, related and custom action operation from it,
with input schemas valid under OpenAI's and Anthropic's strict modes. Calls run through
[`@haddowg/json-api-client`](../client). The package doesn't own an MCP server: the host lists
the tools and passes calls to the handler.

## Install

```bash
npm install @haddowg/json-api-mcp @haddowg/json-api-client
npm install --save-dev @haddowg/json-api-codegen
```

## Generate the model

```bash
npx json-api-mcp --input openapi/v5.json --output src/mcp/v5.mcp.json
npx json-api-mcp --input openapi/v5.json --output src/mcp/v5.mcp.json --check # in CI
```

## Serve it

The runtime loads from ESM or CommonJS and needs only the client.

```ts
const { createJsonApiMcp } = require('@haddowg/json-api-mcp')

const mcp = createJsonApiMcp({ model: require('./mcp/v5.mcp.json') })
const session = await mcp.forRequest({ grantedScopes: token.scopes, context: { token } })
session.tools // answer tools/list with these
await session.callTool('albums_list', { sort: ['-releasedAt'], pageSize: 5 })
```

Scope filtering counts only the security requirements a caller can meet with its credential
schemes, the document's `oauth2` schemes unless you pass `credentialSchemes`. Scopes, feature
gates, headers and error hints come from optional hooks: `scopeMatcher`, `capabilities`,
`includeOperation`, `decorateTool`, `requestInit` and `mapError`. See the
[MCP tools guide](https://haddowg.github.io/json-api-ts/mcp/).
