# Declared links ride the attributes type argument

The client already threads the attributes map `A` through every result type and the query bindings infer it, so the generated `Links` map is `createClient`'s sixth type argument, folded into `A` under a `$declaredLinks` string key (`WithLinks<A, L>`) where `ResourceObjectView` reads it back to type `$links`. A separate links type argument would have touched every type that takes `A` and the bindings' inference, and a symbol key breaks declaration emit for an app that exports its bound query API.

## Consequences

`A` is not always just the attribute map: a hand-written `ReadResult` sees declared links only through `WithLinks<Attributes, Links>`, and otherwise falls back to the loose `ResourceLinks`.
