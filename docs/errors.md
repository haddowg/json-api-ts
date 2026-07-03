# Errors

Every non-2xx response throws a typed `JsonApiError` carrying the server's JSON:API error objects, expressive status matchers, and validation errors already re-keyed to the flat input paths you supplied.

## Catch and match

The client throws a `JsonApiError` for any non-2xx response — so it drops straight into `try/catch` (and TanStack Query's error channel; see [tanstack-query](tanstack-query.md)). It carries the HTTP `status` and the parsed `errors` array, plus a family of status matchers so you rarely compare numbers by hand:

```ts
import { JsonApiError } from '@haddowg/json-api-client'

try {
  const album = await client.albums.id('999').get()
} catch (error) {
  if (error instanceof JsonApiError && error.isNotFound()) {
    // show a "not found" state
  } else {
    throw error
  }
}
```

The matchers read straight off `status`:

| Matcher | Status |
| --- | --- |
| `hasStatus(n)` | any `n` |
| `is4xx()` / `is5xx()` | class of status |
| `isBadRequest()` | 400 |
| `isUnauthorized()` | 401 |
| `isForbidden()` | 403 |
| `isNotFound()` | 404 |
| `isNotAcceptable()` | 406 |
| `isConflict()` | 409 |
| `isUnsupportedMediaType()` | 415 |
| `isUnprocessable()` / `isValidationError()` | 422 |
| `isRateLimited()` | 429 |

Each entry in `error.errors` is a JSON:API error object — `status`, `code`, `title`, `detail`, `source`, `meta` — exactly as the server sent it, so you can surface a `detail` message or branch on an application `code`.

!!! note "`isValidationError()` is `isUnprocessable()`"
    They are aliases — 422 is the JSON:API validation status. Use whichever reads better at the call site.

## `byPath()` — map a 422 back to your input

When a write fails validation, the payoff is form UX: you want each field error keyed by the field you supplied, not by the wire pointer the server reported. Because the client built the JSON:API envelope from your flat input, it knows the inverse mapping — so on a thrown error it re-keys each error's `source.pointer` (e.g. `/data/attributes/title`) to the flat input path (`title`) and exposes `byPath()` to group by it:

```ts
const error = (await client.albums.create({ title: '' }).catch((e: unknown) => e)) as JsonApiError

error.isUnprocessable() // true
// The server pointer `/data/attributes/title` is remapped to the flat input key `title`.
error.byPath()['title']?.[0]?.detail // 'must not be blank'
```

`byPath()` returns a `Record<string, JsonApiErrorObject[]>` — an array per path, since a single field can fail more than one rule. Drive a form straight off it:

```ts
const fieldErrors = error.byPath()
setError('title', fieldErrors['title']?.[0]?.detail)
setError('artist', fieldErrors['artist']?.[0]?.detail)
```

The remapping is descriptor-aware, so it follows the same nesting your input used — nested map attributes, relationships, and pivot fields on a to-many write:

| Wire `source.pointer` | Flat `path` |
| --- | --- |
| `/data/attributes/title` | `title` |
| `/data/relationships/artist/data` | `artist` |
| `/data/attributes/releaseInfo/label` | `releaseInfo.label` |
| `/data/relationships/orderedTracks/data/0/meta/pivot/position` | `orderedTracks[0].$pivot.position` |

The raw `source.pointer` stays on each error object as an escape hatch, and `byPath()` falls back to it (then to `source.parameter`, then `_`) when no flat `path` was resolved.

!!! tip "Query-side errors keep `source.parameter`"
    A read that fails on an unrecognised `filter[x]` or `sort` token reports `source.parameter` (e.g. `filter[x]`) — already user-facing, so it is left as-is. `byPath()` groups those under the parameter key.

The remapping applies uniformly across write surfaces: resource [writes](writes.md), [relationship mutations](relationship-mutation.md), and custom actions that take a document input all get their 422 pointers re-keyed to the flat shape you passed.

??? note "Going deeper: atomic batches carry an `opIndex`"
    In an [atomic batch](atomic-operations.md), a `source.pointer` additionally carries an `/atomic:operations/{n}` prefix identifying which operation failed. On a thrown `JsonApiError`, the runtime parses that prefix into a zero-based `opIndex` on each error object and remaps the remainder to the flat `path` within *that op's* input:

    ```ts
    try {
      await client.atomic((tx) => {
        const artist = tx.create({ type: 'artists', name: 'Boards of Canada' })
        const album = tx.create({ type: 'albums', title: '', artist })
        return [artist, album] as const
      })
    } catch (error) {
      if (error instanceof JsonApiError && error.isUnprocessable()) {
        for (const e of error.errors) {
          e.opIndex // 1 — the second op (the album) failed
          e.path // 'title'
        }
      }
    }
    ```

    An atomic batch is all-or-nothing, so a single failed op rejects the whole `client.atomic(...)` call. See [atomic-operations](atomic-operations.md) for the batch model and how `opIndex` lines up with the positional result tuple.

## `StructuralGuardError` — a violated wire shape

Distinct from `JsonApiError` (an application error the server *reported*) is `StructuralGuardError`, thrown by the always-on light structural guards when a 2xx response is not a JSON:API document, or a `data`/`included` member is not a resource object carrying `type` + `id`. It signals that the wire shape the runtime relies on was violated — a broken server or a proxy that mangled the body — not something your input caused. The opt-in per-field [validator](validation.md) throws its own engine's error type, never this one.

## See it in the example app

- The tested 422 `byPath()` snippet lives in the `writes` group of [example.test.ts](../packages/example/src/example.test.ts) — every line runs under `pnpm test`.
- The error type surface, matchers, and `byPath()` grouping are defined in [errors.ts](../packages/client/src/errors.ts).

## Next

- [writes](writes.md) — the flat input the pointers remap back to.
- [validation](validation.md) — the opt-in seam that validates wire *responses* against their JSON Schema.
- [atomic-operations](atomic-operations.md) — batch errors and the `opIndex` prefix.
