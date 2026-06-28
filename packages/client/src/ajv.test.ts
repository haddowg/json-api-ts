import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import { createClient } from './client'
import { AjvValidationError, createAjvValidator } from './ajv'
import type { ApiDescriptor } from './descriptor'
import type { TransportRequest, TransportResponse } from './transport'
import type { SchemaMap, WireResource } from './validate'

const BASE = 'https://music.example'

function fixtureBody(name: string): string {
  const path = fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url))
  return readFileSync(path, 'utf8')
}

/** The real per-type JSON Schema bundle the bundle serves at GET /schemas.json. */
const schemas = JSON.parse(fixtureBody('music-catalog.schemas.json')) as SchemaMap

// The bundle's schemas carry `x-enum-*` keywords (tolerated under `strict: false`) plus `format`
// annotations (date-time/date/uuid/time/uri). We do NOT enforce formats: they are advisory and the
// wire's `time` ("00:00:30") is a duration-style value ajv-formats' strict `time` would reject — the
// client's posture is to validate structure/types, not format minutiae (see the recipe in ajv.ts).
// `validateFormats: false` skips them without ajv's "unknown format" warnings; `allErrors` aggregates
// every failing field. A user who wants format enforcement attaches `ajv-formats` (recipe documents it).
const newAjv = (): Ajv2020 =>
  new Ajv2020({ allErrors: true, strict: false, validateFormats: false })

const descriptor = {
  albums: {
    attributes: { title: 'string' },
    relations: {
      artist: { cardinality: 'one', types: ['artists'], pivot: false },
      tracks: { cardinality: 'many', types: ['tracks'], pivot: false },
    },
    paths: { fetchMany: '/albums', fetchOne: '/albums/{id}' },
    paginator: 'page',
    clientId: 'optional',
  },
  artists: { attributes: {}, relations: {}, paths: {}, paginator: 'page', clientId: 'optional' },
  tracks: { attributes: {}, relations: {}, paths: {}, paginator: 'page', clientId: 'optional' },
} as const satisfies ApiDescriptor

function transportFor(body: string): {
  transport: (req: TransportRequest) => Promise<TransportResponse>
} {
  return { transport: async () => ({ status: 200, headers: {}, body }) }
}

describe('createAjvValidator — unit', () => {
  it('passes a well-formed resource of a covered type', () => {
    const validate = createAjvValidator(newAjv(), schemas)
    const album: WireResource = {
      type: 'albums',
      id: '1',
      attributes: { title: 'OK Computer', explicit: false, status: 'released' },
    }
    // The adapter returns a bare `Validator` (`(resource, schema) => void`); it owns its own
    // compiled lookup, so the runtime — and these tests — call it with `schema = undefined`.
    expect(() => validate(album, undefined)).not.toThrow()
  })

  it('rejects a wrong-typed attribute with an aggregated, pointer-bearing error', () => {
    const validate = createAjvValidator(newAjv(), schemas)
    const album: WireResource = {
      type: 'albums',
      id: '7',
      // title must be a string; explicit must be a boolean — both wrong.
      attributes: { title: 123, explicit: 'no' },
    }
    let thrown: unknown
    try {
      validate(album, undefined)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AjvValidationError)
    const err = thrown as AjvValidationError
    expect(err.type).toBe('albums')
    expect(err.resourceId).toBe('7')
    // Both failing fields are aggregated, each carrying a useful instance pointer + keyword.
    const pointers = err.failures.map((f) => f.pointer)
    expect(pointers).toContain('/attributes/title')
    expect(pointers).toContain('/attributes/explicit')
    expect(err.failures.every((f) => f.keyword === 'type')).toBe(true)
    // The message lists the failing pointers.
    expect(err.message).toMatch(/\/attributes\/title/)
  })

  it('rejects an out-of-enum value', () => {
    const validate = createAjvValidator(newAjv(), schemas)
    const album: WireResource = {
      type: 'albums',
      id: '3',
      attributes: { title: 'x', status: 'bogus' },
    }
    expect(() => validate(album, undefined)).toThrow(AjvValidationError)
  })

  it('skips a type the schema bundle does not cover (graceful)', () => {
    const validate = createAjvValidator(newAjv(), { albums: schemas['albums'] })
    expect(() =>
      validate({ type: 'tracks', id: '9', attributes: { whatever: true } }, undefined),
    ).not.toThrow()
  })

  it('compiles each schema once up front (a malformed body still validates per-type)', () => {
    // Constructing the validator compiles the whole bundle; a later call is a lookup, not a compile.
    expect(() => createAjvValidator(newAjv(), schemas)).not.toThrow()
  })
})

describe('createAjvValidator — wired into createClient.validate', () => {
  it('lets a well-formed compound document through', async () => {
    const validate = createAjvValidator(newAjv(), schemas)
    const { transport } = transportFor(fixtureBody('album-compound.json'))
    const client = createClient(descriptor, { baseUrl: BASE, transport, validate })
    const album = (await client.albums.get('1', {
      include: ['artist', 'tracks'],
    })) as unknown as Record<string, unknown>
    expect(album['title']).toBe('OK Computer')
  })

  it('rejects a response carrying a malformed resource with an AjvValidationError', async () => {
    const validate = createAjvValidator(newAjv(), schemas)
    // A collection where the second album has a non-string title — the wire lied.
    const body = JSON.stringify({
      data: [
        { type: 'albums', id: '1', attributes: { title: 'Real' } },
        { type: 'albums', id: '2', attributes: { title: 999 } },
      ],
    })
    const { transport } = transportFor(body)
    const client = createClient(descriptor, { baseUrl: BASE, transport, validate })
    await expect(client.albums.list()).rejects.toThrow(AjvValidationError)
  })
})

describe('dependency hygiene — ajv stays out of the core client dep tree', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
    devDependencies?: Record<string, string>
  }

  it('does not list ajv as a runtime dependency', () => {
    expect(pkg.dependencies?.['ajv']).toBeUndefined()
  })

  it('lists ajv as an OPTIONAL peer dependency (brought by the user) + a dev dependency for tests', () => {
    expect(pkg.peerDependencies?.['ajv']).toBeDefined()
    expect(pkg.peerDependenciesMeta?.['ajv']?.optional).toBe(true)
    expect(pkg.devDependencies?.['ajv']).toBeDefined()
  })

  it('does not import ajv from the main entry (the adapter is its own ./ajv sub-path)', () => {
    const indexSrc = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')
    // The barrel must not re-export the ajv adapter — that would drag the `ajv` type import into
    // the main entry's `.d.ts`. The adapter is reached only via the `@haddowg/json-api-client/ajv`
    // sub-path export.
    expect(indexSrc).not.toMatch(/['"]\.\/ajv['"]/)
    expect(indexSrc).not.toMatch(/\bajv\b/i)
  })
})
