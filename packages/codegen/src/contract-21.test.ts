import { readFileSync } from 'node:fs'
import type { TransportRequest } from '@haddowg/json-api-client'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type ArticlesAttributes,
  type ArticlesCreateAttributes,
  type ArticlesUpdateAttributes,
  createClient,
} from '../test/generated/contract-witness.client.gen'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'

const witness = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument

type Source = { href: string; retrievedAt: string | null }
type Step =
  | { operation: 'trim' }
  | { params: { find: string; replace: string } | null; operation: 'find_replace' }
type WriteSource = { href: string; retrievedAt?: string }
type WriteStep =
  | { operation: 'trim' }
  | { params?: { find?: string; replace?: string }; operation: 'find_replace' }

const article = {
  type: 'articles',
  id: 'art-1',
  attributes: {
    title: 'Hello',
    sources: [{ href: 'https://example.com/a', retrievedAt: null }],
    steps: [
      { operation: 'trim' },
      { operation: 'find_replace', params: { find: 'colour', replace: 'color' } },
    ],
  },
}

function witnessClient() {
  const requests: TransportRequest[] = []
  const client = createClient({
    baseUrl: 'https://api.example.com',
    transport: async (req) => {
      requests.push(req)
      return { status: 200, headers: {}, body: JSON.stringify({ data: article }) }
    },
  })
  return { client, requests }
}

describe('generator contract 21 (structured list elements)', () => {
  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(32)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('types a list of objects with its required and optional members', () => {
    expectTypeOf<ArticlesAttributes['sources']>().toEqualTypeOf<Source[] | null>()
    expectTypeOf<ArticlesCreateAttributes['sources']>().toEqualTypeOf<WriteSource[] | undefined>()
    expectTypeOf<ArticlesUpdateAttributes['sources']>().toEqualTypeOf<WriteSource[] | undefined>()
  })

  it('types a list of a discriminated union keyed by its const discriminator', () => {
    expectTypeOf<ArticlesAttributes['steps']>().toEqualTypeOf<Step[] | null>()
    expectTypeOf<ArticlesCreateAttributes['steps']>().toEqualTypeOf<WriteStep[] | undefined>()
    expectTypeOf<ArticlesUpdateAttributes['steps']>().toEqualTypeOf<WriteStep[] | undefined>()
  })

  it('emits the element types inline', () => {
    const source = emit(witness, buildDescriptor(witness))
    expect(source).toContain('  sources: { href: string; retrievedAt: string | null }[] | null\n')
    expect(source).toContain(
      '  steps: ({ operation: "trim" } | { params: { find: string; replace: string } | null; operation: "find_replace" })[] | null\n',
    )
  })

  it('reads the lists from a fetched resource', async () => {
    const { client } = witnessClient()
    const result = await client.articles.get('art-1')
    expectTypeOf(result.steps).toEqualTypeOf<Step[] | null>()
    expect(result.sources).toEqual([{ href: 'https://example.com/a', retrievedAt: null }])
    const step = result.steps?.[1]
    if (step?.operation === 'find_replace') {
      expectTypeOf(step.params).toEqualTypeOf<{ find: string; replace: string } | null>()
      expect(step.params?.find).toBe('colour')
    }
  })

  it('sends the lists as written on create and update', async () => {
    const { client, requests } = witnessClient()
    await client.articles.create({
      title: 'Hello',
      defaultValue: 'gold',
      sources: [{ href: 'https://example.com/a' }],
      steps: [{ operation: 'trim' }, { operation: 'find_replace', params: { find: 'a' } }],
    })
    await client.articles.id('art-1').update({ steps: [{ operation: 'trim' }] })
    const bodies = requests.map((req) => JSON.parse(String(req.body)) as unknown)
    expect(bodies[0]).toMatchObject({
      data: {
        attributes: {
          sources: [{ href: 'https://example.com/a' }],
          steps: [{ operation: 'trim' }, { operation: 'find_replace', params: { find: 'a' } }],
        },
      },
    })
    expect(bodies[1]).toMatchObject({ data: { attributes: { steps: [{ operation: 'trim' }] } } })
  })

  it('rejects an element missing a required child or naming an unknown variant', () => {
    const { client } = witnessClient()
    void (() =>
      client.articles.create({
        title: 'Hello',
        defaultValue: 'gold',
        // @ts-expect-error — a source needs its href.
        sources: [{ retrievedAt: '2026-01-01T00:00:00Z' }],
      }))
    void (() =>
      client.articles.create({
        title: 'Hello',
        defaultValue: 'gold',
        // @ts-expect-error — `upper` is not a step operation.
        steps: [{ operation: 'upper' }],
      }))
    void (() =>
      client.articles.id('art-1').update({
        // @ts-expect-error — a step needs its operation.
        steps: [{ params: { find: 'a', replace: 'b' } }],
      }))
    // @ts-expect-error — a `trim` step takes no params.
    const trim: WriteStep = { operation: 'trim', params: { find: 'a' } }
    void trim
  })
})
