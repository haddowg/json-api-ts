import type {
  ApiDescriptor,
  CreateInput,
  SingletonUpdateInput,
  TypeName,
  UpdateInput,
} from '@haddowg/json-api-client'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type {
  ResourceMap as WitnessMap,
  WriteAttributes as WitnessWrites,
} from '../test/generated/contract-witness.client.gen'
import { inputSchemas as witnessSchemas } from '../test/generated/contract-witness.client.zod.gen'
import type { ResourceMap, WriteAttributes } from '../test/generated/music-catalog.client.gen'
import type {
  ResourceMap as RulesMap,
  WriteAttributes as RulesWrites,
} from '../test/generated/write-rules.client.gen'
import { inputSchemas as rulesSchemas } from '../test/generated/write-rules.client.zod.gen'
import {
  albumsCreateSchema,
  albumsUpdateSchema,
  inputSchemas,
  releasesCreateSchema,
  tracksCreateSchema,
} from '../test/generated/music-catalog.client.zod.gen'

type SameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never]
  ? true
  : { extra: Exclude<keyof A, keyof B>; missing: Exclude<keyof B, keyof A> }

/** True when a schema's input and output both fit `Input` and name exactly its keys. */
type Fits<S, Input> = S extends z.ZodType
  ? [z.output<S>, z.input<S>] extends [Input, Input]
    ? SameKeys<z.output<S>, Input>
    : { mismatch: z.output<S> }
  : true

type Drift<D extends ApiDescriptor, W, Schemas> = {
  [T in keyof Schemas & TypeName<D>]: {
    create: Schemas[T] extends { create: infer S } ? Fits<S, CreateInput<D, W, T>> : true
    update: Schemas[T] extends { update: infer S }
      ? Fits<
          S,
          D[T] extends { singleton: true } ? SingletonUpdateInput<D, W, T> : UpdateInput<D, W, T>
        >
      : true
  }
}

type AllTrue<Schemas> = { -readonly [T in keyof Schemas]: { create: true; update: true } }

describe('generated Zod input schemas', () => {
  it("match the client's CreateInput and UpdateInput for every writable type", () => {
    expectTypeOf<Drift<ResourceMap, WriteAttributes, typeof inputSchemas>>().toEqualTypeOf<
      AllTrue<typeof inputSchemas>
    >()
    expectTypeOf<Drift<WitnessMap, WitnessWrites, typeof witnessSchemas>>().toEqualTypeOf<
      AllTrue<typeof witnessSchemas>
    >()
    // The witness with a relation for each required, non-null and non-empty rule.
    expectTypeOf<Drift<RulesMap, RulesWrites, typeof rulesSchemas>>().toEqualTypeOf<
      AllTrue<typeof rulesSchemas>
    >()
  })

  it('omits create for a type that has no create attributes', () => {
    expect(Object.keys(inputSchemas.accounts)).toEqual(['update'])
  })

  it('parses a valid create input', () => {
    const input = {
      title: 'OK Computer',
      releasedAt: '1997-05-21T00:00:00+01:00',
      availableFrom: '2024-01-01',
      releaseInfo: { label: 'Parlophone' },
      credits: { producer: 'Nigel Godrich' },
      artist: { type: 'artists', id: '1' },
      tracks: [
        { type: 'tracks', id: '7' },
        { type: 'tracks', lid: 'new-track' },
      ],
      $meta: { editorNote: 'Remastered' },
    }
    expect(albumsCreateSchema.safeParse(input)).toEqual({ success: true, data: input })
  })

  it('reports issues at the flat input paths', () => {
    const result = albumsCreateSchema.safeParse({
      title: '',
      releasedAt: 'yesterday',
      releaseInfo: { label: 5 },
      artist: { type: 'genres', id: '1' },
    })
    expect(result.success).toBe(false)
    const paths = result.error!.issues.map((issue) => issue.path)
    expect(paths).toContainEqual(['title'])
    expect(paths).toContainEqual(['releasedAt'])
    expect(paths).toContainEqual(['releaseInfo', 'label'])
    expect(paths).toContainEqual(['artist'])
  })

  it('requires a create attribute the component requires, and no update attribute', () => {
    const missing = albumsCreateSchema.safeParse({})
    expect(missing.error?.issues.map((issue) => issue.path)).toEqual([['title']])
    expect(albumsUpdateSchema.safeParse({}).success).toBe(true)
  })

  it('rejects an id when the type forbids a client id', () => {
    const result = albumsCreateSchema.safeParse({ title: 'x', id: '1' })
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['id']])
  })

  it('validates a discriminated union arm by its discriminator', () => {
    expect(
      releasesCreateSchema.safeParse({
        catalogNumber: 'PCS 7088',
        format: { medium: 'vinyl', rpm: 33 },
      }).success,
    ).toBe(true)
    const result = releasesCreateSchema.safeParse({
      catalogNumber: 'PCS 7088',
      format: { medium: 'vinyl', rpm: 99 },
    })
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['format', 'rpm']])
  })

  it('checks a non-empty, unique list', () => {
    const base = { title: 'Come Together', trackNumber: 1 }
    expect(tracksCreateSchema.safeParse({ ...base, genres: ['rock'] }).success).toBe(true)
    expect(tracksCreateSchema.safeParse({ ...base, genres: [] }).success).toBe(false)
    expect(tracksCreateSchema.safeParse({ ...base, genres: ['rock', 'rock'] }).success).toBe(false)
  })
})
