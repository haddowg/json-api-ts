import type { Collection, Page } from '@haddowg/json-api-client'

/** The `page` query a link selects: its `page[...]` parameters, keyed without the prefix. */
export type PageParams = Record<string, string>

/**
 * The `page` params for the page after `list`, read from its `next` link, or `undefined` on the
 * last page (or before anything has loaded). Works the same for page, offset and cursor
 * pagination, because the server's link already carries the right parameters. Feed the result
 * back into the signal your resource's params read:
 *
 * ```ts
 * const next = nextPage(this.albums.value())
 * if (next) this.page.set(next)
 * ```
 */
export function nextPage(list: { readonly $page: Page } | undefined): PageParams | undefined {
  return pageParams(list?.$page.links.next)
}

/** The `page` params for the page before `list`, from its `prev` link. See {@link nextPage}. */
export function prevPage(list: { readonly $page: Page } | undefined): PageParams | undefined {
  return pageParams(list?.$page.links.prev)
}

function pageParams(link: string | undefined): PageParams | undefined {
  if (link === undefined) {
    return undefined
  }
  const query = link.includes('?') ? link.slice(link.indexOf('?') + 1).split('#')[0] : ''
  const params: PageParams = {}
  for (const [key, value] of new URLSearchParams(query)) {
    const match = /^page\[([^\]]+)\]$/.exec(key)
    if (match?.[1] !== undefined) {
      params[match[1]] = value
    }
  }
  return params
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
