# @haddowg/json-api-mcp

> **Part of the [jsonapi.rest](https://jsonapi.rest) suite** — a complete, spec-compliant
> JSON:API 1.1 stack: a framework-agnostic PHP [core](https://github.com/haddowg/json-api), a
> [Symfony bundle](https://github.com/haddowg/json-api-symfony), a
> [Laravel package](https://github.com/haddowg/json-api-laravel), and the **typed TypeScript
> client**, bound together by one conformance-tested OpenAPI 3.1 contract.
> Full documentation: **[haddowg.github.io/json-api-ts](https://haddowg.github.io/json-api-ts/)**.

MCP tool definitions and a call handler for a `haddowg/json-api` server, built at runtime from
its OpenAPI document and the json-api-ts descriptor. One tool per collection, resource, related
and custom action operation, with input schemas valid under OpenAI's and Anthropic's strict
modes. Calls run through [`@haddowg/json-api-client`](../client). The package doesn't own an MCP
server: the host lists the tools and passes calls to the handler.

## Install

```bash
npm install @haddowg/json-api-mcp @haddowg/json-api-client
```

## Use

```ts
import { buildDescriptor } from '@haddowg/json-api-codegen'
import { createJsonApiMcp } from '@haddowg/json-api-mcp'

const mcp = createJsonApiMcp({ document, descriptor: buildDescriptor(document) })

const session = await mcp.forRequest({ grantedScopes: token.scopes, context: { token } })
session.tools // answer tools/list with these
await session.callTool('albums_list', { sort: ['-releasedAt'], pageSize: 5 })
```

Scopes, feature gates, headers and error hints come from optional hooks: `scopeMatcher`,
`capabilities`, `includeOperation`, `decorateTool`, `requestInit` and `mapError`. See the
[MCP tools guide](https://haddowg.github.io/json-api-ts/mcp/).
