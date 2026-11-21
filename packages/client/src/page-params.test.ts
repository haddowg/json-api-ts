import { describe, expect, expectTypeOf, it } from 'vitest'
import type { Page } from './pagination'
import { nextPageParams, prevPageParams } from './pagination'

const page = (p: Partial<Page> & Pick<Page, 'keys'>): Page => ({
  kind: 'page',
  links: {},
  ...p,
})

describe('nextPageParams / prevPageParams', () => {
  it('reads counts as numbers under their wire keys', () => {
    const $page = page({
      keys: { number: 'number', size: 'size' },
      links: {
        next: 'https://api.example/albums?page%5Bnumber%5D=3&page%5Bsize%5D=1',
        prev: '/albums?page[number]=1&page[size]=1',
      },
    })
    expect(nextPageParams({ $page })).toEqual({ number: 3, size: 1 })
    expect(prevPageParams({ $page })).toEqual({ number: 1, size: 1 })
  })

  it('reads cursors as strings, even when they look numeric', () => {
    const $page = page({
      kind: 'cursor',
      keys: { after: 'after', before: 'before', size: 'size' },
      links: { next: '/albums?page[after]=abc%3D&page[size]=1', prev: '/albums?page[before]=12' },
    })
    expect(nextPageParams({ $page })).toEqual({ after: 'abc=', size: 1 })
    expect(prevPageParams({ $page })).toEqual({ before: '12' })
  })

  it('keeps renamed keys under their wire names', () => {
    const $page = page({
      keys: { number: 'p', size: 'per' },
      links: { next: '/pages?page[p]=2&page[per]=10' },
    })
    expect(nextPageParams({ $page })).toEqual({ p: 2, per: 10 })
  })

  it("carries a menu arm's kind as a string", () => {
    const $page = page({
      keys: { number: 'p', size: 'size' },
      arm: 'numbered',
      links: { next: '/albums?page%5Bkind%5D=numbered&page%5Bp%5D=2&page%5Bsize%5D=10' },
    })
    expect(nextPageParams({ $page })).toEqual({ kind: 'numbered', p: 2, size: 10 })
  })

  it('ignores non-page parameters and fragments', () => {
    const $page = page({
      keys: { number: 'number' },
      links: { next: '/albums?sort=title&page[number]=2#top' },
    })
    expect(nextPageParams({ $page })).toEqual({ number: 2 })
  })

  it('is undefined for an absent link or an absent list', () => {
    const $page = page({ keys: { number: 'number' }, links: { next: '/albums?page[number]=2' } })
    expect(prevPageParams({ $page })).toBeUndefined()
    expect(nextPageParams(undefined)).toBeUndefined()
    expect(prevPageParams(undefined)).toBeUndefined()
  })

  it('types the params from the page it was read from', () => {
    const typed = {
      $page: {
        kind: 'page' as const,
        keys: { number: 'number', size: 'size' } as const,
        links: { next: '/albums?page[number]=2&page[size]=1' },
      },
    }
    expectTypeOf(nextPageParams(typed)).toEqualTypeOf<
      { number?: number; size?: number } | undefined
    >()
  })
})
