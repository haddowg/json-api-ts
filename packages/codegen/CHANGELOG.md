# Changelog

## 1.0.0 (2026-07-13)


### ⚠ BREAKING CHANGES

* **client:** a document action's generated input is now flat resource input (not the raw envelope) and its result is the materialised resource (not the raw document); regenerate the client to pick up the new types.
* read query types are narrower. get(id, query) no longer accepts filter/sort/page; list(query)'s filter keys and sort tokens must be ones the type's OpenAPI document advertises (an unadvertised key/token, or any filter/sort on a type that advertises none, is now a compile error). Regenerate the client from your /docs.json to pick up the new descriptor fields.

### Features

* **client:** carry per-relation withCount + report the real empty-page kind ([#22](https://github.com/haddowg/json-api-ts/issues/22)) ([1b8f082](https://github.com/haddowg/json-api-ts/commit/1b8f082a3132da22e0267c6a74b11511762e6a98))
* **client:** custom actions + atomic transaction builder + per-relation verb gating ([#7](https://github.com/haddowg/json-api-ts/issues/7)) ([3c7e15e](https://github.com/haddowg/json-api-ts/commit/3c7e15e5a41a1e91569f5a23e4ca2c91e9137822))
* **client:** derive the custom-action surface from the descriptor ([#20](https://github.com/haddowg/json-api-ts/issues/20)) ([f66d6d4](https://github.com/haddowg/json-api-ts/commit/f66d6d40984ef5c12d44051796b76b38e63a3677))
* **client:** finalize reads — sparse fieldsets, withCount, cursor, content negotiation ([#9](https://github.com/haddowg/json-api-ts/issues/9)) ([9974b55](https://github.com/haddowg/json-api-ts/commit/9974b5537ced8b51f3924b67daaab303bf165cf7))
* **client:** the read runtime — transport, materialise, pagination, typed fluent reads ([#4](https://github.com/haddowg/json-api-ts/issues/4)) ([662c40b](https://github.com/haddowg/json-api-ts/commit/662c40bf387820b39ce6bf698b1f005016bef356))
* **client:** type meta.pivot from the descriptor instead of erasing it to a boolean ([#23](https://github.com/haddowg/json-api-ts/issues/23)) ([424c4f3](https://github.com/haddowg/json-api-ts/commit/424c4f3d26887761a02f05894dc058dbb9e96627))
* **client:** writes — flat-input envelope, pointer remapping, create/update/delete + relationship mutation ([#6](https://github.com/haddowg/json-api-ts/issues/6)) ([2e4afc9](https://github.com/haddowg/json-api-ts/commit/2e4afc9eb3b9edd05f1e9602d680f6c71e163e1c))
* **codegen:** carry OpenAPI descriptions into the generated client as JSDoc ([#3](https://github.com/haddowg/json-api-ts/issues/3)) ([2132332](https://github.com/haddowg/json-api-ts/commit/21323321a14cf14e197352a08989b4c9441aa8bb))
* **codegen:** generate a typed descriptor and client from the OpenAPI spec ([#1](https://github.com/haddowg/json-api-ts/issues/1)) ([003289d](https://github.com/haddowg/json-api-ts/commit/003289d24b20946779317084b860930aa3e740b6))
* **codegen:** stamp provenance and add a --check drift gate ([#27](https://github.com/haddowg/json-api-ts/issues/27)) ([bacc7a3](https://github.com/haddowg/json-api-ts/commit/bacc7a3de475d5665ae422a7aa693c964f37c687))
* narrow include/sort/filter to the OpenAPI-advertised values ([#16](https://github.com/haddowg/json-api-ts/issues/16)) ([0804af5](https://github.com/haddowg/json-api-ts/commit/0804af5ba66c981662d9314c3e9590cbe4ea182f))
* opt-in validation seam — emitted schemas, validate? hook, ajv adapter ([#11](https://github.com/haddowg/json-api-ts/issues/11)) ([3a88dd2](https://github.com/haddowg/json-api-ts/commit/3a88dd25f08e43ac65fc0f030b3d77c7b5738988))


### Bug Fixes

* **client:** make the descriptor faithful to per-relation exposure + structured filters ([#21](https://github.com/haddowg/json-api-ts/issues/21)) ([a797240](https://github.com/haddowg/json-api-ts/commit/a79724036e165fc22d686380ad8d76d0e5dae1c3))
* **codegen:** detect cursor pagination from page[after]/page[before] ([#25](https://github.com/haddowg/json-api-ts/issues/25)) ([7d6d0f9](https://github.com/haddowg/json-api-ts/commit/7d6d0f96b944ed3147ff18fd047313c23f36c4b9))
* **codegen:** resolve a related collection's paginator per relation ([#30](https://github.com/haddowg/json-api-ts/issues/30)) ([8521cb5](https://github.com/haddowg/json-api-ts/commit/8521cb578c3ef3d87c063be0626b40d8c18875ed))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.0.0
