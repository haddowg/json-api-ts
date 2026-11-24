import type {
  AtomicCreateInput,
  AtomicUpdateInput,
  CreateInput,
  UpdateInput,
} from '@haddowg/json-api-client'
import { describe, expectTypeOf, it } from 'vitest'
import type { ResourceMap, WriteAttributes } from '../test/generated/contract-witness.client.gen'

// The witness requires `people.company` on create and refuses `null` for it on create and update,
// and requires `tags.articles` on create, refusing an empty list there.
type Map = ResourceMap

/** Whether input `I` must carry key `K`. */
type Requires<I, K extends keyof I> = {} extends Pick<I, K> ? false : true

/** Whether input `I` takes `null` at key `K`. */
type TakesNull<I, K extends keyof I> = null extends I[K] ? true : false

type PersonCreate = CreateInput<Map, WriteAttributes, 'people'>
type PersonUpdate = UpdateInput<Map, WriteAttributes, 'people'>
type TagCreate = CreateInput<Map, WriteAttributes, 'tags'>
type TagUpdate = UpdateInput<Map, WriteAttributes, 'tags'>

// The witness serves no `companies` type, so a company reference has no value to write here: the
// cases read the input types instead of building a person.
describe('required relations on write inputs', () => {
  it('requires a relation a create must send', () => {
    expectTypeOf<Requires<PersonCreate, 'company'>>().toEqualTypeOf<true>()
    expectTypeOf<Requires<TagCreate, 'articles'>>().toEqualTypeOf<true>()
    const tag: TagCreate = {
      id: 'tag-1',
      label: 'php',
      articles: [{ type: 'articles', id: 'art-1' }],
    }
    // @ts-expect-error a tag's create must name its articles
    const noArticles: TagCreate = { id: 'tag-1', label: 'php' }
    void [tag, noArticles]
  })

  it('refuses null for a required to-one that is not nullable', () => {
    expectTypeOf<TakesNull<PersonCreate, 'company'>>().toEqualTypeOf<false>()
    expectTypeOf<TakesNull<PersonUpdate, 'company'>>().toEqualTypeOf<false>()
  })

  it('takes a non-empty list for a required to-many', () => {
    // @ts-expect-error a tag's create must name at least one article
    const empty: TagCreate = { id: 'tag-1', label: 'php', articles: [] }
    const add: AtomicCreateInput<Map, WriteAttributes, 'tags'> = {
      type: 'tags',
      id: 'tag-1',
      label: 'php',
      // @ts-expect-error an atomic add must name at least one too
      articles: [],
    }
    // An update may empty it: it is required on create only.
    const update: TagUpdate = { articles: [] }
    void [empty, add, update]
  })

  it('leaves every relation optional on an update', () => {
    expectTypeOf<Requires<PersonUpdate, 'company'>>().toEqualTypeOf<false>()
    expectTypeOf<Requires<TagUpdate, 'articles'>>().toEqualTypeOf<false>()
    const update: TagUpdate = { label: 'php' }
    void update
  })

  it('types the atomic create and update the same way', () => {
    type Add = AtomicCreateInput<Map, WriteAttributes, 'people'>
    type Change = Extract<AtomicUpdateInput<Map, WriteAttributes, 'people'>, { id: string }>
    expectTypeOf<Requires<Add, 'company'>>().toEqualTypeOf<true>()
    expectTypeOf<TakesNull<Add, 'company'>>().toEqualTypeOf<false>()
    expectTypeOf<TakesNull<Change, 'company'>>().toEqualTypeOf<false>()
    const tagAdd: AtomicCreateInput<Map, WriteAttributes, 'tags'> = {
      type: 'tags',
      id: 'tag-1',
      label: 'php',
      articles: [{ type: 'articles', lid: 'a' }],
    }
    // @ts-expect-error an atomic add of a tag must name its articles
    const missing: AtomicCreateInput<Map, WriteAttributes, 'tags'> = {
      type: 'tags',
      id: 'tag-1',
      label: 'php',
    }
    void [tagAdd, missing]
  })

  it('keeps a relation without the flags as it was', () => {
    // An article's author is neither required nor refused null by any write.
    type Article = CreateInput<Map, WriteAttributes, 'articles'>
    expectTypeOf<Requires<Article, 'author'>>().toEqualTypeOf<false>()
    expectTypeOf<TakesNull<Article, 'author'>>().toEqualTypeOf<true>()
    expectTypeOf<
      TakesNull<UpdateInput<Map, WriteAttributes, 'articles'>, 'author'>
    >().toEqualTypeOf<true>()
  })
})
