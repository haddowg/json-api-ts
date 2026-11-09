import { describe, expect, it } from 'vitest'
import { listFilterMatcher } from './filters'
import { serializeQuery } from './request'

describe('listFilterMatcher', () => {
  it('is absent when nothing takes a list', () => {
    expect(listFilterMatcher(undefined)).toBeUndefined()
    expect(
      listFilterMatcher({
        filterable: ['title'],
        filterFamilies: [{ prefix: 'meta', suffixPattern: '.+' }],
      }),
    ).toBeUndefined()
  })

  it('matches list keys, then the longest family prefix, never a bare prefix', () => {
    const isList = listFilterMatcher({
      filterable: ['columns', 'title', 'value.exact'],
      listFilters: ['columns'],
      filterFamilies: [
        { prefix: 'value', suffixPattern: '.+', list: true },
        { prefix: 'value.meta', suffixPattern: '[a-z]+' },
        { prefix: 'tags', suffixPattern: '[a-z]+', list: true },
      ],
    })!
    expect(isList('columns')).toBe(true)
    expect(isList('title')).toBe(false)
    expect(isList('value.cap')).toBe(true)
    expect(isList('value.exact')).toBe(false)
    expect(isList('value.meta.name')).toBe(false)
    expect(isList('value')).toBe(false)
    expect(isList('tags.Upper')).toBe(false)
    expect(isList('tags.lower')).toBe(true)
  })
})

describe('serializeQuery with list filters', () => {
  it('sends a list filter once per member and joins every other array', () => {
    expect(
      decodeURIComponent(
        serializeQuery(
          { filter: { columns: ['a,b', 'c'], labels: ['x', 'y'] } },
          (key) => key === 'columns',
        ),
      ),
    ).toBe('filter[columns][]=a,b&filter[columns][]=c&filter[labels]=x,y')
  })

  it('percent-encodes a comma inside a member', () => {
    expect(serializeQuery({ filter: { columns: ['a,b'] } }, () => true)).toBe(
      'filter[columns][]=a%2Cb',
    )
  })
})
