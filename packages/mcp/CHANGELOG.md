# Changelog

## [1.3.0](https://github.com/haddowg/json-api-ts/compare/json-api-mcp-v1.2.1...json-api-mcp-v1.3.0) (2026-10-30)


### Features

* **mcp:** wrap results in a data envelope and keep resource links ([#102](https://github.com/haddowg/json-api-ts/issues/102)) ([a1288a3](https://github.com/haddowg/json-api-ts/commit/a1288a33d5efea962f405acab2e1f819c608838a))

## [1.2.1](https://github.com/haddowg/json-api-ts/compare/json-api-mcp-v1.2.0...json-api-mcp-v1.2.1) (2026-10-28)


### Bug Fixes

* **mcp:** point the package homepage at its guide ([#100](https://github.com/haddowg/json-api-ts/issues/100)) ([9fea540](https://github.com/haddowg/json-api-ts/commit/9fea5408c7f16bf01f6eafbad251bf5013b67900))

## [1.2.0](https://github.com/haddowg/json-api-ts/compare/json-api-mcp-v1.1.0...json-api-mcp-v1.2.0) (2026-10-27)


### Features

* **mcp:** read contract 18 ([4b16037](https://github.com/haddowg/json-api-ts/commit/4b16037b0ee08be8dd99b5eae136b080ddcf7c0f))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @haddowg/json-api-codegen bumped to 1.13.0
  * peerDependencies
    * @haddowg/json-api-codegen bumped to 1.13.0

## [1.1.0](https://github.com/haddowg/json-api-ts/compare/json-api-mcp-v1.0.0...json-api-mcp-v1.1.0) (2026-10-27)


### Features

* **mcp:** cap tool include depth and store security once ([#94](https://github.com/haddowg/json-api-ts/issues/94)) ([28a4e40](https://github.com/haddowg/json-api-ts/commit/28a4e40b65373e4cb04cae42532be0b5371ff13a))
* **mcp:** read contract 17 and return the URL an action answers with ([4ce83a4](https://github.com/haddowg/json-api-ts/commit/4ce83a43f18b2e64c11192d82246abaf9c5bfbc9))


### Bug Fixes

* **mcp:** filter scopes only by credentials the caller can present ([#90](https://github.com/haddowg/json-api-ts/issues/90)) ([31dd290](https://github.com/haddowg/json-api-ts/commit/31dd2901898588ef164b5e1e509aeb3264dbb8e4))
* **mcp:** treat a null scope grant as no scopes granted ([#92](https://github.com/haddowg/json-api-ts/issues/92)) ([0b3a943](https://github.com/haddowg/json-api-ts/commit/0b3a943503557b10359a2f7d7a96c7d4d3050ab0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.9.0
  * devDependencies
    * @haddowg/json-api-codegen bumped to 1.12.0
  * peerDependencies
    * @haddowg/json-api-codegen bumped to 1.12.0

## 1.0.0 (2026-10-27)


### Features

* **mcp:** build MCP tools from the OpenAPI document ([#83](https://github.com/haddowg/json-api-ts/issues/83)) ([70bce51](https://github.com/haddowg/json-api-ts/commit/70bce5148b9ee5255d0212039efe9665506a1046))
* **mcp:** read contract 16, carry scopes and key polymorphism on the flag ([296ea7a](https://github.com/haddowg/json-api-ts/commit/296ea7ae4ac473a6e2944b3ee64e6abb58571233))
* **mcp:** serve MCP tools from a model generated at build time ([#86](https://github.com/haddowg/json-api-ts/issues/86)) ([2233837](https://github.com/haddowg/json-api-ts/commit/2233837242c344ea5566ebf76425433debeb4778))


### Bug Fixes

* **mcp:** say a relationship in fields needs include to have a value ([#87](https://github.com/haddowg/json-api-ts/issues/87)) ([2141362](https://github.com/haddowg/json-api-ts/commit/21413628c1f93bde05403d2de4e2e9602a78a027))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.8.0
  * devDependencies
    * @haddowg/json-api-codegen bumped to 1.11.0
  * peerDependencies
    * @haddowg/json-api-codegen bumped to 1.11.0
