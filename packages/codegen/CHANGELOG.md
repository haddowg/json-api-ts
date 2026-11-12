# Changelog

## [2.13.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v2.12.0...json-api-codegen-v2.13.0) (2026-11-12)


### Features

* **codegen:** record empty sort and filter lists on a relation that takes none ([2765b13](https://github.com/haddowg/json-api-ts/commit/2765b137f41353705f6483f808cfe6a53579523b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.20.0

## [2.12.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v2.11.1...json-api-codegen-v2.12.0) (2026-11-12)


### Features

* **codegen:** mark relations whose reads take no sort ([241e3c8](https://github.com/haddowg/json-api-ts/commit/241e3c81a56c22ca36a2e078e7a70cd0787347c6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.19.0

## [2.11.1](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v2.11.0...json-api-codegen-v2.11.1) (2026-11-12)


### Bug Fixes

* **codegen:** record a monomorphic relation's own sorts and filters ([49af171](https://github.com/haddowg/json-api-ts/commit/49af1719158537624fce60a4b326fe335d89abe9))

## [2.11.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v2.10.0...json-api-codegen-v2.11.0) (2026-11-12)


### Features

* **codegen:** read generator contract 34 ([86a9005](https://github.com/haddowg/json-api-ts/commit/86a90058e24b4d222fe792810cd258b61b39a729))

## [2.10.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v2.9.0...json-api-codegen-v2.10.0) (2026-11-11)


### Features

* **codegen:** read a declared 202 Accepted into the descriptor ([ae27de1](https://github.com/haddowg/json-api-ts/commit/ae27de1c18a1ee15aca88686ecc947e70f5fedda))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.18.0

## [2.9.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v2.8.0...json-api-codegen-v2.9.0) (2026-11-11)


### Features

* **codegen:** record which reads take relatedQuery ([34c9f4d](https://github.com/haddowg/json-api-ts/commit/34c9f4deedf1e42a243a10ee166950453c29b6af))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.17.0

## [2.8.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v2.7.0...json-api-codegen-v2.8.0) (2026-11-10)


### Features

* **codegen:** read generator contract 33 ([8cc0978](https://github.com/haddowg/json-api-ts/commit/8cc0978b15a7bd34ca95d1da00769ba9af3a1595))

## [2.7.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v2.6.0...json-api-codegen-v2.7.0) (2026-11-10)


### Features

* **codegen:** read generator contract 32 ([6456196](https://github.com/haddowg/json-api-ts/commit/64561962a023576e6b5024e2924c0303d3721fa2))

## [2.6.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v2.5.0...json-api-codegen-v2.6.0) (2026-11-10)


### Features

* **codegen:** read generator contract 31 ([284ba5b](https://github.com/haddowg/json-api-ts/commit/284ba5b22c9671e95e62c78c9eda271cbb311b34))


### Bug Fixes

* **codegen:** type an integer enum by its numbers ([277d65e](https://github.com/haddowg/json-api-ts/commit/277d65e17dd62bb60a72dcdbca4022b964135264))

## [2.5.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v2.4.0...json-api-codegen-v2.5.0) (2026-11-10)


### Features

* **codegen:** name a relation's default read order in its JSDoc ([#143](https://github.com/haddowg/json-api-ts/issues/143)) ([dc0354c](https://github.com/haddowg/json-api-ts/commit/dc0354c06b3fca47d9e0317e19274e4bf47a3ac6))
* **codegen:** read generator contract 30 ([cdc4a20](https://github.com/haddowg/json-api-ts/commit/cdc4a205b00b6df0d9e4c71f185e0bb91169807f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.16.0

## [2.4.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v2.3.0...json-api-codegen-v2.4.0) (2026-11-09)


### Features

* **codegen:** type every map from its additionalProperties schema ([#140](https://github.com/haddowg/json-api-ts/issues/140)) ([b243b6d](https://github.com/haddowg/json-api-ts/commit/b243b6dbeae55e02956aae4a6dde904a7bdf1695))

## [2.3.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v2.2.1...json-api-codegen-v2.3.0) (2026-11-09)


### Features

* **codegen:** read declared identifier meta ([ec6ac69](https://github.com/haddowg/json-api-ts/commit/ec6ac69220d079eb50de85ffeb6668d472ee0123))
* **codegen:** read list filters and filter families ([a3bfde1](https://github.com/haddowg/json-api-ts/commit/a3bfde1621d3af1976c5db1092e506b24a3818c6))
* **codegen:** type objects open to undeclared members ([714eeb1](https://github.com/haddowg/json-api-ts/commit/714eeb1922787dfe3394ca9ca8b861c155abc6e3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.15.0

## [2.2.1](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v2.2.0...json-api-codegen-v2.2.1) (2026-11-09)


### Bug Fixes

* **codegen:** never take an action path as a collection path ([#134](https://github.com/haddowg/json-api-ts/issues/134)) ([5923c5d](https://github.com/haddowg/json-api-ts/commit/5923c5ddcd85d709ac3ebef522863d76e6442b61))

## [2.2.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v2.1.0...json-api-codegen-v2.2.0) (2026-11-08)


### Features

* **codegen:** read actions answering 201 Created ([0e23ba1](https://github.com/haddowg/json-api-ts/commit/0e23ba1c07479fc3754cd101a5ef806c588111e8))

## [2.1.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v2.0.0...json-api-codegen-v2.1.0) (2026-11-08)


### Features

* **codegen:** record a collection action's filters ([cf05c1a](https://github.com/haddowg/json-api-ts/commit/cf05c1a3599dc6e1c3c0cf4b3b95bef0d904fc94))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.14.0

## [2.0.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.19.0...json-api-codegen-v2.0.0) (2026-11-07)


### ⚠ BREAKING CHANGES

* **codegen:** the codegen reads generator contract 24 only. A document from an older server describes its error codes in a form it no longer reads; generate it with an earlier codegen release.

### Features

* **codegen:** read error shapes, scoped codes and typed meta ([2a20e11](https://github.com/haddowg/json-api-ts/commit/2a20e112ea1e42fc92d19598fc4a67281a514fe8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.13.0

## [1.19.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.18.0...json-api-codegen-v1.19.0) (2026-11-07)


### Features

* **codegen:** accept contract 23 and type undiscriminated unions exclusively ([32d6699](https://github.com/haddowg/json-api-ts/commit/32d66994472438a1822d8015054d7358ca904def))

## [1.18.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.17.0...json-api-codegen-v1.18.0) (2026-11-06)


### Features

* **codegen:** tag deprecated members and accept contract 22 ([22cdaa9](https://github.com/haddowg/json-api-ts/commit/22cdaa98aaffeb2fbe3104f53209af91c74ba0fa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.12.0

## [1.17.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.16.0...json-api-codegen-v1.17.0) (2026-11-03)


### Features

* **codegen:** type structured list elements and accept contract 21 ([3b71ba0](https://github.com/haddowg/json-api-ts/commit/3b71ba03047990b86fc5c1c9fc969b7e2487fada))

## [1.16.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.15.1...json-api-codegen-v1.16.0) (2026-11-03)


### Features

* **codegen:** read sort families and accept contract 20 ([cc3fa60](https://github.com/haddowg/json-api-ts/commit/cc3fa60cd586a4f21e4d76dfa55ffd28f735c093))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.11.0

## [1.15.1](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.15.0...json-api-codegen-v1.15.1) (2026-11-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.10.1

## [1.15.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.14.0...json-api-codegen-v1.15.0) (2026-11-02)


### Features

* **codegen:** emit page limits and kinds for related collections ([#109](https://github.com/haddowg/json-api-ts/issues/109)) ([d451371](https://github.com/haddowg/json-api-ts/commit/d4513714884cbcf3863a0d59f3745fe00a54aabc))

## [1.14.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.13.0...json-api-codegen-v1.14.0) (2026-10-31)


### Features

* **codegen:** read discriminated unions and type included per read ([1f9b8a4](https://github.com/haddowg/json-api-ts/commit/1f9b8a4387912e2cbcc15a90fe9d6d4d5737671e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.10.0

## [1.13.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.12.0...json-api-codegen-v1.13.0) (2026-10-27)


### Features

* **codegen:** read contract 18 and its shared links components ([ffdb3ae](https://github.com/haddowg/json-api-ts/commit/ffdb3ae0609a3149290bc722cc92737cc9f8e673))

## [1.12.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.11.0...json-api-codegen-v1.12.0) (2026-10-27)


### Features

* **codegen:** read contract 17 and mark actions that answer with a URL ([b250de7](https://github.com/haddowg/json-api-ts/commit/b250de7f637c74e8b2d6492d1b0cf7673ac289ad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.9.0

## [1.11.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.10.0...json-api-codegen-v1.11.0) (2026-10-27)


### Features

* **codegen:** read contract 16 scopes and one-type polymorphic unions ([c194208](https://github.com/haddowg/json-api-ts/commit/c1942084f6a4fcebcb30a8446cf3cc7ac7a21527))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.8.0

## [1.10.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.9.0...json-api-codegen-v1.10.0) (2026-10-26)


### Features

* **codegen:** read generator contract 15 and action safety ([7983d99](https://github.com/haddowg/json-api-ts/commit/7983d99b73d6c9240e7982e2507e78942b1a5030))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.7.0

## [1.9.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.8.1...json-api-codegen-v1.9.0) (2026-10-26)


### Features

* **codegen:** read generator contract 14 and type declared links ([2e14bca](https://github.com/haddowg/json-api-ts/commit/2e14bca189985b66996b834feed48757824ffc5d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.6.0

## [1.8.1](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.8.0...json-api-codegen-v1.8.1) (2026-10-26)


### Bug Fixes

* **codegen:** read generator contract 13 ([#76](https://github.com/haddowg/json-api-ts/issues/76)) ([89591e0](https://github.com/haddowg/json-api-ts/commit/89591e0a1810be280b8a4e734825ace1030bd740))

## [1.8.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.7.1...json-api-codegen-v1.8.0) (2026-10-26)


### Features

* **codegen:** read generator contract 12 and carry operation examples ([3c3697a](https://github.com/haddowg/json-api-ts/commit/3c3697a55629fae44c2884bd18bf045fd57ebb29))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.5.0

## [1.7.1](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.7.0...json-api-codegen-v1.7.1) (2026-10-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.4.1

## [1.7.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.6.1...json-api-codegen-v1.7.0) (2026-10-26)


### Features

* **codegen:** read generator contract 10 ([4462c50](https://github.com/haddowg/json-api-ts/commit/4462c50f5519fcbc757112b1ea81d7cf9d76bf71))
* **codegen:** read generator contract 11 ([#68](https://github.com/haddowg/json-api-ts/issues/68)) ([62635ef](https://github.com/haddowg/json-api-ts/commit/62635ef815f010f9f27d3265e48076e6924b4f7e))
* **codegen:** type a multipart or form body's fields from its schema ([4488543](https://github.com/haddowg/json-api-ts/commit/448854387662222c8ef1dcbd18d13dedb50f6b08))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.4.0

## [1.6.1](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.6.0...json-api-codegen-v1.6.1) (2026-10-24)


### Bug Fixes

* **codegen:** escape document text in generated names, literals and comments ([#64](https://github.com/haddowg/json-api-ts/issues/64)) ([5509c09](https://github.com/haddowg/json-api-ts/commit/5509c09bf62325e70b956d050039e7713449fe84))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.3.1

## [1.6.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.5.0...json-api-codegen-v1.6.0) (2026-10-24)


### Features

* **codegen:** read generator contract 9 ([#61](https://github.com/haddowg/json-api-ts/issues/61)) ([fa1dd32](https://github.com/haddowg/json-api-ts/commit/fa1dd3242064afae99186be436fdae4f58f07b63))

## [1.5.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.4.0...json-api-codegen-v1.5.0) (2026-10-24)


### Features

* **codegen:** read generator contract 8 ([a2739fd](https://github.com/haddowg/json-api-ts/commit/a2739fd110de442f188e7ec2c0133b1ff946f9ec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.3.0

## [1.4.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.3.0...json-api-codegen-v1.4.0) (2026-10-24)


### Features

* **codegen:** read generator contract 7 ([#56](https://github.com/haddowg/json-api-ts/issues/56)) ([d10de21](https://github.com/haddowg/json-api-ts/commit/d10de2196df2dd266a8f3052fc47da86bd8526c7))

## [1.3.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.2.0...json-api-codegen-v1.3.0) (2026-10-24)


### Features

* **codegen:** read generator contract 6 ([#54](https://github.com/haddowg/json-api-ts/issues/54)) ([de2dc1f](https://github.com/haddowg/json-api-ts/commit/de2dc1f68efded7f7e63ee19b788675a0553b07f))

## [1.2.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.1.0...json-api-codegen-v1.2.0) (2026-10-24)


### Features

* **codegen:** read generator contract 5 ([#52](https://github.com/haddowg/json-api-ts/issues/52)) ([4c91d96](https://github.com/haddowg/json-api-ts/commit/4c91d96c4bbf8a2e09c7dc3e11e0473b280ebc83))

## [1.1.0](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.0.1...json-api-codegen-v1.1.0) (2026-10-23)


### Features

* **angular:** type nextPage() and prevPage() by the page that answered ([99ff1e9](https://github.com/haddowg/json-api-ts/commit/99ff1e93e2889fbd7a8074ad8d86c297db92f67e))
* **client:** describe renamed page keys and strategy menus, and type $page ([99ff1e9](https://github.com/haddowg/json-api-ts/commit/99ff1e93e2889fbd7a8074ad8d86c297db92f67e))
* **client:** type the page argument from the collection's paginator ([99ff1e9](https://github.com/haddowg/json-api-ts/commit/99ff1e93e2889fbd7a8074ad8d86c297db92f67e))
* **codegen:** emit the documented error codes and a bound guard ([596e483](https://github.com/haddowg/json-api-ts/commit/596e483c670feea5ca7fcbc660896d57ffc3de61))
* **codegen:** read the x-paginator stamp and support generator contract 3 ([99ff1e9](https://github.com/haddowg/json-api-ts/commit/99ff1e93e2889fbd7a8074ad8d86c297db92f67e))


### Bug Fixes

* **client:** add the fixed paginator kind ([acbcf06](https://github.com/haddowg/json-api-ts/commit/acbcf06482ecdbfeda211afca4effdfa16564393))
* **client:** resolve server links against the base URL per RFC 3986 ([acbcf06](https://github.com/haddowg/json-api-ts/commit/acbcf06482ecdbfeda211afca4effdfa16564393))
* **codegen:** detect pagination from the page object parameter ([acbcf06](https://github.com/haddowg/json-api-ts/commit/acbcf06482ecdbfeda211afca4effdfa16564393))
* **codegen:** name the kinds a MultiPaginator menu offers ([acbcf06](https://github.com/haddowg/json-api-ts/commit/acbcf06482ecdbfeda211afca4effdfa16564393))
* **codegen:** run the CLI when invoked through a bin symlink ([acbcf06](https://github.com/haddowg/json-api-ts/commit/acbcf06482ecdbfeda211afca4effdfa16564393))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.2.0

## [1.0.1](https://github.com/haddowg/json-api-ts/compare/json-api-codegen-v1.0.0...json-api-codegen-v1.0.1) (2026-10-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.1.0

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
