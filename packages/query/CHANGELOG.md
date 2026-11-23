# Changelog

## [2.0.0](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.9.1...json-api-query-v2.0.0) (2026-11-23)


### ⚠ BREAKING CHANGES

* **query:** an optimistic create of a type whose clientId is optional no longer sends a generated id. The server assigns the id, the variables carry $tempId instead of id until the write succeeds, and a clientId option supplies the temporary id's suffix rather than the id sent. Put an id in the variables to keep sending one.
* **query:** applyOptimisticPatch, Snapshot, sameRef and MembershipRef are no longer exported from @haddowg/json-api-query. Open a draft with openDraft and call its patch() and rollback() in place of applyOptimisticPatch and its snapshot's restore(), and compare refs by type and id in place of sameRef.
* **query:** applyOptimisticMembership, applyOptimisticToOne and the MembershipTransform type are no longer exported; use openDraft(queryClient, descriptor) and its attach, detach, replaceMembers and link operations, which apply the fit rules they couldn't.
* **query:** mutation options now carry `mutationKey` and `meta` instead of lifecycle callbacks. The `MutationContext` type is gone, and calling `options.mutationFn(variables)` directly without TanStack's context no longer works. `@tanstack/query-core` 5.89 or later is required for its `MutationFunctionContext`.
* **query:** a skipped read's query key no longer contains the string '$skip'. Code that builds, matches or decodes skipped keys by that string must compare against SKIPPED_SEGMENT by value (or `{ $skip: true }`) instead.

### Features

* **query:** add infinite list and related read factories ([39903eb](https://github.com/haddowg/json-api-ts/commit/39903eb167c958b9f957d72f2e51b7422b714f98))
* **query:** add the optimistic draft ([a2807c3](https://github.com/haddowg/json-api-ts/commit/a2807c39435dc31aaa9320b34152e6b5e14e5738))
* **query:** complete optimistic creates and keep the rest as pending entries ([4f2fa69](https://github.com/haddowg/json-api-ts/commit/4f2fa6975816a23b3bc105d9acae94f39e0e9362))
* **query:** describe cached views and resolve members that fit them ([027be04](https://github.com/haddowg/json-api-ts/commit/027be0456ed078f1817c82af2eb2ec31d00b390e))
* **query:** generate client ids only where the server requires them ([015edf6](https://github.com/haddowg/json-api-ts/commit/015edf630dc74d20bf0018bd4a7d3f3550a4850f))
* **query:** give skipped reads an object key segment ([efc7bcb](https://github.com/haddowg/json-api-ts/commit/efc7bcbc40aeed12749a8a0fcedfad5493937367))
* **query:** guard against server-rendered results losing their accessors ([161f954](https://github.com/haddowg/json-api-ts/commit/161f95462fbd3cb13fe7eb89fd6d31d01c05d55f))
* **query:** keep optimistic values while their write is pending ([2689511](https://github.com/haddowg/json-api-ts/commit/268951145357c3b0d1a09107f9ae6206c5dd04ef))
* **query:** let reads update relationships across the cache ([15fdd27](https://github.com/haddowg/json-api-ts/commit/15fdd272ac2e90c55bf8c4fbf1d09348a19aa212))
* **query:** normalise infinite query pages ([b976f36](https://github.com/haddowg/json-api-ts/commit/b976f361eaee4ab2e46d67f1888f5bee8eb25d96))
* **query:** reconcile optimistic writes when the last overlapping write settles ([4025dca](https://github.com/haddowg/json-api-ts/commit/4025dcaf851bd26023c1a0c6fde2446d8ed269e0))
* **query:** run mutation upkeep from a JsonApiMutationCache ([#210](https://github.com/haddowg/json-api-ts/issues/210)) ([ae595ca](https://github.com/haddowg/json-api-ts/commit/ae595ca54a60f968ed56cc7c7e9b19bf3fba22de))
* **query:** stop exporting the superseded optimistic helpers ([8cd9480](https://github.com/haddowg/json-api-ts/commit/8cd94808077f89ae2c3c428f2ff731fef5837c54))
* **query:** type a placed member's pivot ([a49b685](https://github.com/haddowg/json-api-ts/commit/a49b6850af5f26ebf44ee801c1efcdf1aabe87aa))
* **query:** type read keys and errors, and accept skipToken ([8fdf9d0](https://github.com/haddowg/json-api-ts/commit/8fdf9d06710d110bb5085ad3254a26a8827c460e))
* **query:** type the into callback by the view's filters and sorts ([265b119](https://github.com/haddowg/json-api-ts/commit/265b119c0ad0ba76b43b28e81559cdb87478a819))


### Bug Fixes

* **query:** accept skipToken from any copy of query-core ([9724ba7](https://github.com/haddowg/json-api-ts/commit/9724ba71836374d0f65651c5596f98f9b7694fac))
* **query:** freeze the query descriptions into receives ([3f51b4c](https://github.com/haddowg/json-api-ts/commit/3f51b4c83a6e17bd39fcea4c08185cf4a1b7625b))
* **query:** judge every client result by when its request started ([4a19147](https://github.com/haddowg/json-api-ts/commit/4a19147ea68bffa97bc89b92610624ae1d45b89f))
* **query:** keep JSON:API error codes in every query's error type ([02edc4f](https://github.com/haddowg/json-api-ts/commit/02edc4f5a78826b2126bd0a806ae02d365a56d24))
* **query:** keep server-rendered client results out of dehydration by their data ([3dadaf6](https://github.com/haddowg/json-api-ts/commit/3dadaf6d936a17e01c38b27d131ab79f71e28a45))
* **query:** leave infinite reads off unpaginated types ([9ead452](https://github.com/haddowg/json-api-ts/commit/9ead4523dc7eec57a96ceafa0a88e0ee6a0f58e9))
* **query:** let the later request win when responses race ([781745d](https://github.com/haddowg/json-api-ts/commit/781745da9602eca71ef4f7fddb00745ee9153126))
* **query:** normalise the resources an atomic batch returns ([7a576de](https://github.com/haddowg/json-api-ts/commit/7a576defb87de4d7695267b01d73e326ebac6ff4))
* **query:** pass TanStack's abort signal to every read ([#208](https://github.com/haddowg/json-api-ts/issues/208)) ([22e64bc](https://github.com/haddowg/json-api-ts/commit/22e64bc627e2dde2cef3853e9fe91cd9442e56ed))
* **query:** refetch a streamed pending read that resolves without its accessors ([9bd0406](https://github.com/haddowg/json-api-ts/commit/9bd040620c72d0c8e14446c561982fc8445202f4))


### Performance Improvements

* **query:** index cached resources by type and id ([0c61aa2](https://github.com/haddowg/json-api-ts/commit/0c61aa2f19d24a64e9245a0999ef7eb0da0d9d40))
* **query:** keep the relink queue when an update moves few copies ([a3c86c3](https://github.com/haddowg/json-api-ts/commit/a3c86c3dfe3de82bbd4e2f2d2987beb6af95ba72))
* **query:** key field claims by nested maps and look them up per copy ([c9ed81a](https://github.com/haddowg/json-api-ts/commit/c9ed81a4a90fb1b4898d557252e23ea09b0d83cc))
* **query:** match relinked members by identity instead of scanning ([39e7454](https://github.com/haddowg/json-api-ts/commit/39e745471582432845609660567b51f8e4858bdd))
* **query:** read the cache index when replaying a draft into a read ([3eaff4e](https://github.com/haddowg/json-api-ts/commit/3eaff4e9f01ac6c41154528605f4127bf84ae864))
* **query:** reuse a read's cache view through propagation and patching ([dc809f7](https://github.com/haddowg/json-api-ts/commit/dc809f72ccecaa2eb5ccf524f72ec83eb3801564))
* **query:** skip the response's own copies when raising to the newest ([ca081e6](https://github.com/haddowg/json-api-ts/commit/ca081e657d12443d84ec2f9237e03e866754f51a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.29.0

## [1.9.1](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.9.0...json-api-query-v1.9.1) (2026-11-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.28.0

## [1.9.0](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.8.0...json-api-query-v1.9.0) (2026-11-20)


### Features

* **query:** keep cached keys a read narrowed through fields leaves out ([7c57f95](https://github.com/haddowg/json-api-ts/commit/7c57f952b0b1cdd3996897ed03ee28a7174a14df))
* **query:** merge a narrowed list into the cached list item by item ([5d100e7](https://github.com/haddowg/json-api-ts/commit/5d100e7943a6e08dbb99bc3cecf00ebb3babc3f3))
* **query:** merge a nested narrowed read into the cached object ([b1be2aa](https://github.com/haddowg/json-api-ts/commit/b1be2aacb0e20a57aa0551f2843b20a59df63832))
* **query:** send declared request meta from the mutation factories ([c2fc421](https://github.com/haddowg/json-api-ts/commit/c2fc4216606bff09ad0394ba20d4da804f85b12f))


### Bug Fixes

* **query:** let an atomic batch mutation take any recording callback ([35d9727](https://github.com/haddowg/json-api-ts/commit/35d9727d06cefb4a5bc3987b47a3553c7c1039e8))
* **query:** merge a narrowed union value only into a cached value of the same variant ([c1206a3](https://github.com/haddowg/json-api-ts/commit/c1206a396b5c52b666545771ec6c218a0d1b2b8f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.27.0

## [1.8.0](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.7.2...json-api-query-v1.8.0) (2026-11-18)


### Features

* **query:** carry declared document meta on read and write results ([49ee066](https://github.com/haddowg/json-api-ts/commit/49ee06678697abaf7dd068fcbc1a48daf7d757b9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.26.0

## [1.7.2](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.7.1...json-api-query-v1.7.2) (2026-11-16)


### Bug Fixes

* **query:** keep a materialised value's accessors through refetch and optimistic edits ([48977e9](https://github.com/haddowg/json-api-ts/commit/48977e9d0c1a6d69dd52d61b4df138d32741cb6e))
* **query:** re-render observers of a read a write-through patch reaches ([b5f1ba5](https://github.com/haddowg/json-api-ts/commit/b5f1ba59acd8fdd45cb1c9b2733c9b3a320f0a2d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.25.0

## [1.7.1](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.7.0...json-api-query-v1.7.1) (2026-11-16)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.24.0

## [1.7.0](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.6.0...json-api-query-v1.7.0) (2026-11-16)


### Features

* **query:** read and write singleton types without an id ([8b0b7f2](https://github.com/haddowg/json-api-ts/commit/8b0b7f249efcd9e05fc80cde6f6841196f4a3714))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.23.0

## [1.6.0](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.5.0...json-api-query-v1.6.0) (2026-11-13)


### Features

* **query:** pass relatedQuery through related reads and write mutations ([9f406eb](https://github.com/haddowg/json-api-ts/commit/9f406eb326001cef79d5a911794b1dd298dbb071))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.22.0

## [1.5.0](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.4.2...json-api-query-v1.5.0) (2026-11-12)


### Features

* **query:** pass withCount through single reads and write mutations ([3be27ec](https://github.com/haddowg/json-api-ts/commit/3be27ecffebbf8471d0285e94a975e222c9571b2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.21.0

## [1.4.2](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.4.1...json-api-query-v1.4.2) (2026-11-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.20.0

## [1.4.1](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.4.0...json-api-query-v1.4.1) (2026-11-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.19.0

## [1.4.0](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.3.0...json-api-query-v1.4.0) (2026-11-11)


### Features

* **query:** type create and update mutations a server may accept later ([f6b2548](https://github.com/haddowg/json-api-ts/commit/f6b2548f141f68935cc0f17fdd4f58e077a2c7e9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.18.0

## [1.3.0](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.2.0...json-api-query-v1.3.0) (2026-11-11)


### Features

* **query:** narrow relationship counts on list read options ([f62830c](https://github.com/haddowg/json-api-ts/commit/f62830c97f560c378474db216da0c383225b66c2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.17.0

## [1.2.0](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.16...json-api-query-v1.2.0) (2026-11-10)


### Features

* **query:** narrow sort and filter on relation read options ([2da0303](https://github.com/haddowg/json-api-ts/commit/2da0303a5d0d933c65eb67d600145b8958c7b378))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.16.0

## [1.1.16](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.15...json-api-query-v1.1.16) (2026-11-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.15.0

## [1.1.15](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.14...json-api-query-v1.1.15) (2026-11-08)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.14.0

## [1.1.14](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.13...json-api-query-v1.1.14) (2026-11-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.13.0

## [1.1.13](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.12...json-api-query-v1.1.13) (2026-11-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.12.0

## [1.1.12](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.11...json-api-query-v1.1.12) (2026-11-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.11.0

## [1.1.11](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.10...json-api-query-v1.1.11) (2026-11-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.10.1

## [1.1.10](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.9...json-api-query-v1.1.10) (2026-10-31)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.10.0

## [1.1.9](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.8...json-api-query-v1.1.9) (2026-10-27)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.9.0

## [1.1.8](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.7...json-api-query-v1.1.8) (2026-10-27)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.8.0

## [1.1.7](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.6...json-api-query-v1.1.7) (2026-10-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.7.0

## [1.1.6](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.5...json-api-query-v1.1.6) (2026-10-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.6.0

## [1.1.5](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.4...json-api-query-v1.1.5) (2026-10-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.5.0

## [1.1.4](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.3...json-api-query-v1.1.4) (2026-10-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.4.1

## [1.1.3](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.2...json-api-query-v1.1.3) (2026-10-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.4.0

## [1.1.2](https://github.com/haddowg/json-api-ts/compare/json-api-query-v1.1.1...json-api-query-v1.1.2) (2026-10-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @haddowg/json-api-client bumped to 1.3.1

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
