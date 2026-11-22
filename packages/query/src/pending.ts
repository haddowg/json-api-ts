/**
 * Rendering the creates an optimistic draft placed in a list but couldn't show as members: {@link withPending} merges a list's members with a placeholder per pending create, in the
 * places the creates' `into` chose.
 */
import type {
  ApiDescriptor,
  CreateInput,
  MemberTypeOf,
  PendingCreate,
  TypeName,
} from '@haddowg/json-api-client'

/**
 * A pending create of type `T` with its input typed: what `list.$pending()` returns for a list of
 * `T`, with `input` typed by the generated write types `W`. Annotate {@link withPending}'s
 * placeholder parameter with it to read the input's attributes typed.
 */
export type PendingCreateOf<D extends ApiDescriptor, W, T extends TypeName<D>> = PendingCreate<
  Readonly<CreateInput<D, W, T>>,
  T
>

/** A list that may carry pending creates: any collection the client materialised. */
export type PendingList<M> = readonly M[] & { $pending?(): readonly PendingCreate[] }

/** An infinite query's data: its pages, each a list. */
export interface PendingPages<M> {
  readonly pages: readonly PendingList<M>[]
}

/**
 * Builds a placeholder row for a pending create. Declared as a method so its parameter is
 * bivariant: a placeholder annotated with a narrower entry, such as {@link PendingCreateOf}, fits.
 */
type Placeholder<M, R> = {
  placeholder(pending: PendingCreate<Readonly<Record<string, unknown>>, MemberTypeOf<M>>): R
}['placeholder']

/**
 * One array of a list's members and a placeholder row for each create pending on it, each in the
 * place its `into` chose: `'start'` before the first member, `'end'` after the last, an index before
 * the member at that index (after the last when past it). Creates pending at the same place keep
 * the order they were made in. With no pending creates, it is a plain copy of the members.
 *
 * Pass an infinite query's data (`{ pages }`) to get every loaded page's members in order, each
 * page merged with the creates pending on it: a `'start'` create on the first page, an `'end'` one
 * on the last, an index into the page it was placed on.
 *
 * ```tsx
 * withPending(playlists, (pending) => ({ id: pending.id, title: pending.input.title, pending }))
 * ```
 */
export function withPending<M, R>(
  list: PendingList<M> | PendingPages<M>,
  placeholder: Placeholder<M, R>,
): Array<M | R> {
  const pages = isPages(list) ? list.pages : [list]
  return pages.flatMap((page) => mergePage(page, placeholder))
}

function isPages<M>(value: PendingList<M> | PendingPages<M>): value is PendingPages<M> {
  return !Array.isArray(value) && Array.isArray((value as { pages?: unknown }).pages)
}

function mergePage<M, R>(page: PendingList<M>, placeholder: Placeholder<M, R>): Array<M | R> {
  const pending = page.$pending?.() ?? []
  if (pending.length === 0) {
    return [...page]
  }
  const before = new Map<number, R[]>()
  const at = (index: number, row: R) => {
    const rows = before.get(index) ?? []
    rows.push(row)
    before.set(index, rows)
  }
  for (const entry of pending) {
    const row = placeholder(
      entry as PendingCreate<Readonly<Record<string, unknown>>, MemberTypeOf<M>>,
    )
    if (entry.at === 'start') {
      at(0, row)
    } else if (entry.at === 'end') {
      at(page.length, row)
    } else {
      at(Math.max(0, Math.min(page.length, Math.trunc(entry.at))), row)
    }
  }
  const out: Array<M | R> = []
  for (let index = 0; index <= page.length; index++) {
    out.push(...(before.get(index) ?? []))
    if (index < page.length) {
      out.push(page[index]!)
    }
  }
  return out
}
