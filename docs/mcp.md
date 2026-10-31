# MCP tools

`@haddowg/json-api-mcp` turns a JSON:API server's OpenAPI document into [Model Context Protocol](https://modelcontextprotocol.io) tools: one per collection, resource, related and custom action operation. A generator reads the document at build time and writes one JSON model, which you commit beside your spec. At runtime the package serves the tools from that model.

The package doesn't run an MCP server. It hands your server a list of tool definitions and a function that runs a call, and your server registers them with its own `tools/list` and `tools/call` handlers. Calls go through the [client](reads.md), which serialises the query, negotiates profiles and maps error documents.

```bash
npm install @haddowg/json-api-mcp @haddowg/json-api-client
npm install --save-dev @haddowg/json-api-codegen
```

The runtime has no dependency on `@modelcontextprotocol/sdk`. Its tool and result types are written to match the SDK's, so they assign to the SDK's `Tool` and `CallToolResult` directly.

## Generate the model

Run the generator against your committed spec and commit what it writes, the same way you commit a generated client:

```bash
npx @haddowg/json-api-mcp --input openapi/v5.json --output src/mcp/v5.mcp.json
```

Add the same command with `--check` to CI. It exits 1 when the committed model no longer matches the spec, and passes when only whitespace differs, so your formatter can touch the file. `--default-page-size <n>` sets the page size a list tool asks for when the model gives none, 10 by default.

`--include-depth <n>` sets how many relationships deep a tool's `include` may reach, 1 by default. A tool lists and accepts only the include paths its operation declares up to that depth, and its output schema covers only the types those paths reach. In a well-connected API most types are a few relationships from any other, so the full declared paths put nearly every type in nearly every tool, and each `tools/list` repeats them. At depth 1, `albums_get` takes `artist` and `tracks` and leaves out `tracks.playlists`. `--include-depth all` keeps every declared path, which is how models before format 3 behaved. `0` leaves the `include` argument out altogether.

The generator reads a URL or a file, JSON or YAML, and builds the descriptor with `@haddowg/json-api-codegen`, which it needs as a dev dependency. It's also a function, from the `@haddowg/json-api-mcp/generate` entry point:

```ts
import { generateMcpModel, writeMcpModel } from '@haddowg/json-api-mcp/generate'

await writeMcpModel({ input: 'openapi/v5.json', output: 'src/mcp/v5.mcp.json', includeDepth: 2 })
const model = await generateMcpModel(document) // in memory
```

`includeDepth` is the option's name in all three functions, with `null` for every declared path. `buildMcpModel(document, descriptor, { hash })` from the same entry point takes a descriptor you already have, such as a generated client's `resourceMap`, and needs no codegen.

The generator throws when the document's generator contract is outside the range the package reads, 13 to 19 (`MINIMUM_CONTRACT`, `MAXIMUM_CONTRACT`). It throws too when a type that names links also has an attribute or relationship called `links`, since a flattened resource holds its links under that name. It also throws a `ToolNameError` listing every tool name over 64 characters, with a character outside `[a-zA-Z0-9_-]`, or shared by two operations. An action whose every request media type is one a model can't send, such as a binary upload, is left out and listed in the model's `skipped` with the reason.

### What the model holds

- `format` and `generator`: the model's own format and the package that wrote it.
- `contract` and `source`: the document's generator contract, its title and version, and a content hash of the document.
- `baseUrl`: the document's first server, the default base URL.
- `credentialSchemes`: the names of the document's `oauth2` security schemes, the ones an MCP caller authenticates with. It's empty when the document has none.
- `security`: the document's `security`, when it declares one.
- `includeDepth`: how many relationships deep a tool's `include` may reach, `null` for no limit.
- `resourceLinks`: per type, the names of the links it declares, its declared links and action links. A type that names none is left out.
- `descriptor`: the json-api-ts descriptor the client calls through. The client can't make a call without one, so the model carries it.
- `tools`: per tool, the MCP definition, the plan the handler follows to turn arguments into a client call, the shape of its result, and the operation the hooks see.
- `skipped`: the operations that didn't become a tool, and why.

An operation keeps its id, summary, description, tags and vendor extensions such as `x-feature`. Its `parameters`, `requestBody` and `responses` are left out: the tool already holds what they say, and they can refer to components the model doesn't carry. Its `security` is stored once, beside the operation object, and only when the operation declares its own; an operation without one takes the model's `security`. At load time the runtime puts `security` back on the operation object and reads `scopes`, the OAuth scopes the operation needs, from the descriptor, so hooks see both as the document writes them.

## Load it at runtime

The runtime entry point is built for both ESM and CommonJS and loads only the client, so a CommonJS server can `require` both the package and the model:

```ts
const { createJsonApiMcp } = require('@haddowg/json-api-mcp')

const mcp = createJsonApiMcp({
  model: require('./mcp/v5.mcp.json'),
  baseUrl: 'https://api.example.com/api/v5',
})
```

From ESM, read the file and `JSON.parse` it, or import it with `with { type: 'json' }`. `createJsonApiMcp` checks the model first. It throws an `McpModelError` for a file another tool wrote, a model format it doesn't know, or a contract outside 13 to 19, so a model generated by a newer package fails at startup rather than serving tools it misreads. The runtime reads formats 1 to 4. A format 1 model doesn't record `credentialSchemes`, so the runtime takes them to be the schemes its operations list scopes under. A model before format 3 has no include depth, so its tools take any include path, as they did. A model before format 4 has no `resourceLinks`, and its output schemas describe the results before the [envelope](#results), so its tools return those older shapes and no resource links. Regenerate an older model to pick up all three.

!!! note "Nest and other CommonJS hosts in watch mode"
    A watch-mode build, such as `nest start --watch` with the model listed as an asset, can copy assets after the app has started, so a `require` at module load may run before the model is in the output folder. Load the model lazily on first use, or `require` it from a path resolved at runtime, such as `path.join(__dirname, 'mcp/v5.mcp.json')`, rather than from a top-level import the build resolves:

    ```ts
    let mcp
    function getMcp() {
      mcp ??= createJsonApiMcp({ model: require(path.join(__dirname, 'mcp/v5.mcp.json')) })
      return mcp
    }
    ```

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
| list, to-many related | `id` of the parent for a related read, `filter`, `sort`, `include` where the operation has paths to include, `fields`, `pageSize`, `pageLink`, and `withCount` where the endpoint counts itself |
| get, to-one related | `id`, `include` where the operation has paths to include, `fields` |
| create | the client id when the type takes one, then the attributes and relationships as one flat object |
| update | `id`, the attributes and relationships, and `clear` |
| delete | `id` |
| action | `id` at resource scope, then the body |

- `filter` is one object with a member per filter the operation documents, each with its description. A range filter takes `min` and `max`.
- `sort` is a list of the operation's sort tokens, `-` first for descending.
- `include` lists the paths the tool accepts as an enum, the ones the operation declares up to the include depth. A tool with none has no `include`. The handler refuses any other path as a tool error before it calls the API.
- `fields` carries one generic description and no per-type lists of names. The output schema names the fields, and a wrong name comes back as the API's error.
- `pageSize` maps to the paginator's size key, whichever strategy answers, so it's `page[size]` for page and cursor pagination and `page[limit]` for offset. It's capped at the operation's maximum, and defaults to 10 (`defaultPageSize`).
- `withCount` is offered when the endpoint advertises the Countable profile with `_self_`, a count of the collection itself. `true` sends `withCount=_self_` with the profile negotiated, and the total comes back in `meta`. Counting can be slow on a large collection, which is why it's off unless asked for.
- `pageLink` takes a link from a previous result's `links`. The handler follows it only when it has the base URL's origin and the tool's own path, and ignores every other argument when it does. Anything else is a tool error, sent nowhere.
- A relationship takes an id, or a list of ids for a to-many. A polymorphic relationship takes the type and id of each resource. That includes a polymorphic relationship over one type, which the descriptor marks `polymorphic`, so adding a second type later doesn't change the tool's input.
- On an update, `null` keeps a field's value. `clear` names the nullable fields to set to `null`.
- A custom action whose body is a JSON:API document for a known type takes it flat, like a create. Any other body is one `body` argument, in the first of these the action accepts: JSON:API, JSON, text, then a form or multipart body whose fields are documented.

## Results

Every result's `structuredContent` is an envelope shaped like a JSON:API document, and its text content is the same JSON.

| Tool | `structuredContent` |
|---|---|
| get, create, update, to-one related | `{ data, meta? }`, with `data` the flattened resource, or `null` for a to-one related read with nothing related |
| list, to-many related | `{ data, links, meta? }`, with `data` the flattened resources |
| delete | `{ data: null, meta? }` |
| action returning a resource or resources | `{ data, meta? }` or `{ data, links, meta? }`, as above |
| action returning only meta | `{ meta }`, with no `data` |
| action answering with a URL | `{ data: { url, type, expiresAt? } }` |

`meta` is the document's own meta, page totals included, and is there only when the API sends it. The top-level `links` only appears on a collection and only carries pagination: `first`, `prev`, `next` and `last`, each a URL string. A resource's own links live inside the resource.

A resource comes back flattened: `id`, `type`, its attributes, and each relationship as an id (ids for a to-many, type and id for a polymorphic one, even over one type), or as the flattened related resource when it was included. A related resource more relationships from the result than the include depth comes back as its id even when the document holds it, as a server's default includes can make it. Resource meta is dropped.

A flattened resource keeps the links its type names under `links`: its declared links, such as a presigned upload URL, and its action links. Generic links such as `self`, `related` and `describedby` are dropped. Each link is `{ href, type?, title?, meta? }`, and a link the server sends as a bare URL string comes back as `{ href }`. A link absent from the response, or `null`, is left out, and a resource with none of its links has no `links` member. So a create that answers with a pending file and its upload link returns:

```json
{
  "data": {
    "id": "f-1",
    "type": "files",
    "status": "PENDING_UPLOAD",
    "links": {
      "upload": {
        "href": "https://storage.example.com/f-1?signature=abc",
        "type": "application/pdf",
        "meta": { "method": "PUT", "headers": { "Content-Type": "application/pdf" }, "expiresAt": "2026-10-30T12:00:00+00:00" }
      }
    }
  }
}
```

Each tool has an `outputSchema` built from the descriptor and the document's resource schemas, with attributes optional because of sparse fieldsets, and descriptions kept but examples left out. Its `$defs` hold only the result's own types and the types its include paths reach, so a relation to any other type is described as an id. Each named link is typed from the document's link schema, meta members included. An action without a body in its response, or one answering in a raw media type, returns content only: text, an image, or an embedded resource for other binary bodies.

An action that answers with a URL, such as a short-lived download link, returns it as `data`, with `expiresAt` left out when the URL doesn't expire. The tool never fetches the URL; the model or the host decides what to do with it. An action that answers with either its own document or a URL gets an `outputSchema` whose `anyOf` holds both envelopes, and returns whichever the server sent.

### Migrating from 1.2

1.3 wraps every result in the envelope, and a model it generates is format 4.

- A get or to-one related read returns `{ data }` where it returned `{ item }`.
- A create or update returns `{ data }` instead of the bare resource.
- A collection returns `{ data, links, meta }` instead of `{ items, links, meta }`.
- A delete returns `{ data: null }` as structured content instead of a line of text.
- A meta-only action returns `{ meta }` instead of the bare meta object, and a URL action `{ data: { url, type, expiresAt? } }` instead of the bare object.
- A resource carries the links its type names under `links`.

A 1.3 runtime still loads a model 1.2 generated and returns the 1.2 shapes its output schemas describe, without resource links, so upgrading the package changes nothing until you regenerate the model. Read results from `data` once you do.

A failed call is a tool error whose text is JSON with the message, the HTTP status and each error's `code`, `detail`, `source`, and `path`, the argument it's about, such as `title` or `releaseInfo.label`.

## Annotations

| Tool | Hints |
|---|---|
| list, get, related | `readOnlyHint: true` |
| create, update | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` |
| delete | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true` |
| action | whatever it declares, else none |

An action declares its safety on its operation as `x-safety`, an object holding whichever of `readOnly`, `destructive` and `idempotent` it declares. The codegen copies the same flags onto the action's descriptor entry. The package reads both, and the operation's `x-safety` wins where they differ. `readActionSafety()` reads the extension, and `SAFETY_EXTENSION` names it.

## Hooks

The hooks are where a host plugs in what the package doesn't know: its scopes, its features, its auth. Each receives the operation, which carries the descriptor entry and the raw OpenAPI operation with its vendor extensions, and the `context` the host passed to `forRequest`. All are optional.

| Hook | Called | For |
|---|---|---|
| `scopeMatcher(granted, required)` | per applicable security requirement, with `grantedScopes` | the host's scope rules; defaults to an exact match |
| `capabilities(ctx)` | once per tool list | `allowed`, `denied` or `depends` per `operationId`; `denied` drops the tool |
| `includeOperation(op, ctx)` | per operation, when the tool list is built | any other filter, such as a feature gate read from a vendor extension |
| `decorateTool(tool, op, ctx)` | per tool, after it's built | extra description, annotations or `_meta` |
| `requestInit(op, ctx)` | per call | `headers` and `baseUrl` |
| `mapError(error, op, ctx)` | per failed call | rewriting or enriching the tool error |

The tool list is filtered by scopes, then capabilities, then `includeOperation`. `callTool` runs only the tools left in the list, so a tool the filter drops can't be called either.

```ts
const mcp = createJsonApiMcp<{ token: string; features: string[] }>({
  model,
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

## Scopes and credential schemes

Scopes are read from each operation's `security`, else the document's. Each entry is an alternative, and an operation passes the filter when one of the alternatives that apply to an MCP caller passes. An alternative applies when every scheme it names is a credential scheme, meaning one the caller authenticates with. One naming any other scheme, such as a session cookie or an API key, is ignored, because the caller has no way to present it. An applicable alternative passes when `scopeMatcher` accepts its scopes, or when it lists none.

So an operation secured by `[{ oauth2: ['accounts:read'] }, { session: [] }]` is listed only for a caller granted `accounts:read`. An operation whose `security` is empty, or offers an empty `{}` alternative, is public and always listed. An operation with a non-empty `security` and no applicable alternative is left out.

The credential schemes default to the model's `credentialSchemes`, the document's `oauth2` schemes. Pass `credentialSchemes` to `createJsonApiMcp` to change them, for instance when your OAuth tokens are also accepted under an `http` bearer scheme or the caller presents an API key:

```ts
const mcp = createJsonApiMcp({ model, credentialSchemes: ['oauth2', 'bearer'] })
```

A document with no `oauth2` scheme records none, and the filter then counts every alternative whatever its scheme: an operation passes when any one alternative's scopes match, and an alternative listing no scopes always passes, so a bearer-only document leaves every tool in. Pass `credentialSchemes` to filter such a document by credential too. `mcp.credentialSchemes` holds the list in use, `undefined` when every alternative counts.

Omitting `grantedScopes` from `forRequest` skips this filter entirely, credential schemes included.

Passing `null` grants no scopes, the same as `[]`. The filter fails closed, so the caller sees only public operations and those whose applicable alternative lists no scopes. This differs from core's `GrantedScopesProviderInterface`, where a null grant means the caller is unrestricted. Here, leaving `grantedScopes` out or passing `undefined` is the only way to switch filtering off.

The server writes the scopes it enforces into each operation's `security` under its `oauth2` scheme, so a related read lists the scopes of the type it returns as well. The operation's `scopes` holds the same list for a hook to read, and is absent when it needs none.
