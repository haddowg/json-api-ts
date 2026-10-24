# Changelog

## [1.1.1](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.0...json-api-query-v1.1.1) (2026-10-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.3.0

## [1.1.0](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.0.1...json-api-query-v1.1.0) (2026-10-23)


### Features

* **angular:** type nextPage() and prevPage() by the page that answered ([99ff1e9](https://github.com/haddowg/json-api-ts/commit/99ff1e93e2889fbd7a8074ad8d86c297db92f67e))
* **client:** describe renamed page keys and strategy menus, and type $page ([99ff1e9](https://github.com/haddowg/json-api-ts/commit/99ff1e93e2889fbd7a8074ad8d86c297db92f67e))
* **client:** type the page argument from the collection's paginator ([99ff1e9](https://github.com/haddowg/json-api-ts/commit/99ff1e93e2889fbd7a8074ad8d86c297db92f67e))
* **codegen:** read the x-paginator stamp and support generator contract 3 ([99ff1e9](https://github.com/haddowg/json-api-ts/commit/99ff1e93e2889fbd7a8074ad8d86c297db92f67e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.2.0

## [1.0.1](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.0.0...json-api-query-v1.0.1) (2026-10-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.1.0

## 1.0.0 (2026-07-13)


### ⚠ BREAKING CHANGES

* read query types are narrower. get(id, query) no longer accepts filter/sort/page; list(query)'s filter keys and sort tokens must be ones the type's OpenAPI document advertises (an unadvertised key/token, or any filter/sort on a type that advertises none, is now a compile error). Regenerate the client from your /docs.json to pick up the new descriptor fields.

### Features

* narrow include/sort/filter to the OpenAPI-advertised values ([#16](https://github.com/haddowg/json-api-ts/issues/16)) ([0804af5](https://github.com/haddowg/json-api-ts/commit/0804af5ba66c981662d9314c3e9590cbe4ea182f))
* **query:** optimistic relationship membership by key prefix ([#31](https://github.com/haddowg/json-api-ts/issues/31)) ([1d611dc](https://github.com/haddowg/json-api-ts/commit/1d611dc056b6c709126bd2966b0b58a5e45cddc5))
* **query:** TanStack bindings — option factories, key factory, Strategy-2 normalization ([#10](https://github.com/haddowg/json-api-ts/issues/10)) ([ad6bf18](https://github.com/haddowg/json-api-ts/commit/ad6bf1846f7a962788a269f482e97ffe4365687c))
* **query:** type related/relationship read factories from the client's per-relation types ([#24](https://github.com/haddowg/json-api-ts/issues/24)) ([6f6a572](https://github.com/haddowg/json-api-ts/commit/6f6a572777fed29d46e1e2240ee0b7efcec44e14))


### Bug Fixes

* **query:** TanStack factories accept the generated client without a cast ([#13](https://github.com/haddowg/json-api-ts/issues/13)) ([b6db3ff](https://github.com/haddowg/json-api-ts/commit/b6db3ff4dd1e66b5f8c6678b36093669f1cf8faa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.0.0
