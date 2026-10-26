# MCP tools

`@haddowg/json-api-mcp` turns a JSON:API server's OpenAPI document into [Model Context Protocol](https://modelcontextprotocol.io) tools: one per collection, resource, related and custom action operation. It builds them at runtime, so a host that fetches the server's document gets tools that follow the API without a codegen step.

The package doesn't run an MCP server. It hands your server a list of tool definitions and a function that runs a call, and your server registers them with its own `tools/list` and `tools/call` handlers. Calls go through the [client](reads.md), which serialises the query, negotiates profiles and maps error documents.

```bash
npm install @haddowg/json-api-mcp @haddowg/json-api-client
```

It has no dependency on `@modelcontextprotocol/sdk`. Its tool and result types are written to match the SDK's, so they assign to the SDK's `Tool` and `CallToolResult` directly.

## Build the tools

The package needs the OpenAPI document and the json-api-ts descriptor for it. A host that reads the document at runtime builds the descriptor with the codegen's `buildDescriptor`; a host with a generated client can pass its `resourceMap` instead.

```ts
import { buildDescriptor } from '@haddowg/json-api-codegen'
import { createJsonApiMcp } from '@haddowg/json-api-mcp'

const document = await (await fetch('https://api.example.com/docs.json')).json()

const mcp = createJsonApiMcp({
  document,
  descriptor: buildDescriptor(document),
  baseUrl: 'https://api.example.com',
})
```

`createJsonApiMcp` checks the document's generator contract first and throws outside the range the package reads, which is 13 to 15 (`MINIMUM_CONTRACT`, `MAXIMUM_CONTRACT`). It also throws a `ToolNameError` listing every tool name over 64 characters, with a character outside `[a-zA-Z0-9_-]`, or shared by two operations. An action whose every request media type is one a model can't send, such as a binary upload, is left out and listed in `mcp.skipped` with the reason.

## Serve them per request

Build a session per request with the caller's scopes and your own context, then answer `tools/list` with its tools and `tools/call` with its handler:

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const session = await mcp.forRequest({
  grantedScopes: token.scopes,
  context: { token: token.raw, tenant },
})

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...session.tools] }))
server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
  session.callTool(request.params.name, request.params.arguments, { signal: extra.signal }),
)
```

`callTool` only runs a tool in its session's list. Any other name, a failed request or bad arguments come back as a result with `isError: true`, never as a thrown error.

## Tool names

Names come from each operation's `operationId`, so they only change when the `operationId` does. The type comes first, exactly as the document spells it, with kebab-case turned into snake_case.

| `operationId` | Tool |
|---|---|
| `fetchCollection.albums` | `albums_list` |
| `fetchOne.albums` | `albums_get` |
| `create.albums`, `update.albums`, `delete.albums` | `albums_create`, `albums_update`, `albums_delete` |
| `fetchRelated.albums.tracks` (to-many) | `albums_tracks_list` |
| `fetchRelated.albums.artist` (to-one) | `albums_artist_get` |
| `action.albums.reissue` | `albums_reissue` |
| `action.articles.export.get`, `action.articles.export.post` (an action with several methods) | `articles_export_get`, `articles_export_post` |

Relationship endpoints and Atomic Operations aren't tools. Each tool's `_meta.operationId` carries its `operationId`, its `title` is the operation's summary and its `description` the operation's description.

## Arguments

Every input schema is accepted by both OpenAI's strict function calling and Anthropic's strict tool use. There's no `oneOf`, `allOf`, `if`, `then` or `$ref`; every object is closed and lists all its properties as required. A parameter the API doesn't require is nullable instead, and `null` means "not given". Constraints those modes don't accept, such as a length or a range, move into the description, and a value with no strict-mode shape, such as a free-form object, is taken as JSON text.

| Tool | Arguments |
|---|---|
| list, to-many related | `id` of the parent for a related read, `filter`, `sort`, `include`, `fields`, `pageSize`, `pageLink` |
| get, to-one related | `id`, `include`, `fields` |
| create | the client id when the type takes one, then the attributes and relationships as one flat object |
| update | `id`, the attributes and relationships, and `clear` |
| delete | `id` |
| action | `id` at resource scope, then the body |

- `filter` is one object with a member per filter the operation documents, each with its description. A range filter takes `min` and `max`.
- `sort` is a list of the operation's sort tokens, `-` first for descending.
- `include` and `fields` carry one generic description and no per-type lists of names. The output schema names the fields, and a wrong name comes back as the API's error.
- `pageSize` maps to the paginator's size key, whichever strategy answers, so it's `page[size]` for page and cursor pagination and `page[limit]` for offset. It's capped at the operation's maximum, and defaults to 10 (`defaultPageSize`).
- `pageLink` takes a link from a previous result's `links`. The handler follows it only when it has the base URL's origin and the tool's own path, and ignores every other argument when it does. Anything else is a tool error, sent nowhere.
- A relationship takes an id, or a list of ids for a to-many. A polymorphic relationship takes the type and id of each resource.
- On an update, `null` keeps a field's value. `clear` names the nullable fields to set to `null`.
- A custom action whose body is a JSON:API document for a known type takes it flat, like a create. Any other body is one `body` argument, in the first of these the action accepts: JSON:API, JSON, text, then a form or multipart body whose fields are documented.

## Results

A resource comes back flattened: `id`, `type`, its attributes, and each relationship as an id (ids for a to-many, type and id for a polymorphic one), or as the flattened related resource when it was included. Resource links and meta are dropped. A collection is `{ items, links, meta }`, where `links` keeps only `first`, `prev`, `next` and `last`, and `meta` is the document's own, page totals included.

Each tool has an `outputSchema` built from the descriptor and the document's resource schemas, with attributes optional because of sparse fieldsets, and descriptions kept but examples left out. Results carry `structuredContent` and the same JSON as text. A to-one related read returns `{ item }`, `null` when nothing is related. A delete, an action without a body in its response, or one answering in a raw media type returns content only: text, an image, or an embedded resource for other binary bodies.

A failed call is a tool error whose text is JSON with the message, the HTTP status and each error's `code`, `detail`, `source`, and `path`, the argument it's about, such as `title` or `releaseInfo.label`.

## Annotations

| Tool | Hints |
|---|---|
| list, get, related | `readOnlyHint: true` |
| create, update | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` |
| delete | `readOnlyHint: false`, `destructiveHint: true` |
| action | whatever it declares, else none |

An action declares its safety on its operation as `x-safety`, an object holding whichever of `readOnly`, `destructive` and `idempotent` it declares. The codegen copies the same flags onto the action's descriptor entry. The package reads both, and the operation's `x-safety` wins where they differ. `readActionSafety()` reads the extension, and `SAFETY_EXTENSION` names it.

## Hooks

The hooks are where a host plugs in what the package doesn't know: its scopes, its features, its auth. Each receives the operation, which carries the descriptor entry and the raw OpenAPI operation with its vendor extensions, and the `context` the host passed to `forRequest`. All are optional.

| Hook | Called | For |
|---|---|---|
| `scopeMatcher(granted, required)` | per security requirement, with `grantedScopes` | the host's scope rules; defaults to an exact match |
| `capabilities(ctx)` | once per tool list | `allowed`, `denied` or `depends` per `operationId`; `denied` drops the tool |
| `includeOperation(op, ctx)` | per operation, when the tool list is built | any other filter, such as a feature gate read from a vendor extension |
| `decorateTool(tool, op, ctx)` | per tool, after it's built | extra description, annotations or `_meta` |
| `requestInit(op, ctx)` | per call | `headers` and `baseUrl` |
| `mapError(error, op, ctx)` | per failed call | rewriting or enriching the tool error |

The tool list is filtered by scopes, then capabilities, then `includeOperation`. Scopes are read from each operation's `security`, else the document's. An operation passes when any one requirement passes, and a requirement listing no scopes always passes, so a bearer-only document leaves every tool in.

```ts
const mcp = createJsonApiMcp<{ token: string; features: string[] }>({
  document,
  descriptor,
  hooks: {
    includeOperation: (op, ctx) => {
      const feature = op.operation['x-feature']
      return typeof feature !== 'string' || ctx.features.includes(feature)
    },
    decorateTool: (tool, op) =>
      typeof op.operation['x-feature'] === 'string'
        ? { ...tool, description: `${tool.description} Requires the ${op.operation['x-feature']} feature.` }
        : tool,
    requestInit: (op, ctx) => ({ headers: { Authorization: `Bearer ${ctx.token}` } }),
  },
})
```
