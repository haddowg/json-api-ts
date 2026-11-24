import type {
  AtomicCreateInput,
  AtomicUpdateInput,
  CreateInput,
  UpdateInput,
} from '@haddowg/json-api-client'
import { describe, expectTypeOf, it } from 'vitest'
import type {
  ResourceMap as PinnedMap,
  WriteAttributes,
} from '../test/generated/contract-witness.client.gen'

type Relations<T extends keyof PinnedMap> = PinnedMap[T]['relations']

/**
 * The descriptor the codegen builds from the contract-46 graft of the pinned witness (see
 * `contract-46.test.ts`): `people.company` required on create and refusing `null` on create and
 * update, `tags.articles` required on create and refusing an empty list there. It goes once the pins move to a core release at 46
 * and the generated witness client carries them itself.
 */
type Map = Omit<PinnedMap, 'people' | 'tags'> & {
  people: Omit<PinnedMap['people'], 'relations'> & {
    relations: Omit<Relations<'people'>, 'company'> & {
      company: Relations<'people'>['company'] & {
        requiredOnCreate: true
        nonNullOn: readonly ['create', 'update']
      }
    }
  }
  tags: Omit<PinnedMap['tags'], 'relations'> & {
    relations: Omit<Relations<'tags'>, 'articles'> & {
      articles: Relations<'tags'>['articles'] & {
        requiredOnCreate: true
        nonEmptyOn: readonly ['create']
      }
    }
  }
}

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

  it('keeps a descriptor without the flags as it was', () => {
    type Person = CreateInput<PinnedMap, WriteAttributes, 'people'>
    expectTypeOf<Requires<Person, 'company'>>().toEqualTypeOf<false>()
    expectTypeOf<TakesNull<Person, 'company'>>().toEqualTypeOf<true>()
    expectTypeOf<
      Requires<CreateInput<PinnedMap, WriteAttributes, 'tags'>, 'articles'>
    >().toEqualTypeOf<false>()
  })
})
