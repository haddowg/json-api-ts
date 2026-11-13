import { readFileSync } from 'node:fs'
import type { TransportRequest } from '@haddowg/json-api-client'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  createClient,
  type ErrorCode,
  type ErrorCodeByStatus,
  ErrorCodes,
} from '../test/generated/contract-witness.client.gen'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import { readErrorCatalogue } from './error-codes'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'

const witness = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument
const descriptor = buildDescriptor(witness)

const MEMBERSHIP = 'MEMBERSHIP_CHANGE_PROHIBITED'

function witnessClient(body: unknown) {
  const requests: TransportRequest[] = []
  const client = createClient({
    baseUrl: 'https://api.example.com',
    transport: async (req) => {
      requests.push(req)
      return { status: 200, headers: {}, body: JSON.stringify(body) }
    },
  })
  return { client, requests }
}

/** The witness without the fixed membership code: its branch, its example and its mentions. */
function withoutFixedMembership(): OpenApiDocument {
  return JSON.parse(JSON.stringify(witness), (key, value: unknown) => {
    if (key === MEMBERSHIP) {
      return undefined
    }
    return Array.isArray(value)
      ? value.filter(
          (entry: unknown) =>
            !(typeof entry === 'object' && entry !== null && 'const' in entry) ||
            entry.const !== MEMBERSHIP,
        )
      : value
  }) as OpenApiDocument
}

/**
 * The witness without its identified `MorphToMany`: no `sponsors` endpoints, no `sponsors` member
 * on any resource or request, and none of its components.
 */
function withoutIdentifiedPivots(): OpenApiDocument {
  const doc = JSON.parse(JSON.stringify(witness), (key, value: unknown) =>
    key === 'sponsors' ? undefined : value,
  ) as OpenApiDocument
  for (const path of Object.keys(doc.paths!)) {
    if (path.endsWith('/sponsors')) {
      delete doc.paths![path]
    }
  }
  for (const name of Object.keys(doc.components!.schemas!)) {
    if (name.startsWith('ArticlesSponsors')) {
      delete doc.components!.schemas![name]
    }
  }
  return doc
}

const linkage = {
  data: [
    {
      type: 'people',
      id: 'per-1',
      meta: { pivot: { rank: 1, since: '2026-01-01T00:00:00+00:00' } },
    },
    { type: 'images', id: 'img-1', meta: { pivot: { rank: 2, since: null } } },
  ],
}

/**
 * Core's witness has two contract 30 tiers. Articles' `sponsors` is a polymorphic to-many
 * identified by its link rows, whose pivot fields `rank` and the read-only `since` its identifiers
 * carry as `meta.pivot` and whose reads filter by `minRank` and sort by either field. Its `tags`
 * fix their members, so the 403 shape offers `MEMBERSHIP_CHANGE_PROHIBITED`.
 */
describe('generator contract 30 (identified pivots and fixed membership)', () => {
  const sponsors = descriptor['articles']!.relations['sponsors']!

  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(38)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('types the pivot of a polymorphic relation', () => {
    expect(sponsors).toMatchObject({
      cardinality: 'many',
      types: ['people', 'images'],
      polymorphic: true,
      pivot: true,
      readPivot: { fields: { rank: 'integer', since: 'date-time' }, nullable: ['since'] },
      writePivot: { fields: { rank: 'integer' } },
    })
  })

  it("reads the relation's own sorts and filters", () => {
    expect(sponsors.sortable).toEqual(['rank', '-rank', 'since', '-since'])
    expect(sponsors.filterable).toEqual(['minRank'])
    expect(sponsors.listFilters).toBeUndefined()
    expect(sponsors.filterFamilies).toBeUndefined()
  })

  it('reads none for a polymorphic relation whose reads declare none', () => {
    const attachments = descriptor['articles']!.relations['attachments']!
    expect(attachments.polymorphic).toBe(true)
    expect(attachments.pivot).toBe(false)
    expect(attachments.sortable).toEqual([])
    expect(attachments.filterable).toEqual([])
  })

  it("leaves a monomorphic relation's reads to its related type when they match", () => {
    const author = descriptor['articles']!.relations['author']!
    expect(author.sortable).toEqual([])
    expect(author.filterable).toBeUndefined()
  })

  it('sends the sorts and filters and reads each pivot', async () => {
    const { client, requests } = witnessClient(linkage)
    const members = await client.articles
      .id('art-1')
      .sponsors.get({ sort: ['-rank', 'since'], filter: { minRank: 2 } })
    await client.articles.id('art-1').sponsors.related({ sort: '-since' })
    expect(requests.map((req) => decodeURIComponent(req.url))).toEqual([
      'https://api.example.com/articles/art-1/relationships/sponsors?filter[minRank]=2&sort=-rank,since',
      'https://api.example.com/articles/art-1/sponsors?sort=-since',
    ])
    expect(members.map((member) => member.$pivot?.rank)).toEqual([1, 2])
    type Pivot = NonNullable<(typeof members)[number]['$pivot']>
    expectTypeOf<Pivot['rank']>().toEqualTypeOf<number>()
    expectTypeOf<Pivot['since']>().toEqualTypeOf<string | null>()
  })

  it('sends a writable pivot as each member’s meta.pivot', async () => {
    const { client, requests } = witnessClient(linkage)
    await client.articles
      .id('art-1')
      .sponsors.replace([{ type: 'images', id: 'img-1', $pivot: { rank: 3 } }])
    expect(JSON.parse(requests[0]!.body as string)).toEqual({
      data: [{ type: 'images', id: 'img-1', meta: { pivot: { rank: 3 } } }],
    })
  })

  it('rejects a sort, filter or pivot the relation does not take at compile time', async () => {
    const accessor = witnessClient(linkage).client.articles.id('art-1').sponsors
    // @ts-expect-error — `name` is not a sort of the relation.
    await accessor.get({ sort: 'name' })
    // @ts-expect-error — `color` is not a filter of the relation.
    await accessor.related({ filter: { color: 'red' } })
    // @ts-expect-error — a written pivot carries the required `rank`.
    await accessor.add([{ type: 'people', id: 'p', $pivot: {} }])
  })

  it('types the fixed membership code', () => {
    expect(ErrorCodes.MEMBERSHIP_CHANGE_PROHIBITED).toBe(MEMBERSHIP)
    expectTypeOf<typeof MEMBERSHIP>().toMatchTypeOf<ErrorCode>()
    expectTypeOf<typeof MEMBERSHIP>().toMatchTypeOf<ErrorCodeByStatus[403]>()
    const code = readErrorCatalogue(witness).codes.find((entry) => entry.code === MEMBERSHIP)
    expect(code).toMatchObject({ title: 'Membership change is prohibited' })
    expect(code!.description).toContain('reorder')
  })
})

/** A document stamped 30 may carry one tier without the other. */
describe('generator contract 30 from identified pivots alone', () => {
  const doc = withoutFixedMembership()
  const alone = buildDescriptor(doc)

  it('reads the document without a warning', () => {
    expect(doc.info?.['x-generator']?.contract).toBe(38)
    expect(checkContract(doc)).toBeUndefined()
  })

  it('reads the polymorphic pivot and the relation’s own sorts and filters', () => {
    expect(alone['articles']!.relations['sponsors']).toEqual(
      descriptor['articles']!.relations['sponsors'],
    )
  })

  it('documents no fixed membership code', () => {
    expect(readErrorCatalogue(doc).codes.map((entry) => entry.code)).not.toContain(MEMBERSHIP)
    expect(emit(doc, alone)).not.toContain(MEMBERSHIP)
  })
})

describe('generator contract 30 from fixed membership alone', () => {
  const doc = withoutIdentifiedPivots()
  const alone = buildDescriptor(doc)

  it('reads the document without a warning', () => {
    expect(doc.info?.['x-generator']?.contract).toBe(38)
    expect(checkContract(doc)).toBeUndefined()
  })

  it('types the fixed membership code', () => {
    expect(readErrorCatalogue(doc).byStatus.get(403)).toContain(MEMBERSHIP)
    expect(emit(doc, alone)).toContain(`  ${MEMBERSHIP}: "${MEMBERSHIP}",\n`)
  })

  it('reads every other relation as the full witness does', () => {
    const { sponsors: _, ...others } = descriptor['articles']!.relations
    expect(alone['articles']!.relations).toEqual(others)
  })

  it('reads relation sorts and filters only where a read differs from its related type', () => {
    const own = Object.entries(alone).flatMap(([type, spec]) =>
      Object.entries(spec.relations)
        .filter(([, relation]) => relation.sortable?.length || relation.filterable?.length)
        .map(([name]) => `${type}.${name}`),
    )
    expect(own).toEqual(['articles.tags'])
  })
})
