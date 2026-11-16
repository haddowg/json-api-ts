# A singleton update takes its id in the input, and its MCP tool reads it first

A singleton is served at a path with no id, but its `PATCH` body must still carry the resource's id, which the server checks rather than fills in. The client's singleton accessor takes that id in the update input, typed as required, rather than reading the resource itself before each update, so an update stays one request and the caller, who has usually just read the resource, passes the id it already holds. The MCP update tool reads the resource first instead and takes no `id` argument, because a model has no other way to learn the id and a wrong guess costs a failed call, which matters more there than the second request.

## Consequences

The MCP update tool makes two calls, so its operation records the read's `operationId` and security beside its own, and scope filtering and the capabilities hook list the tool only for a caller allowed both. A tool that could only fail with a `403` on its read never appears, at the cost of one more field in the model that a runtime predating it ignores.
