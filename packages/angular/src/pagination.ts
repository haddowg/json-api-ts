import type { Collection, Page, PageParamsOf, PaginatorRole } from '@haddowg/json-api-client'

/**
 * The `page` query a link selects, typed by the `$page` it came from: the strategy's members under
 * their wire keys (counts as numbers, cursors as strings), plus the menu arm the read picked.
 */
export type PageParams<P extends Page = Page> = PageParamsOf<P>

/**
 * The `page` params for the page after `list`, read from its `next` link, or `undefined` on the
 * last page (or before anything has loaded). Works the same for every strategy, because the
 * server's link already carries the right parameters. Feed the result back into the signal your
 * resource's params read:
 *
 * ```ts
 * const next = nextPage(this.albums.value())
 * if (next) this.page.set(next)
 * ```
 */
export function nextPage<P extends Page>(
  list: { readonly $page: P } | undefined,
): PageParams<P> | undefined {
  return pageParams(list?.$page, list?.$page.links.next)
}

/** The `page` params for the page before `list`, from its `prev` link. See {@link nextPage}. */
export function prevPage<P extends Page>(
  list: { readonly $page: P } | undefined,
): PageParams<P> | undefined {
  return pageParams(list?.$page, list?.$page.links.prev)
}

const CURSOR_ROLES: readonly string[] = ['after', 'before']

function pageParams<P extends Page>(
  page: P | undefined,
  link: string | undefined,
): PageParams<P> | undefined {
  if (page === undefined || link === undefined) {
    return undefined
  }
  const keys = Object.entries(page.keys) as [PaginatorRole, string][]
  const query = link.includes('?') ? link.slice(link.indexOf('?') + 1).split('#')[0] : ''
  const params: Record<string, string | number> = {}
  for (const [name, value] of new URLSearchParams(query)) {
    const member = /^page\[([^\]]+)\]$/.exec(name)?.[1]
    if (member === undefined) {
      continue
    }
    const role = keys.find(([, key]) => key === member)?.[0]
    const count = Number(value)
    params[member] =
      role !== undefined && !CURSOR_ROLES.includes(role) && value !== '' && Number.isFinite(count)
        ? count
        : value
  }
  return params as PageParams<P>
}

/** Options for {@link loadAll}. */
export interface LoadAllOptions {
  /** Stops the walk, rejecting with the signal's reason. Pass the loader's `abortSignal`. */
  signal?: AbortSignal
  /** Stop after this many pages, as a guard against an unexpectedly large collection. */
  maxPages?: number
}

/**
 * Follow `next` links from the first page until the last, and return every member in one plain
 * array. Use it inside a loader to read a whole (small) collection:
 *
 * ```ts
 * loader: ({ client, abortSignal }) =>
 *   loadAll(client.genres.list({ signal: abortSignal }), { signal: abortSignal })
 * ```
 */
export async function loadAll<T>(
  first: Collection<T> | PromiseLike<Collection<T>>,
  options: LoadAllOptions = {},
): Promise<T[]> {
  const { signal, maxPages = Number.POSITIVE_INFINITY } = options
  let page: Collection<T> | undefined = await first
  const all: T[] = []
  let count = 0
  while (page !== undefined && count < maxPages) {
    all.push(...page)
    count++
    if (count >= maxPages) {
      break
    }
    signal?.throwIfAborted()
    page = await page.$next(signal !== undefined ? { signal } : undefined)
  }
  return all
}
