# Relations share the resource handle with the verbs, and a colliding relation is reachable only through `.rel()`

A handle exposes plain verbs (`get`, `update`, `delete`, `actions`, …) and each relation as a bare property beside them, so the common case reads `client.albums.id(id).tracks`, with `.rel(name)` as the form that always works. A relation named like a reserved member is shadowed and reachable only through `.rel(name)`, with a build-time warning, rather than prefixing every relation or every verb to make collisions impossible.

## Consequences

Whether a relation is reachable by property depends on its name, so code that must work for any relation uses `.rel(name)`.
