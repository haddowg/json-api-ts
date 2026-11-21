import {
  nextPageParams,
  prevPageParams,
  type Page,
  type PageParamsOf,
} from '@haddowg/json-api-client'

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
  return nextPageParams(list)
}

/** The `page` params for the page before `list`, from its `prev` link. See {@link nextPage}. */
export function prevPage<P extends Page>(
  list: { readonly $page: P } | undefined,
): PageParams<P> | undefined {
  return prevPageParams(list)
}

// The walk is the client's own, kept exported here so Angular code imports it from one place.
export { loadAll, type LoadAllOptions } from '@haddowg/json-api-client'
