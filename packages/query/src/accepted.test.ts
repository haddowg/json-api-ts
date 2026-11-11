import {
  type Accepted,
  type ApiDescriptor,
  createClient,
  isAccepted,
  type ReadResult,
  type TransportResponse,
} from '@haddowg/json-api-client'
import { QueryClient } from '@tanstack/query-core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { resourceKey } from './keys'
import { createMutationApi, createMutationOptions, type MutationOptions } from './mutate'

const BASE = 'https://music.example'

// `catalog-exports` creates answer 202 with an `export-jobs` job; `albums` declares no 202.
const descriptor = {
  'catalog-exports': {
    attributes: { format: 'string' },
    relations: {},
    paths: { create: '/catalog-exports', fetchOne: '/catalog-exports/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
    accepted: { create: { jobType: 'export-jobs' } },
  },
  'export-jobs': {
    attributes: { state: 'string' },
    relations: {},
    paths: { fetchOne: '/export-jobs/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
  albums: {
    attributes: { title: 'string' },
    relations: {},
    paths: { create: '/albums', fetchOne: '/albums/{id}', update: '/albums/{id}' },
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

type D = typeof descriptor
type Attributes = {
  'catalog-exports': { format: string }
  'export-jobs': { state: string }
  albums: { title: string }
}

const accepted: TransportResponse = {
  status: 202,
  headers: { 'content-location': `${BASE}/export-jobs/1` },
  body: JSON.stringify({ data: { type: 'export-jobs', id: '1', attributes: { state: 'queued' } } }),
}

const client = createClient<D, Attributes>(descriptor, {
  baseUrl: BASE,
  transport: async () => accepted,
})

function runMutation<TData, TVars, TContext>(
  qc: QueryClient,
  options: MutationOptions<TData, TVars, TContext>,
  variables: TVars,
): Promise<TData> {
  return qc
    .getMutationCache()
    .build<TData, unknown, TVars, TContext>(qc, options as never)
    .execute(variables)
}

describe('mutations of a write that declares a 202', () => {
  it('resolves to the Accepted job and leaves the cache alone', async () => {
    const qc = new QueryClient()
    qc.setQueryData(resourceKey('export-jobs', '1'), { type: 'export-jobs', id: '1', state: 'x' })
    const result = await runMutation(
      qc,
      createMutationOptions(qc, client, descriptor, 'catalog-exports'),
      { format: 'csv' },
    )
    expect(isAccepted(result)).toBe(true)
    expect(qc.getQueryData(resourceKey('export-jobs', '1'))).toMatchObject({ state: 'x' })
  })

  it('types the result as the union, narrowed by wait', () => {
    const qc = new QueryClient()
    type Created = ReadResult<D, Attributes, 'catalog-exports'>
    type Job = ReadResult<D, Attributes, 'export-jobs'>
    expectTypeOf(
      createMutationOptions(qc, client, descriptor, 'catalog-exports').mutationFn,
    ).returns.toEqualTypeOf<Promise<Created | Accepted<Job, Created>>>()
    expectTypeOf(
      createMutationOptions(qc, client, descriptor, 'catalog-exports', { wait: true }).mutationFn,
    ).returns.toEqualTypeOf<Promise<Created>>()
    const api = createMutationApi(qc, client, descriptor)
    expectTypeOf(
      api['catalog-exports'].create({ wait: { timeout: 1000 } }).mutationFn,
    ).returns.toEqualTypeOf<Promise<Created>>()
  })

  it('keeps the result of a write that declares none', () => {
    const qc = new QueryClient()
    expectTypeOf(
      createMutationOptions(qc, client, descriptor, 'albums').mutationFn,
    ).returns.toEqualTypeOf<Promise<ReadResult<D, Attributes, 'albums'>>>()
    expectTypeOf(
      createMutationApi(qc, client, descriptor).albums.id('1').update().mutationFn,
    ).returns.toEqualTypeOf<Promise<ReadResult<D, Attributes, 'albums'>>>()
    // @ts-expect-error -- wait is only offered where a 202 is declared
    void createMutationOptions(qc, client, descriptor, 'albums', { wait: true })
  })
})
