# 0009 — Error codes are typed from the server's catalogue, and the type stays open

- **Status:** Accepted
- **Date:** 2026-10-22

A `haddowg/json-api` document lists the error codes each status can carry (`ErrorDocument<NNN>`
offers one `<Code>Error` branch per code beside the generic `Error`), but the client typed `code`
as `string`, so apps compared it against literals the contract never surfaced. The codegen now
emits an `ErrorCodes` const object, the `ErrorCode` union derived from it, `ErrorCodeByStatus`,
and a `hasErrorCode` guard bound to `ErrorCode`, so a misspelt code fails to compile. Each code's
description and example detail go in TSDoc on its `ErrorCodes` key, because TypeScript shows
TSDoc on hover and in completion for an object key but not for a string literal union member.

The catalogue is open on the server (core ADR 0136): an application may raise a code no source
declared. So `JsonApiError` is generic on the union with a `string` default, and each error
object types `code` as `C | (string & {})`, which autocompletes the documented codes without
rejecting others. The bound guard takes only documented codes. Matching an undocumented one means
importing the runtime's unbound `hasErrorCode`, a deliberate step rather than an overload that
would let typos back in.

`catch` can't be typed, so the union reaches errors only where a type can carry it: the guard's
narrowing, and the client type, which carries it on a type-only symbol key that the Angular refs
read through `ErrorCodeOf`. `JsonApiError<string>` doesn't assign to `JsonApiError<ErrorCode>`,
which is why the generated guard is a cast of the runtime one.
