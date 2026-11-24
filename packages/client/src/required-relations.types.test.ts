import { describe, expectTypeOf, it } from 'vitest'
import type { AtomicCreateInput, AtomicUpdateInput } from './atomic'
import type { ApiDescriptor } from './descriptor'
import type { CreateInput, UpdateInput } from './result-types'

// A descriptor shaped like codegen output from a document listing required relations: a create
// must name the `owner`, who is never cleared, and at least the `watchers` key; the `reviewer`
// is required but nullable, and the `editor` refuses `null` only on an update.
const map = {
  tasks: {
    attributes: { title: 'string' },
    relations: {
      owner: {
        cardinality: 'one',
        types: ['users'],
        pivot: false,
        requiredOnCreate: true,
        nonNullOn: ['create', 'update'],
        mutations: { set: true },
      },
      reviewer: {
        cardinality: 'one',
        types: ['users'],
        pivot: false,
        requiredOnCreate: true,
        mutations: { set: true },
      },
      editor: {
        cardinality: 'one',
        types: ['users'],
        pivot: false,
        nonNullOn: ['update'],
        mutations: { set: true },
      },
      watchers: {
        cardinality: 'many',
        types: ['users'],
        pivot: false,
        requiredOnCreate: true,
        mutations: { add: true, remove: true, replace: true },
      },
    },
    paths: { create: '/tasks', update: '/tasks/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
  users: {
    attributes: { name: 'string' },
    relations: {},
    paths: { fetchOne: '/users/{id}' },
    paginator: 'page',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

type Map = typeof map

interface WriteAttributes {
  tasks: { create: { title: string }; update: { title?: string } }
}

const user = { type: 'users', id: '1' } as const

describe('required relations', () => {
  it('are required keys of a create', () => {
    const create: CreateInput<Map, WriteAttributes, 'tasks'> = {
      title: 'Ship',
      owner: user,
      reviewer: null,
      watchers: [],
    }
    // @ts-expect-error the owner, reviewer and watchers are required
    const missing: CreateInput<Map, WriteAttributes, 'tasks'> = { title: 'Ship' }
    const add: AtomicCreateInput<Map, WriteAttributes, 'tasks'> = {
      type: 'tasks',
      title: 'Ship',
      owner: { type: 'users', lid: 'u' },
      reviewer: user,
      watchers: [user],
    }
    void [create, missing, add]
  })

  it('refuse null where the descriptor says so', () => {
    const create: CreateInput<Map, WriteAttributes, 'tasks'> = {
      title: 'Ship',
      // @ts-expect-error the owner can't be null on a create
      owner: null,
      reviewer: null,
      watchers: [],
      editor: null,
    }
    // @ts-expect-error nor on an update
    const update: UpdateInput<Map, WriteAttributes, 'tasks'> = { owner: null }
    // @ts-expect-error the editor refuses null on an update only
    const editor: UpdateInput<Map, WriteAttributes, 'tasks'> = { editor: null }
    const atomic: AtomicUpdateInput<Map, WriteAttributes, 'tasks'> = {
      type: 'tasks',
      id: '1',
      // @ts-expect-error an atomic update refuses it too
      owner: null,
    }
    void [create, update, editor, atomic]
  })

  it('stay optional on an update', () => {
    expectTypeOf<{ title: 'Replan' }>().toMatchTypeOf<UpdateInput<Map, WriteAttributes, 'tasks'>>()
    expectTypeOf<{ owner: typeof user }>().toMatchTypeOf<
      UpdateInput<Map, WriteAttributes, 'tasks'>
    >()
    expectTypeOf<{ reviewer: null }>().toMatchTypeOf<UpdateInput<Map, WriteAttributes, 'tasks'>>()
  })
})
