# Reads return flattened resource objects with `$`-prefixed envelope accessors, as per-edge views

A read returns a hydrated graph whose type is computed from the `include` argument, which is tractable because the document lists each endpoint's include paths as a bounded, pre-expanded enum. Each resource object holds `type`, `id`, attributes and relations as enumerable own properties, so spreading and `JSON.stringify` are clean, and exposes its envelope through non-enumerable `$`-prefixed accessors, which can't collide because JSON:API forbids `$` in member names. Returning raw documents or store-backed handles would give up either the ergonomics or a return type that can promise hydration.

## Consequences

Each materialised related value is a per-edge view carrying its own `$edge` and `$pivot`, so identity is `type:id`, never object reference, and edge-local data must never be merged into a shared normalised node.
