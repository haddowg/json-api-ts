import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import { StructuralGuardError } from './errors'
import type { TransportRequest, TransportResponse } from './transport'
import type { SchemaMap, Validator, WireResource } from './validate'

const BASE = 'https://music.example'

function fixtureBody(name: string): string {
  const path = fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url))
  return readFileSync(path, 'utf8')
}

/** The real per-type JSON Schema bundle the bundle serves at GET /schemas.json. */
const schemas = JSON.parse(fixtureBody('music-catalog.schemas.json')) as SchemaMap

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
    includable: ['artist', 'tracks'],
  },
  artists: {
    attributes: {},
    relations: {},
    paths: { fetchOne: '/artists/{id}' },
    paginator: 'page',
    clientId: 'optional',
  },
  tracks: {
    attributes: {},
    relations: {},
    paths: { fetchOne: '/tracks/{id}' },
    paginator: 'page',
    clientId: 'optional',
  },
} as const satisfies ApiDescriptor

function transportFor(body: string): {
  transport: (req: TransportRequest) => Promise<TransportResponse>
} {
  return { transport: async () => ({ status: 200, headers: {}, body }) }
}

describe('createClient — light structural guards (always on)', () => {
  it('rejects a non-JSON:API document', async () => {
    const { transport } = transportFor(JSON.stringify({ result: 'ok' }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })
    await expect(client.albums.get('1')).rejects.toThrow(StructuralGuardError)
  })

  it('rejects a type-less resource', async () => {
    const { transport } = transportFor(JSON.stringify({ data: { id: '1', attributes: {} } }))
    const client = createClient(descriptor, { baseUrl: BASE, transport })
    await expect(client.albums.get('1')).rejects.toThrow(/missing a string "type"/)
  })

  it('passes a well-formed document through unchanged', async () => {
    const { transport } = transportFor(fixtureBody('albums-collection.json'))
    const client = createClient(descriptor, { baseUrl: BASE, transport })
    const albums = (await client.albums.list()) as unknown as Array<Record<string, unknown>>
    expect(albums[0]!['title']).toBe('OK Computer')
  })
})

describe('createClient — opt-in validation seam', () => {
  it('validates every data + included resource by its type against the real schemas', async () => {
    const seen: Array<{ type: string; schemaId: unknown }> = []
    const validator: Validator = (resource, schema) => {
      seen.push({ type: resource.type, schemaId: (schema as { $id?: string })?.$id })
    }
    const { transport } = transportFor(fixtureBody('album-compound.json'))
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      validate: { schemas, validator },
    })

    await client.albums.get('1', { include: ['artist', 'tracks'] })

    // The primary album + every included member (artist + 3 tracks) is validated by its type,
    // each against its own per-type schema ($id urn:jsonapi:schema:<type>).
    expect(seen).toContainEqual({ type: 'albums', schemaId: 'urn:jsonapi:schema:albums' })
    expect(seen).toContainEqual({ type: 'artists', schemaId: 'urn:jsonapi:schema:artists' })
    expect(seen.filter((s) => s.type === 'tracks')).toHaveLength(3)
    expect(seen.every((s) => s.schemaId === `urn:jsonapi:schema:${s.type}`)).toBe(true)
  })

  it('surfaces the engine error type when the validator throws on an invalid resource', async () => {
    class ValidationFailure extends Error {}
    const validator: Validator = (resource) => {
      if (resource.type === 'tracks') {
        throw new ValidationFailure(`tracks ${resource.id} failed validation`)
      }
    }
    const { transport } = transportFor(fixtureBody('album-compound.json'))
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      validate: { schemas, validator },
    })

    await expect(client.albums.get('1', { include: ['tracks'] })).rejects.toThrow(ValidationFailure)
  })

  it('does NOT call the validator when validate is absent (zero overhead by default)', async () => {
    const validator = vi.fn<Validator>()
    const { transport } = transportFor(fixtureBody('album-compound.json'))
    const client = createClient(descriptor, { baseUrl: BASE, transport })

    await client.albums.get('1', { include: ['artist', 'tracks'] })
    expect(validator).not.toHaveBeenCalled()
  })

  it('skips a type the schema bundle does not cover (graceful partial coverage)', async () => {
    const validator = vi.fn<Validator>()
    // A bundle missing the `tracks` schema: the album validates, the included tracks are skipped.
    const partial: SchemaMap = { albums: schemas['albums'], artists: schemas['artists'] }
    const { transport } = transportFor(fixtureBody('album-compound.json'))
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport,
      validate: { schemas: partial, validator },
    })

    await client.albums.get('1', { include: ['artist', 'tracks'] })
    const types = validator.mock.calls.map((c) => (c[0] as WireResource).type)
    expect(types).toContain('albums')
    expect(types).toContain('artists')
    expect(types).not.toContain('tracks')
  })

  it('accepts a bare validator function (the function owns schema lookup)', async () => {
    const validator = vi.fn<Validator>()
    const { transport } = transportFor(fixtureBody('albums-collection.json'))
    const client = createClient(descriptor, { baseUrl: BASE, transport, validate: validator })

    await client.albums.list()
    expect(validator).toHaveBeenCalled()
    // The bare form passes schema = undefined (no per-type lookup).
    expect(validator.mock.calls.every((c) => c[1] === undefined)).toBe(true)
  })
})
