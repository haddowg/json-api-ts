import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { type Accepted, isAccepted, parseRetryAfter, PollTimeoutError } from './accepted'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import { JsonApiError } from './errors'
import type { ReadResult } from './result-types'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'

// Shaped like the music catalog's `catalog-exports`, whose create answers 202 with an
// `export-jobs` job, plus an update whose job type is no type of the API (as core's witness has
// `article-jobs`), an action answering with a meta-only job, and a type with no 202 at all.
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
  articles: {
    attributes: { title: 'string' },
    relations: {},
    paths: { fetchOne: '/articles/{id}', update: '/articles/{id}', create: '/articles' },
    paginator: 'none',
    clientId: 'forbidden',
    accepted: { update: { jobType: 'article-jobs' } },
    actions: {
      reindex: {
        scope: 'resource',
        path: '/articles/{id}/-actions/reindex',
        input: 'none',
        output: 'meta',
        accepted: { jobType: 'reindex-jobs' },
      },
      publish: {
        scope: 'resource',
        path: '/articles/{id}/-actions/publish',
        input: 'none',
        output: 'document',
        outputType: 'articles',
        outputCardinality: 'one',
      },
    },
  },
} as const satisfies ApiDescriptor

type Attributes = {
  'catalog-exports': { format: string }
  'export-jobs': { state: string }
  articles: { title: string }
}
type D = typeof descriptor

type Reply = TransportResponse | ((req: TransportRequest) => TransportResponse)

/** A transport answering each request with the next reply in turn. */
function scripted(...replies: Reply[]) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    if (req.signal?.aborted) {
      throw req.signal.reason
    }
    const reply = replies.shift()
    if (reply === undefined) {
      throw new Error(`Unexpected request to ${req.url}`)
    }
    return typeof reply === 'function' ? reply(req) : reply
  }
  return { requests, transport }
}

const client = (transport: (req: TransportRequest) => Promise<TransportResponse>) =>
  createClient<D, Attributes>(descriptor, { baseUrl: BASE, transport })

const doc = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers,
  body: JSON.stringify(body),
})

const job = (state: string) => ({
  data: { type: 'export-jobs', id: 'job-1', attributes: { state } },
})
const exported = { data: { type: 'catalog-exports', id: '7', attributes: { format: 'csv' } } }
const accepted202 = (headers: Record<string, string> = {}) =>
  doc(202, job('queued'), { 'content-location': `${BASE}/export-jobs/job-1`, ...headers })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a write that answers 202 Accepted', () => {
  it('resolves to an Accepted holding the materialised job, its URL and Retry-After', async () => {
    const { transport } = scripted(accepted202({ 'retry-after': '3' }))
    const result = await client(transport)['catalog-exports'].create({ format: 'csv' })
    expect(isAccepted(result)).toBe(true)
    if (!isAccepted(result)) {
      throw new Error('expected an accepted job')
    }
    expect(result.job.type).toBe('export-jobs')
    expect(result.job.state).toBe('queued')
    expect(result.contentLocation).toBe(`${BASE}/export-jobs/job-1`)
    expect(result.retryAfter).toBe(3)
    expect(Object.keys(result)).toEqual(['job', 'contentLocation', 'retryAfter'])
  })

  it('returns the normal result when the server answers synchronously', async () => {
    const { transport } = scripted(doc(201, exported))
    const result = await client(transport)['catalog-exports'].create({ format: 'csv' })
    expect(isAccepted(result)).toBe(false)
    expect(result).toMatchObject({ type: 'catalog-exports', id: '7', format: 'csv' })
  })

  it('polls until a followed redirect answers with the result', async () => {
    const { requests, transport } = scripted(
      accepted202({ 'retry-after': '2' }),
      doc(200, job('running'), { 'Retry-After': '5' }),
      doc(200, exported),
    )
    const pending = client(transport)['catalog-exports'].create({ format: 'csv' }, { wait: true })
    await vi.advanceTimersByTimeAsync(1999)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(requests).toHaveLength(2)
    expect(requests[1]!.method).toBe('GET')
    expect(requests[1]!.url).toBe(`${BASE}/export-jobs/job-1`)
    await vi.advanceTimersByTimeAsync(4999)
    expect(requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending
    expect(result).toMatchObject({ type: 'catalog-exports', id: '7', format: 'csv' })
  })

  it('fetches the Location of a 303 the transport did not follow', async () => {
    const { requests, transport } = scripted(
      accepted202(),
      doc(303, '', { Location: '/catalog-exports/7' }),
      doc(200, exported),
    )
    const result = await client(transport)['catalog-exports'].create({ format: 'csv' })
    if (!isAccepted(result)) {
      throw new Error('expected an accepted job')
    }
    const done = result.$poll()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await done).toMatchObject({ type: 'catalog-exports', id: '7' })
    expect(requests.map((req) => req.url)).toEqual([
      `${BASE}/catalog-exports`,
      `${BASE}/export-jobs/job-1`,
      `${BASE}/catalog-exports/7`,
    ])
  })

  it('waits for an HTTP-date Retry-After, falling back to the 202 when a poll sends none', async () => {
    const now = Date.now()
    const at = new Date(now + 4000).toUTCString()
    const { requests, transport } = scripted(
      accepted202({ 'Retry-After': at }),
      doc(200, job('running')),
      doc(200, exported),
    )
    const pending = client(transport)['catalog-exports'].create(
      { format: 'csv' },
      { wait: { timeout: 60_000 } },
    )
    await vi.advanceTimersByTimeAsync(3999)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(4000)
    await expect(pending).resolves.toMatchObject({ id: '7' })
  })

  it('rejects with a PollTimeoutError when the job is still pending at the timeout', async () => {
    const { transport } = scripted(
      accepted202({ 'retry-after': '1' }),
      doc(200, job('running')),
      doc(200, job('running')),
      doc(200, job('running')),
    )
    const pending = client(transport)['catalog-exports'].create(
      { format: 'csv' },
      { wait: { timeout: 2500 } },
    )
    const assertion = expect(pending).rejects.toThrow(PollTimeoutError)
    await vi.advanceTimersByTimeAsync(2500)
    await assertion
    await expect(pending).rejects.toMatchObject({
      contentLocation: `${BASE}/export-jobs/job-1`,
      timeout: 2500,
    })
  })

  it('polls once more at the timeout when Retry-After reaches past it', async () => {
    const { requests, transport } = scripted(
      accepted202({ 'retry-after': '10' }),
      doc(200, exported),
    )
    const pending = client(transport)['catalog-exports'].create(
      { format: 'csv' },
      { wait: { timeout: 3000 } },
    )
    await vi.advanceTimersByTimeAsync(2999)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toMatchObject({ id: '7' })
  })

  it('rejects with the abort reason when the signal aborts while waiting', async () => {
    const controller = new AbortController()
    const { requests, transport } = scripted(accepted202({ 'retry-after': '10' }))
    const pending = client(transport)['catalog-exports'].create(
      { format: 'csv' },
      { wait: { signal: controller.signal } },
    )
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(1000)
    controller.abort()
    await assertion
    expect(requests).toHaveLength(1)
  })

  it('throws the JsonApiError of a non-2xx answer from the job URL', async () => {
    const { transport } = scripted(
      accepted202(),
      doc(500, { errors: [{ status: '500', code: 'JOB_FAILED' }] }),
    )
    const pending = client(transport)['catalog-exports'].create({ format: 'csv' }, { wait: true })
    const assertion = expect(pending).rejects.toBeInstanceOf(JsonApiError)
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    await expect(pending).rejects.toMatchObject({ status: 500 })
  })

  it('throws when a 202 names no Content-Location', async () => {
    const { transport } = scripted(doc(202, job('queued')))
    await expect(client(transport)['catalog-exports'].create({ format: 'csv' })).rejects.toThrow(
      'without a Content-Location',
    )
  })

  it('materialises a job of a type the API does not declare', async () => {
    const { transport } = scripted(
      doc(
        202,
        { data: { type: 'article-jobs', id: 'a1', attributes: { progress: 0 } } },
        { 'Content-Location': '/article-jobs/a1' },
      ),
    )
    const result = await client(transport).articles.id('1').update({ title: 'New' })
    if (!isAccepted(result)) {
      throw new Error('expected an accepted job')
    }
    expect(result.job).toMatchObject({ type: 'article-jobs', id: 'a1', progress: 0 })
    expect(result.retryAfter).toBeUndefined()
  })

  it('reads a meta-only job as its meta and polls while the job URL answers with one', async () => {
    const { requests, transport } = scripted(
      doc(202, { meta: { progress: 0 } }, { 'Content-Location': '/jobs/r1' }),
      doc(200, { meta: { progress: 50 } }),
      doc(303, '', { Location: '/reindexed/1' }),
      doc(200, { meta: { reindexed: 12 } }),
    )
    const result = await client(transport).articles.id('1').actions.reindex()
    if (!isAccepted(result)) {
      throw new Error('expected an accepted job')
    }
    expect(result.job).toEqual({ progress: 0 })
    const done = result.$poll()
    await vi.advanceTimersByTimeAsync(2000)
    expect(await done).toEqual({ reindexed: 12 })
    expect(requests.map((req) => req.url)).toEqual([
      `${BASE}/articles/1/-actions/reindex`,
      `${BASE}/jobs/r1`,
      `${BASE}/jobs/r1`,
      `${BASE}/reindexed/1`,
    ])
  })

  it('polls an action with wait and the call signal', async () => {
    const controller = new AbortController()
    const { requests, transport } = scripted(
      doc(202, { meta: {} }, { 'Content-Location': '/jobs/r1' }),
      doc(200, { meta: {} }),
    )
    const pending = client(transport)
      .articles.id('1')
      .actions.reindex({ wait: true, signal: controller.signal })
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(1500)
    controller.abort()
    await assertion
    expect(requests).toHaveLength(2)
    expect(requests.every((req) => req.signal === controller.signal)).toBe(true)
  })

  it('leaves a 202 to an operation that declares none as it was', async () => {
    const { transport } = scripted(
      doc(202, { data: { type: 'articles', id: '1', attributes: { title: 'x' } } }),
    )
    const result = await client(transport).articles.id('1').actions.publish()
    expect(isAccepted(result)).toBe(false)
  })
})

describe('parseRetryAfter', () => {
  it('reads delta-seconds and an HTTP date as seconds from now', () => {
    const now = Date.parse('2026-11-11T10:00:00Z')
    expect(parseRetryAfter('120', now)).toBe(120)
    expect(parseRetryAfter('Wed, 11 Nov 2026 10:00:30 GMT', now)).toBe(30)
    expect(parseRetryAfter('Wed, 11 Nov 2026 09:00:00 GMT', now)).toBe(0)
    expect(parseRetryAfter('soon', now)).toBeUndefined()
    expect(parseRetryAfter(undefined, now)).toBeUndefined()
  })
})

describe('accepted write types', () => {
  // Only the types are under test, so no request ever answers.
  const typed = client(() => new Promise<TransportResponse>(() => {}))

  it('types a 202-declaring create as its result or an Accepted job', () => {
    type Created = ReadResult<D, Attributes, 'catalog-exports'>
    type Job = ReadResult<D, Attributes, 'export-jobs'>
    expectTypeOf(typed['catalog-exports'].create({ format: 'csv' })).toEqualTypeOf<
      Promise<Created | Accepted<Job, Created>>
    >()
    expectTypeOf(typed['catalog-exports'].create({ format: 'csv' }, { wait: true })).toEqualTypeOf<
      Promise<Created>
    >()
    expectTypeOf(
      typed['catalog-exports'].create({ format: 'csv' }, { wait: { timeout: 1000 } }),
    ).toEqualTypeOf<Promise<Created>>()
  })

  it('narrows the union with isAccepted', () => {
    const narrow = (result: Awaited<ReturnType<(typeof typed)['catalog-exports']['create']>>) => {
      if (isAccepted(result)) {
        expectTypeOf(result.job.state).toEqualTypeOf<string>()
        expectTypeOf(result.retryAfter).toEqualTypeOf<number | undefined>()
        expectTypeOf(result.$poll()).toEqualTypeOf<
          Promise<ReadResult<D, Attributes, 'catalog-exports'>>
        >()
      } else {
        expectTypeOf(result.format).toEqualTypeOf<string>()
      }
    }
    expectTypeOf(narrow).toBeFunction()
  })

  it('types a job of an undeclared type as an open record', () => {
    expectTypeOf(typed.articles.id('1').update({ title: 'x' })).toEqualTypeOf<
      Promise<
        | ReadResult<D, Attributes, 'articles'>
        | Accepted<Readonly<Record<string, unknown>>, ReadResult<D, Attributes, 'articles'>>
      >
    >()
  })

  it('keeps the types of a write that declares no 202', () => {
    expectTypeOf(typed.articles.create({ title: 'x' })).toEqualTypeOf<
      Promise<ReadResult<D, Attributes, 'articles'>>
    >()
    // @ts-expect-error -- wait is only offered where a 202 is declared
    void typed.articles.create({ title: 'x' }, { wait: true })
  })

  it('types an accepted action and narrows it with wait', () => {
    expectTypeOf(typed.articles.id('1').actions.reindex()).toEqualTypeOf<
      Promise<
        | Record<string, unknown>
        | Accepted<Readonly<Record<string, unknown>>, Record<string, unknown>>
      >
    >()
    expectTypeOf(typed.articles.id('1').actions.reindex({ wait: true })).toEqualTypeOf<
      Promise<Record<string, unknown>>
    >()
    expectTypeOf(typed.articles.id('1').actions.publish()).toEqualTypeOf<
      Promise<ReadResult<D, Attributes, 'articles'>>
    >()
  })
})
