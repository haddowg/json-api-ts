# Changelog

## [1.18.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.17.0...json-api-client-v1.18.0) (2026-11-11)


### Features

* **client:** type and poll writes the server accepts for later ([e4288dd](https://github.com/haddowg/json-api-ts/commit/e4288ddc597d889ec757c37e77ffef20989b0d7e))

## [1.17.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.16.0...json-api-client-v1.17.0) (2026-11-11)


### Features

* **client:** read relationship counts and send relationship queries ([f4c1050](https://github.com/haddowg/json-api-ts/commit/f4c1050dc5d11b1abc386c15ddf2da3467ae3f0d))

## [1.16.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.15.0...json-api-client-v1.16.0) (2026-11-10)


### Features

* **client:** narrow sort and filter on a relation's own reads ([3c84f41](https://github.com/haddowg/json-api-ts/commit/3c84f412ce0a4f5189565cb669414ea4ef3d096d))

## [1.15.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.14.0...json-api-client-v1.15.0) (2026-11-09)


### Features

* **client:** send list filters and type filter families ([9496960](https://github.com/haddowg/json-api-ts/commit/9496960a4d6199f730f6fd57d1accc7c1da93b9f))
* **client:** type the identifier meta a relation declares ([93eef84](https://github.com/haddowg/json-api-ts/commit/93eef8449f4118986161585d563949af3aa3f3ff))

## [1.14.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.13.0...json-api-client-v1.14.0) (2026-11-08)


### Features

* **client:** send filters on collection actions ([445b766](https://github.com/haddowg/json-api-ts/commit/445b7667c8c97177929e9e2835103295fe2753f9))

## [1.13.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.12.0...json-api-client-v1.13.0) (2026-11-07)


### Features

* **client:** find an error by code with its meta typed ([d439c21](https://github.com/haddowg/json-api-ts/commit/d439c21b8b322de060e586c03a5d6c4f8ebc5a8a))

## [1.12.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.11.0...json-api-client-v1.12.0) (2026-11-06)


### Features

* **client:** keep descriptor TSDoc on type and relation accessors ([a8c5bec](https://github.com/haddowg/json-api-ts/commit/a8c5becdcc810f120848563c336575c219c93867))

## [1.11.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.10.1...json-api-client-v1.11.0) (2026-11-03)


### Features

* **client:** type sort family keys in the sort union ([a26fb3e](https://github.com/haddowg/json-api-ts/commit/a26fb3e1decc12834df86b851832d043032b3aef))

## [1.10.1](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.10.0...json-api-client-v1.10.1) (2026-11-02)


### Bug Fixes

* **client:** require ajv 8.20.0 or later for response validation ([#111](https://github.com/haddowg/json-api-ts/issues/111)) ([cf22159](https://github.com/haddowg/json-api-ts/commit/cf221594883f11d5c39f60ce3d0437d1e4837ab8))

## [1.10.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.9.0...json-api-client-v1.10.0) (2026-10-31)


### Features

* **client:** type a compound document's included by the types it can carry ([6e6bfef](https://github.com/haddowg/json-api-ts/commit/6e6bfef46044fd37f1bbceaaf5a6e725fc1f231e))

## [1.9.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.8.0...json-api-client-v1.9.0) (2026-10-27)


### Features

* **client:** return the URL an action answers with instead of following it ([44cc7ae](https://github.com/haddowg/json-api-ts/commit/44cc7ae65b62726e06e4cf4fa2d781d2571f7d53))

## [1.8.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.7.0...json-api-client-v1.8.0) (2026-10-27)


### Features

* **client:** describe operation scopes and polymorphic relations ([c97f566](https://github.com/haddowg/json-api-ts/commit/c97f566a7788ff944cd6656b26193b271fd6f79d))

## [1.7.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.6.0...json-api-client-v1.7.0) (2026-10-26)


### Features

* **client:** carry an action's declared safety on its descriptor ([05286a8](https://github.com/haddowg/json-api-ts/commit/05286a891a54b8dba2de04021244138c2bf6b4c8))

## [1.6.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.5.0...json-api-client-v1.6.0) (2026-10-26)


### Features

* **client:** type a resource's declared links on $links ([9b71969](https://github.com/haddowg/json-api-ts/commit/9b71969a62f1811dee3a5afe649c7e95b44d77a6))


### Bug Fixes

* **client:** key declared links by a string so apps can export bound APIs ([916b115](https://github.com/haddowg/json-api-ts/commit/916b11550312d34126fade77298f02b915f2ab89))
* **client:** read $self as the href of a link object self link ([#80](https://github.com/haddowg/json-api-ts/issues/80)) ([9900e2a](https://github.com/haddowg/json-api-ts/commit/9900e2a11108db3ccba76a413a4bd6cab5fb9c8e))

## [1.5.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.4.1...json-api-client-v1.5.0) (2026-10-26)


### Features

* **client:** describe operation examples with ApiExamples ([f059560](https://github.com/haddowg/json-api-ts/commit/f0595601fbd0b2049675d17ef310e4819ce3a49d))

## [1.4.1](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.4.0...json-api-client-v1.4.1) (2026-10-26)


### Bug Fixes

* **client:** take a string or a Blob for a text request body ([bb21658](https://github.com/haddowg/json-api-ts/commit/bb21658f6295032017d26a21f21ef0cbb982ff69))

## [1.4.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.3.1...json-api-client-v1.4.0) (2026-10-26)


### Features

* **client:** choose an action's response and request media types ([26e7217](https://github.com/haddowg/json-api-ts/commit/26e72171f0a1d1bff3e4b104ecc030bd16850a91))
* **client:** take a multipart or form body as typed fields ([9fdd967](https://github.com/haddowg/json-api-ts/commit/9fdd967ee02e09e7ac0c24b1d99dfcff76cf0666))


### Bug Fixes

* **client:** send the JSON:API content type on every POST ([8c231e0](https://github.com/haddowg/json-api-ts/commit/8c231e06a12d8da65612f6e6670bd01b7fefd6da))

## [1.3.1](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.3.0...json-api-client-v1.3.1) (2026-10-24)


### Bug Fixes

* **client:** only follow same-origin links ([#63](https://github.com/haddowg/json-api-ts/issues/63)) ([4522de1](https://github.com/haddowg/json-api-ts/commit/4522de1657a6bc6aca85239acaddc3dd340207ce))

## [1.3.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.2.0...json-api-client-v1.3.0) (2026-10-24)


### Features

* **client:** type write-only relations and per-side pivots ([b307292](https://github.com/haddowg/json-api-ts/commit/b307292cea14d0653280993ca6c1fa9282a475e2))

## [1.2.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.1.0...json-api-client-v1.2.0) (2026-10-23)


### Features

* **angular:** type nextPage() and prevPage() by the page that answered ([99ff1e9](https://github.com/haddowg/json-api-ts/commit/99ff1e93e2889fbd7a8074ad8d86c297db92f67e))
* **client:** describe renamed page keys and strategy menus, and type $page ([99ff1e9](https://github.com/haddowg/json-api-ts/commit/99ff1e93e2889fbd7a8074ad8d86c297db92f67e))
* **client:** type error codes and add a hasErrorCode guard ([d50ce2e](https://github.com/haddowg/json-api-ts/commit/d50ce2ea85f018d6d9ff80fc9f669851a792df93))
* **client:** type the page argument from the collection's paginator ([99ff1e9](https://github.com/haddowg/json-api-ts/commit/99ff1e93e2889fbd7a8074ad8d86c297db92f67e))
* **codegen:** read the x-paginator stamp and support generator contract 3 ([99ff1e9](https://github.com/haddowg/json-api-ts/commit/99ff1e93e2889fbd7a8074ad8d86c297db92f67e))


### Bug Fixes

* **client:** add the fixed paginator kind ([acbcf06](https://github.com/haddowg/json-api-ts/commit/acbcf06482ecdbfeda211afca4effdfa16564393))
* **client:** resolve server links against the base URL per RFC 3986 ([acbcf06](https://github.com/haddowg/json-api-ts/commit/acbcf06482ecdbfeda211afca4effdfa16564393))
* **codegen:** detect pagination from the page object parameter ([acbcf06](https://github.com/haddowg/json-api-ts/commit/acbcf06482ecdbfeda211afca4effdfa16564393))
* **codegen:** name the kinds a MultiPaginator menu offers ([acbcf06](https://github.com/haddowg/json-api-ts/commit/acbcf06482ecdbfeda211afca4effdfa16564393))
* **codegen:** run the CLI when invoked through a bin symlink ([acbcf06](https://github.com/haddowg/json-api-ts/commit/acbcf06482ecdbfeda211afca4effdfa16564393))

## [1.1.0](https://github.com/haddowg/json-api-ts/compare/json-api-client-v1.0.0...json-api-client-v1.1.0) (2026-10-21)


### Features

* **client:** accept an AbortSignal on reads and pass it to the transport ([#44](https://github.com/haddowg/json-api-ts/issues/44)) ([45ff501](https://github.com/haddowg/json-api-ts/commit/45ff501d2012e61b9eb587beac18c63bdc614435))

## 1.0.0 (2026-07-13)


### ⚠ BREAKING CHANGES

* **client:** a document action's generated input is now flat resource input (not the raw envelope) and its result is the materialised resource (not the raw document); regenerate the client to pick up the new types.
* read query types are narrower. get(id, query) no longer accepts filter/sort/page; list(query)'s filter keys and sort tokens must be ones the type's OpenAPI document advertises (an unadvertised key/token, or any filter/sort on a type that advertises none, is now a compile error). Regenerate the client from your /docs.json to pick up the new descriptor fields.

### Features

* **client:** carry per-relation withCount + report the real empty-page kind ([#22](https://github.com/haddowg/json-api-ts/issues/22)) ([1b8f082](https://github.com/haddowg/json-api-ts/commit/1b8f082a3132da22e0267c6a74b11511762e6a98))
* **client:** custom actions + atomic transaction builder + per-relation verb gating ([#7](https://github.com/haddowg/json-api-ts/issues/7)) ([3c7e15e](https://github.com/haddowg/json-api-ts/commit/3c7e15e5a41a1e91569f5a23e4ca2c91e9137822))
* **client:** derive the custom-action surface from the descriptor ([#20](https://github.com/haddowg/json-api-ts/issues/20)) ([f66d6d4](https://github.com/haddowg/json-api-ts/commit/f66d6d40984ef5c12d44051796b76b38e63a3677))
* **client:** finalize reads — sparse fieldsets, withCount, cursor, content negotiation ([#9](https://github.com/haddowg/json-api-ts/issues/9)) ([9974b55](https://github.com/haddowg/json-api-ts/commit/9974b5537ced8b51f3924b67daaab303bf165cf7))
* **client:** infer per-op positional result types for client.atomic ([#8](https://github.com/haddowg/json-api-ts/issues/8)) ([6687719](https://github.com/haddowg/json-api-ts/commit/6687719fa9a71129562821778a504190cd1a784b))
* **client:** the read runtime — transport, materialise, pagination, typed fluent reads ([#4](https://github.com/haddowg/json-api-ts/issues/4)) ([662c40b](https://github.com/haddowg/json-api-ts/commit/662c40bf387820b39ce6bf698b1f005016bef356))
* **client:** type meta.pivot from the descriptor instead of erasing it to a boolean ([#23](https://github.com/haddowg/json-api-ts/issues/23)) ([424c4f3](https://github.com/haddowg/json-api-ts/commit/424c4f3d26887761a02f05894dc058dbb9e96627))
* **client:** writes — flat-input envelope, pointer remapping, create/update/delete + relationship mutation ([#6](https://github.com/haddowg/json-api-ts/issues/6)) ([2e4afc9](https://github.com/haddowg/json-api-ts/commit/2e4afc9eb3b9edd05f1e9602d680f6c71e163e1c))
* **codegen:** generate a typed descriptor and client from the OpenAPI spec ([#1](https://github.com/haddowg/json-api-ts/issues/1)) ([003289d](https://github.com/haddowg/json-api-ts/commit/003289d24b20946779317084b860930aa3e740b6))
* narrow include/sort/filter to the OpenAPI-advertised values ([#16](https://github.com/haddowg/json-api-ts/issues/16)) ([0804af5](https://github.com/haddowg/json-api-ts/commit/0804af5ba66c981662d9314c3e9590cbe4ea182f))
* opt-in validation seam — emitted schemas, validate? hook, ajv adapter ([#11](https://github.com/haddowg/json-api-ts/issues/11)) ([3a88dd2](https://github.com/haddowg/json-api-ts/commit/3a88dd25f08e43ac65fc0f030b3d77c7b5738988))


### Bug Fixes

* **client:** make the descriptor faithful to per-relation exposure + structured filters ([#21](https://github.com/haddowg/json-api-ts/issues/21)) ([a797240](https://github.com/haddowg/json-api-ts/commit/a79724036e165fc22d686380ad8d76d0e5dae1c3))
* **codegen:** resolve a related collection's paginator per relation ([#30](https://github.com/haddowg/json-api-ts/issues/30)) ([8521cb5](https://github.com/haddowg/json-api-ts/commit/8521cb578c3ef3d87c063be0626b40d8c18875ed))
