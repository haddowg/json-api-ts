# Changelog

## 1.0.0 (2026-07-03)


### ⚠ BREAKING CHANGES

* read query types are narrower. get(id, query) no longer accepts filter/sort/page; list(query)'s filter keys and sort tokens must be ones the type's OpenAPI document advertises (an unadvertised key/token, or any filter/sort on a type that advertises none, is now a compile error). Regenerate the client from your /docs.json to pick up the new descriptor fields.

### Features

* narrow include/sort/filter to the OpenAPI-advertised values ([#16](https://github.com/haddowg/json-api-ts/issues/16)) ([0804af5](https://github.com/haddowg/json-api-ts/commit/0804af5ba66c981662d9314c3e9590cbe4ea182f))
* **query:** TanStack bindings — option factories, key factory, Strategy-2 normalization ([#10](https://github.com/haddowg/json-api-ts/issues/10)) ([ad6bf18](https://github.com/haddowg/json-api-ts/commit/ad6bf1846f7a962788a269f482e97ffe4365687c))
* **query:** type related/relationship read factories from the client's per-relation types ([#24](https://github.com/haddowg/json-api-ts/issues/24)) ([6f6a572](https://github.com/haddowg/json-api-ts/commit/6f6a572777fed29d46e1e2240ee0b7efcec44e14))


### Bug Fixes

* **query:** TanStack factories accept the generated client without a cast ([#13](https://github.com/haddowg/json-api-ts/issues/13)) ([b6db3ff](https://github.com/haddowg/json-api-ts/commit/b6db3ff4dd1e66b5f8c6678b36093669f1cf8faa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.0.0
