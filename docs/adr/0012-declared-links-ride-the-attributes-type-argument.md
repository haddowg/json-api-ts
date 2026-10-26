# 0012 — Declared links ride the attributes type argument

- **Status:** Accepted
- **Date:** 2026-10-26

Generator contract 14 names the links a resource type declares, such as a signed upload URL with
its meta, so a read result's `$links` can be typed per type. The client threads the attributes
map `A` through every result type, and `json-api-query` gets `A` by inferring it from the
client. A separate links type argument would have meant adding it to every type that takes `A`,
and teaching the query bindings to infer it too. Instead the generated `Links` map is passed to
`createClient` as a sixth type argument and the client folds it into `A` under a `$declaredLinks`
key (`WithLinks<A, L>`), where `ResourceObjectView` reads it back for `$links`. Nothing else
changes, and the query and Angular bindings pick up the typed links without edits. The key is a
string because `$` can't appear in a wire type's name. A symbol key was tried first, but an app
that exports its bound query API then fails declaration emit, since TypeScript can't name the
symbol from the app's module.

The cost is that `A` is no longer always just the attribute map. A hand-written
`ReadResult<ResourceMap, Attributes, 'files'>` still compiles, but its `$links` falls back to the
loose `ResourceLinks`; it needs `WithLinks<Attributes, Links>` to see the declared ones. A type
that declares no links keeps the loose `ResourceLinks` either way. Meta values are passed through
as the wire carries them, as attribute values are, so a `date-time` member is a `string`.
