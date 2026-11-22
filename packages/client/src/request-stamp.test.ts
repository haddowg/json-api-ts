import { describe, expect, it, vi } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import { requestStampOf } from './request-stamp'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://music.example'

const descriptor = {
  albums: {
    attributes: { title: 'string' },
    relations: { tracks: { cardinality: 'many', types: ['tracks'], pivot: false } },
    paths: {
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      fetchRelated: '/albums/{id}/{rel}',
      fetchRelationship: '/albums/{id}/relationships/{rel}',
      create: '/albums',
      update: '/albums/{id}',
    },
    paginator: 'page',
    clientId: 'forbidden',
  },
  tracks: {
    attributes: { title: 'string' },
    relations: {},
    paths: {},
    paginator: 'page',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

/** A request the test answers when it chooses, so it controls the order responses arrive in. */
interface Pending {
  req: TransportRequest
  reply(body: unknown): void
}

function setup() {
  const pending: Pending[] = []
  const transport = (req: TransportRequest) =>
    new Promise<TransportResponse>((resolve) => {
      pending.push({
        req,
        reply: (body) => resolve({ status: 200, headers: {}, body: JSON.stringify(body) }),
      })
    })
  const client = createClient(descriptor, {
    baseUrl: BASE,
    transport,
    atomic: { path: '/operations' },
  })
  /** The `n`th request (from 0), once the client has sent it. */
  const request = async (n: number): Promise<Pending> => {
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(n))
    return pending[n] as Pending
  }
  return { client, request }
}

const album = (id: string, title: string) => ({ type: 'albums', id, attributes: { title } })

/** The stamp of `value`, asserting it has one. */
function stampOf(value: unknown): number {
  const stamp = requestStampOf(value)
  expect(stamp).toBeTypeOf('number')
  return stamp as number
}

describe('request stamps', () => {
  it('stamps a read with when its request started, not when it answered', async () => {
    const { client, request } = setup()
    const first = client.albums.get('1')
    const second = client.albums.list()
    ;(await request(1)).reply({ data: [album('1', 'Later')] })
    const listed = await second
    ;(await request(0)).reply({ data: album('1', 'Earlier') })
    const fetched = await first

    expect(stampOf(fetched)).toBeLessThan(stampOf(listed))
  })

  it('stamps related and relationship reads', async () => {
    const { client, request } = setup()
    const related = client.albums.id('1').rel('tracks').related()
    const linkage = client.albums.id('1').rel('tracks').get()
    ;(await request(0)).reply({ data: [{ type: 'tracks', id: '7', attributes: { title: 'T' } }] })
    ;(await request(1)).reply({ data: [{ type: 'tracks', id: '7' }] })

    expect(stampOf(await related)).toBeLessThan(stampOf(await linkage))
  })

  it('stamps the pages $next() and $prev() read with their own request start', async () => {
    const { client, request } = setup()
    const reading = client.albums.list()
    ;(await request(0)).reply({
      data: [album('1', 'One')],
      links: { next: `${BASE}/albums?page%5Bnumber%5D=2` },
    })
    const first = await reading
    const nexting = first.$next()
    ;(await request(1)).reply({
      data: [album('2', 'Two')],
      links: { prev: `${BASE}/albums?page%5Bnumber%5D=1` },
    })
    const next = await nexting
    const preving = next!.$prev()
    ;(await request(2)).reply({ data: [album('1', 'One again')] })
    const prev = await preving

    expect(stampOf(first)).toBeLessThan(stampOf(next))
    expect(stampOf(next)).toBeLessThan(stampOf(prev))
  })

  it('stamps what a create or an update returns', async () => {
    const { client, request } = setup()
    const reading = client.albums.get('1')
    const creating = client.albums.create({ title: 'New' })
    const updating = client.albums.id('1').update({ title: 'Renamed' })
    ;(await request(2)).reply({ data: album('1', 'Renamed') })
    ;(await request(1)).reply({ data: album('2', 'New') })
    ;(await request(0)).reply({ data: album('1', 'Read') })

    const read = stampOf(await reading)
    const created = stampOf(await creating)
    const updated = stampOf(await updating)
    expect(read).toBeLessThan(created)
    expect(created).toBeLessThan(updated)
  })

  it('stamps an atomic batch’s results, and each result’s data, with the batch’s start', async () => {
    const { client, request } = setup()
    const reading = client.albums.get('1')
    const batch = client.atomic((tx) => {
      tx.update({ type: 'albums', id: '1', title: 'Batched' })
    })
    const tuple = client.atomic((tx) => [tx.update({ type: 'albums', id: '1', title: 'Tuple' })])
    ;(await request(1)).reply({ 'atomic:results': [{ data: album('1', 'Batched') }] })
    ;(await request(2)).reply({ 'atomic:results': [{ data: album('1', 'Tuple') }] })
    ;(await request(0)).reply({ data: album('1', 'Read') })

    const read = stampOf(await reading)
    const results = await batch
    const stamp = stampOf(results)
    expect(read).toBeLessThan(stamp)
    expect(stampOf(results[0]?.data)).toBe(stamp)
    const positional = await tuple
    expect(stampOf(positional)).toBeGreaterThan(stamp)
    expect(stampOf(positional[0]?.data)).toBe(stampOf(positional))
  })

  it('stamps nothing it did not return', async () => {
    const { client, request } = setup()
    const reading = client.albums.get('1')
    ;(await request(0)).reply({ data: album('1', 'Read') })
    const read = await reading

    expect(requestStampOf({ ...read })).toBeUndefined()
    expect(requestStampOf(JSON.parse(JSON.stringify(read)))).toBeUndefined()
    expect(requestStampOf(undefined)).toBeUndefined()
  })
})
