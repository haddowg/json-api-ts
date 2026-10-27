import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ResourceLinks } from '@haddowg/json-api-client'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createClient, type ImagesLinks } from '../test/generated/contract-witness.client.gen'
import type { AlbumsLinks, TracksLinks } from '../test/generated/music-catalog.client.gen'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { readDeclaredLinks } from './declared-links'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { unwrapRefs } from './unwrap-refs'

function loadWitness(): OpenApiDocument {
  const path = fileURLToPath(
    new URL('../test/fixtures/contract-witness.openapi.json', import.meta.url),
  )
  return JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument
}

const witness = loadWitness()

const image = {
  type: 'images',
  id: 'img-1',
  attributes: { url: 'https://cdn.example.com/img-1.png' },
  links: {
    self: 'https://api.example.com/images/img-1',
    download: {
      href: 'https://cdn.example.com/originals/img-1.png',
      title: 'Original',
      type: 'image/png',
      meta: { method: 'GET', expiresAt: '2026-10-26T12:00:00+00:00', headers: null },
    },
    thumbnail: 'https://cdn.example.com/thumbs/img-1.png',
    extra: 'https://api.example.com/extra',
  },
}

function clientAnswering(body: unknown) {
  return createClient({
    baseUrl: 'https://api.example.com',
    transport: async () => ({ status: 200, headers: {}, body: JSON.stringify(body) }),
  })
}

describe('generator contract 14 (declared links)', () => {
  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(17)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('reads a link object and a bare link, never self or an action link', () => {
    const schemas = unwrapRefs(witness).components!.schemas!
    const images = readDeclaredLinks(schemas['ImagesResourceLinks'])
    expect(images.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'download', kind: 'object' },
      { name: 'thumbnail', kind: 'bare' },
    ])
    expect(readDeclaredLinks(schemas['ArticlesResourceLinks'])).toEqual([])
    expect(readDeclaredLinks(schemas['VideosResourceLinks'])).toEqual([])
  })

  it('types a link object with its static members and typed, documented meta', () => {
    const source = emit(witness, buildDescriptor(witness))
    expect(source).toContain('export interface ImagesLinks extends ResourceLinks {')
    expect(source).toContain(
      [
        '  download?: {',
        '    /** @format uri-reference */',
        '    href: string',
        '    title: "Original"',
        '    type: "image/png"',
        '    meta: {',
        '      /**',
        '       * The HTTP method to use.',
        '       *',
        '       * @example GET',
        '       */',
        '      method: "GET"',
      ].join('\n'),
    )
    expect(source).toContain(
      [
        '       * When the URL stops working.',
        '       *',
        '       * @format date-time',
        '       * @example 2026-10-26T12:00:00+00:00',
        '       */',
        '      expiresAt: string',
        '      /** @example {"Range":"bytes=0-"} */',
        '      headers?: Record<string, unknown> | null',
      ].join('\n'),
    )
    expect(source).toContain(
      [
        '   * The `thumbnail` link, absent when it does not apply to the resource.',
        '   *',
        '   * @example https://cdn.example.com/thumbs/img-1.png',
        '   */',
        '  thumbnail?: string',
      ].join('\n'),
    )
    expect(source).toContain('export interface Links {\n  images: ImagesLinks\n}')
    expect(source).toContain('ActionTypes, ErrorCode, Links>(')
  })

  it('emits an empty links map and no import when no type declares a link', () => {
    const doc = loadWitness()
    const links = doc.components!.schemas!['ImagesResourceLinks']!.properties!
    delete links['download']
    delete links['thumbnail']
    const source = emit(doc, buildDescriptor(doc))
    expect(source).toContain('export interface Links {}')
    expect(source).not.toContain('ImagesLinks')
    expect(source).not.toContain('type ResourceLinks')
  })

  it('reads declared links off a fetched resource without a cast', async () => {
    const fetched = await clientAnswering({ data: image }).images.get('img-1')

    expectTypeOf(fetched.$links).toEqualTypeOf<ImagesLinks | undefined>()
    expectTypeOf(fetched.$links!.thumbnail).toEqualTypeOf<string | undefined>()
    expectTypeOf(fetched.$links!.download!.meta.method).toEqualTypeOf<'GET'>()
    expectTypeOf(fetched.$links!.download!.meta.expiresAt).toEqualTypeOf<string>()
    expectTypeOf(fetched.$links!.download!.title).toEqualTypeOf<'Original'>()
    expectTypeOf(fetched.$links!['extra']).toEqualTypeOf<unknown>()

    expect(fetched.$links?.download?.href).toBe('https://cdn.example.com/originals/img-1.png')
    expect(fetched.$links?.download?.meta.expiresAt).toBe('2026-10-26T12:00:00+00:00')
    expect(fetched.$links?.thumbnail).toBe('https://cdn.example.com/thumbs/img-1.png')
    expect(fetched.$links?.['extra']).toBe('https://api.example.com/extra')
  })

  it('types each member of a collection the same way', async () => {
    const images = await clientAnswering({ data: [image] }).images.list()
    expectTypeOf(images[0]!.$links).toEqualTypeOf<ImagesLinks | undefined>()
    expect(images[0]!.$links?.download?.meta.method).toBe('GET')
  })

  it('leaves a type that declares no links on the loose ResourceLinks', async () => {
    const video = { type: 'videos', id: 'vid-1', attributes: { url: 'x' }, links: { self: 's' } }
    const fetched = await clientAnswering({ data: video }).videos.get('vid-1')
    expectTypeOf(fetched.$links).toEqualTypeOf<ResourceLinks | undefined>()
    expect(fetched.$links?.self).toBe('s')
  })
})

describe('declared links in the music catalog', () => {
  it('types the tracks preview link object with its format and expiry meta', () => {
    type Preview = NonNullable<TracksLinks['preview']>
    expectTypeOf<Preview['href']>().toEqualTypeOf<string>()
    expectTypeOf<Preview['type']>().toEqualTypeOf<'audio/mpeg'>()
    expectTypeOf<Preview['meta']['format']>().toEqualTypeOf<string | null>()
    expectTypeOf<Preview['meta']['expiresAt']>().toEqualTypeOf<string | null>()
  })

  it('types the albums store link as a bare URL', () => {
    expectTypeOf<AlbumsLinks['store']>().toEqualTypeOf<string | undefined>()
  })
})
