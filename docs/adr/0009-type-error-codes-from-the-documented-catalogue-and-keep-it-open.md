# Error codes are typed from the server's catalogue, and the type stays open

The document lists the codes each status can carry, so the codegen emits an `ErrorCodes` const object, the `ErrorCode` union and `ErrorCodeByStatus` derived from it, and a `hasErrorCode` guard bound to `ErrorCode`, so a misspelt code fails to compile; codes are object keys because TypeScript shows TSDoc on hover for a key but not for a union member. The server's catalogue is open, so `JsonApiError<C = string>` types `code` as `C | (string & {})`, which autocompletes documented codes without rejecting others, and matching an undocumented code means importing the runtime's unbound `hasErrorCode`, a deliberate step rather than an overload that would let typos back in.

## Consequences

`catch` can't be typed, so the union reaches errors only through the guard's narrowing and the client type, which carries it on a type-only symbol key that the Angular refs read through `ErrorCodeOf`.
