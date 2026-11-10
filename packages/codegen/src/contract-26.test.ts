import { readFileSync } from 'node:fs'
import { createClient, type ApiDescriptor } from '@haddowg/json-api-client'
import { describe, expect, it, vi } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'

const witness = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument

/**
 * Core's witness declares two actions answering `201 Created` with the article they created:
 * `duplicate` declares only that document, `restore` declares a `200` document beside it.
 */
describe('generator contract 26 (actions answering 201 Created)', () => {
  const descriptor = buildDescriptor(witness)
  const actions = descriptor['articles']!.actions!

  it('reads the document without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(31)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('types a created document as the action result', () => {
    for (const name of ['duplicate', 'restore']) {
      expect(actions[name]).toMatchObject({
        output: 'document',
        outputType: 'articles',
        outputCardinality: 'one',
      })
    }
  })

  it('warns when the 200 and 201 documents name different types', () => {
    const doc = structuredClone(witness)
    const restore = doc.paths!['/articles/{id}/-actions/restore']!.post!
    restore.responses!['201']!.content!['application/vnd.api+json']!.schema = {
      $ref: '#/components/schemas/PeopleDocument',
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const built = buildDescriptor(doc)
      expect(built['articles']!.actions!['restore']!.outputType).toBe('articles')
      expect(warn).toHaveBeenCalledWith(
        'json-api codegen: custom action path "/articles/{id}/-actions/restore" answers with both a "articles" and a "people" document; its result is typed as "articles".',
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('materialises the created resource from a 201', async () => {
    const transport = vi.fn(async () => ({
      status: 201,
      headers: { location: 'https://api.example.com/articles/art-2' },
      body: JSON.stringify({
        data: { type: 'articles', id: 'art-2', attributes: { title: 'Copy' } },
        jsonapi: { version: '1.1' },
      }),
    }))
    const client = createClient(descriptor as ApiDescriptor, {
      baseUrl: 'https://api.example.com',
      transport,
    })
    const articles = client['articles'] as unknown as {
      id: (id: string) => {
        actions: Record<string, () => Promise<{ id: string; title?: unknown }>>
      }
    }
    const created = await articles.id('art-1').actions['duplicate']!()
    expect(created.id).toBe('art-2')
    expect(created.title).toBe('Copy')
    expect((transport.mock.calls[0] as unknown[])[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.example.com/articles/art-1/-actions/duplicate',
    })
  })
})
