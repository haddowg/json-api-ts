# json-api-ts

A typed TypeScript client for `haddowg/json-api` servers: a codegen reads a server's OpenAPI
document into a descriptor, and a generic runtime, with TanStack Query, Angular and MCP bindings,
does the work. Server-side concepts are defined in
[haddowg/json-api's CONTEXT.md](https://github.com/haddowg/json-api/blob/main/CONTEXT.md).

## Language

### Generation

**Descriptor**:
The generated runtime object (`resourceMap`, typed by `ApiDescriptor`) describing each resource
type's attributes, relations, paths, paginators and actions, from which every client type derives.
_Avoid_: resource map, endpoint map, schema

**Generated client**:
The module the codegen writes and the app commits: the descriptor, the attribute interfaces and a
bound `createClient`, one per server.
_Avoid_: SDK, generated package

**Schemas module**:
The opt-in sibling module (`--schemas`) holding a per-type JSON Schema map for the validation seam.

**Examples module**:
The opt-in sibling module (`--examples`) holding each operation's worked request and response
examples as `ApiExamples`.

**Generator contract**:
The integer `info.x-generator.contract` a document carries, which the codegen and the MCP runtime
check against the range they read.
_Avoid_: spec version, schema version

**Provenance stamp**:
The header of a generated file naming its source document, server and content hash, which drift
checking compares.

**Verb collision**:
A relation named like a reserved handle member, which is reachable only through `.rel(name)`.

### Reading

**Resource object**:
The runtime value for one resource: `type`, `id`, attributes and relations as enumerable
properties, with its envelope behind `$`-accessors.
_Avoid_: entity, model, record

**`$`-accessor**:
A non-enumerable, `$`-prefixed member of a resource object or collection that exposes envelope
data, such as `$meta`, `$links`, `$document`, `$edge`, `$pivot`, `$rel` or `$page`.

**Materialisation**:
The conversion of a JSON:API document into resource objects and collections.
_Avoid_: deserialisation, parsing

**Hydration**:
The part of materialisation that places a response's `included` resources into relation slots.

**Identifier**:
A `{ type, id }` reference standing in a relation slot for a related resource that wasn't included.
_Avoid_: ref, stub

**Augmented array**:
A real array that also carries `$page`, `$links`, `$meta`, `$next()` and `$prev()`; the shape of
every collection and to-many relation value (`Collection`).
_Avoid_: list result, paged list

**Edge**:
One relationship instance between two resources, whose links and meta a related value carries as
`$edge`.
_Avoid_: link, association

**Per-edge view**:
A materialised related value, distinct for each membership, that reads through to the resource's
data but carries its own `$edge` and `$pivot`.

**Pivot**:
The per-edge data of a many-to-many membership, read as `$pivot`.

**Paginator**:
The descriptor's account of how a collection pages: a strategy with its keys, or a menu of
strategies with a default arm.
_Avoid_: pagination kind

**Menu**:
A paginator offering several strategies, one picked per request by `kind` in `page`.

### Writing

**Type accessor**:
`client.<type>`, the collection-scoped entry for listing, creating and collection actions.

**Handle**:
The id-scoped accessor `client.<type>.id(id)`, which reads, writes and opens relations without
fetching anything first.
_Avoid_: reference, proxy

**Relationship accessor**:
The object `.rel(name)` returns from a handle, carrying a relation's reads and mutation verbs.

**Flat input**:
Write input given as plain attribute and relation members, which the client wraps in a JSON:API
document.
_Avoid_: payload, body

**User path**:
The flat input path, such as `releaseInfo.label` or `orderedTracks[0].$pivot.position`, that an
error's `source.pointer` is remapped to.

**Action location**:
The `{ url, type, expiresAt? }` value an action that answers with a URL returns.

**Atomic handle**:
The value a `tx.create` in `client.atomic()` returns, which doubles as a `{ type, lid }` relation
reference for later operations in the batch.

### Runtime seams

**Transport**:
The `fetch`-shaped function every request goes through.
_Avoid_: HTTP client, adapter

**Structural guard**:
The light check every parsed response passes before materialisation.

**Validation seam**:
The opt-in `validate` client option that checks each resource against its type's JSON Schema.

**Bound guard**:
The generated `hasErrorCode`, restricted to the documented `ErrorCode` union, as against the
runtime's unbound one.

### Query bindings

**Normalisation**:
The `type:id` index `json-api-query` keeps over cached results, through which a changed resource is
patched into every cached query that holds it.
_Avoid_: normalised store, entity cache

**Option factory**:
A function returning TanStack query or mutation options for one client operation, the binding's
whole surface in place of hooks.

### MCP

**MCP model**:
The JSON file the MCP generator writes and the runtime serves tools from: tools, call plans and the
descriptor.
_Avoid_: manifest, tool registry

**Model format**:
The integer version of the MCP model's own shape.

**Call plan**:
A tool's recorded recipe for the client call it makes.

**Credential scheme**:
A security scheme an MCP caller authenticates with; only requirements naming such schemes count
when filtering tools by scope.

**Include depth**:
The cap on how many relationships deep a tool's `include` may reach.

**Flattened resource**:
A resource in an MCP result: `id`, `type`, attributes, relations as ids, and the links its type
names.
