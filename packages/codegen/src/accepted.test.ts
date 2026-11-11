import { readFileSync } from 'node:fs'
import type { Accepted, ReadResult } from '@haddowg/json-api-client'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  type Attributes as WitnessAttributes,
  createClient as createWitnessClient,
  type resourceMap as witnessMap,
} from '../test/generated/contract-witness.client.gen'
import {
  type Attributes,
  createClient,
  type resourceMap,
} from '../test/generated/music-catalog.client.gen'
import { buildDescriptor } from './build-descriptor'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'

const load = (name: 'music-catalog.openapi.json' | 'contract-witness.json'): OpenApiDocument =>
  JSON.parse(readFileSync(documentPath(name), 'utf8')) as OpenApiDocument

/** The document with every `202` response taken out, as a server declaring none projects it. */
function without202(doc: OpenApiDocument): OpenApiDocument {
  for (const item of Object.values(doc.paths ?? {})) {
    for (const op of Object.values(item)) {
      if (op?.responses !== undefined) {
        delete op.responses['202']
      }
    }
  }
  return doc
}

// The spec hash in the provenance stamp differs with the document, so it is left out.
const unstamped = (source: string) => source.replace(/Spec hash: .*/, '')

describe('writes and actions that declare a 202 Accepted', () => {
  it('reads the job type of a create from its registered job document', () => {
    const descriptor = buildDescriptor(load('music-catalog.openapi.json'))
    expect(descriptor['catalog-exports']?.accepted).toEqual({ create: { jobType: 'export-jobs' } })
    const others = Object.entries(descriptor).filter(([type]) => type !== 'catalog-exports')
    expect(others.filter(([, entry]) => entry.accepted !== undefined)).toEqual([])
  })

  it('reads the job type of an update from an inline document of an unregistered type', () => {
    const descriptor = buildDescriptor(load('contract-witness.json'))
    expect(descriptor['articles']?.accepted).toEqual({ update: { jobType: 'article-jobs' } })
    expect(descriptor['article-jobs']).toBeUndefined()
  })

  it('reads an action 202 and keeps its output from its other responses', () => {
    const doc = load('contract-witness.json')
    const accepted = doc.paths!['/articles/{id}']!.patch!.responses!['202']!
    doc.paths!['/articles/{id}/-actions/publish']!.post!.responses!['202'] = accepted
    const retract = doc.paths!['/articles/{id}/-actions/retract']!.post!
    delete retract.responses!['204']
    retract.responses!['202'] = accepted
    const actions = buildDescriptor(doc)['articles']!.actions!
    expect(actions['publish']).toMatchObject({
      output: 'document',
      outputType: 'articles',
      outputCardinality: 'one',
      accepted: { jobType: 'article-jobs' },
    })
    expect(actions['retract']).toMatchObject({
      output: 'none',
      accepted: { jobType: 'article-jobs' },
    })
    expect(actions['retract']!.outputType).toBeUndefined()
  })

  it('warns and leaves out a 202 whose job type it cannot read', () => {
    const doc = load('contract-witness.json')
    doc.paths!['/articles/{id}']!.patch!.responses!['202'] = {
      content: { 'application/vnd.api+json': { schema: { type: 'object' } } },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(buildDescriptor(doc)['articles']?.accepted).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "PATCH /articles/{id} declares a 202 Accepted whose job type can't be read",
        ),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('emits the same client for a document without a 202, but for the accepted entries', () => {
    for (const name of ['music-catalog.openapi.json', 'contract-witness.json'] as const) {
      const stripped = without202(load(name))
      const source = unstamped(emit(stripped, buildDescriptor(stripped)))
      expect(source).not.toContain('accepted:')
      const full = load(name)
      const fullSource = unstamped(emit(full, buildDescriptor(full)))
      expect(fullSource.replace(/,\n\s*accepted: \{\n[^]*?\n\s{4}\}(?=\n\s{2}\})/g, '')).toBe(
        source,
      )
    }
  })

  it('types the generated writes that declare a 202', () => {
    type M = typeof resourceMap
    type Export = ReadResult<M, Attributes, 'catalog-exports'>
    type Job = ReadResult<M, Attributes, 'export-jobs'>
    type W = typeof witnessMap
    type Article = ReadResult<W, WitnessAttributes, 'articles'>
    const client = createClient({ baseUrl: 'https://music.example' })
    const witness = createWitnessClient({ baseUrl: 'https://api.example' })
    // oxlint-disable-next-line no-constant-condition -- type-level probes only, never run
    if (false as boolean) {
      expectTypeOf(client['catalog-exports'].create({ format: 'csv' })).resolves.toEqualTypeOf<
        Export | Accepted<Job, Export>
      >()
      expectTypeOf(
        client['catalog-exports'].create({ format: 'csv' }, { wait: true }),
      ).resolves.toEqualTypeOf<Export>()
      expectTypeOf(
        witness.articles.id('1').update({}, { wait: true }),
      ).resolves.toEqualTypeOf<Article>()
      expectTypeOf(witness.articles.id('1').update({})).resolves.toEqualTypeOf<
        Article | Accepted<Readonly<Record<string, unknown>>, Article>
      >()
      // @ts-expect-error -- albums declare no 202, so their create takes no wait
      void client.albums.create({ title: 'x' } as never, { wait: true })
    }
  })
})
