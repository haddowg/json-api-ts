import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { OpenApiDocument } from './openapi'
import { decode, toPortable } from './portable'
import { fakeTransport, fixture } from './test-fixtures'

const created = () => ({
  status: 201,
  json: { data: { type: 'articles', id: 'art-1', attributes: { title: 'Hello' } } },
})

async function sentAttributes(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const { transport, requests } = fakeTransport(created)
  const session = await createJsonApiMcp({
    ...fixture('contract-witness'),
    transport,
  }).forRequest({ context: {} })
  await session.callTool(tool, args)
  const body = JSON.parse(requests[0]!.body!) as { data: { attributes: unknown } }
  return body.data.attributes
}

describe('nulls the conversion added inside a union branch', () => {
  it('drops them from a discriminated union attribute', async () => {
    expect(
      await sentAttributes('articles_create', {
        title: 'Hello',
        block: { kind: 'image', src: null },
      }),
    ).toEqual({ title: 'Hello', block: { kind: 'image' } })
  })

  it('drops them from each element of a list of union elements, nested objects included', async () => {
    expect(
      await sentAttributes('articles_create', {
        title: 'Hello',
        steps: [
          { operation: 'trim' },
          { operation: 'find_replace', params: { find: 'a', replace: null } },
          { operation: 'find_replace', params: null },
        ],
      }),
    ).toEqual({
      title: 'Hello',
      steps: [
        { operation: 'trim' },
        { operation: 'find_replace', params: { find: 'a' } },
        { operation: 'find_replace' },
      ],
    })
  })

  it('drops them on an update too', async () => {
    expect(
      await sentAttributes('articles_update', {
        id: 'art-1',
        block: { kind: 'heading', text: null },
        steps: [{ operation: 'find_replace', params: { find: null, replace: 'b' } }],
      }),
    ).toEqual({
      block: { kind: 'heading' },
      steps: [{ operation: 'find_replace', params: { replace: 'b' } }],
    })
  })
})

describe('the union decoder', () => {
  const doc: OpenApiDocument = {
    components: {
      schemas: {
        Note: {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'note' },
            body: { type: 'string' },
            pinnedAt: { type: ['string', 'null'] },
            meta: {
              type: 'object',
              properties: { author: { type: 'string' }, editor: { type: ['string', 'null'] } },
            },
          },
          required: ['kind'],
        },
        Link: {
          type: 'object',
          properties: { kind: { type: 'string', const: 'link' }, href: { type: 'string' } },
          required: ['kind', 'href'],
        },
      },
    },
  }
  const union = {
    oneOf: [{ $ref: '#/components/schemas/Note' }, { $ref: '#/components/schemas/Link' }],
    discriminator: { propertyName: 'kind' },
  }

  it('keeps a null the branch member allows, at any depth', () => {
    const { decoder } = toPortable(doc, union)
    expect(
      decode(
        { kind: 'note', body: null, pinnedAt: null, meta: { author: null, editor: null } },
        decoder,
      ),
    ).toEqual({ kind: 'note', pinnedAt: null, meta: { editor: null } })
  })

  it('finds the discriminator without the keyword when each branch has its own const', () => {
    const { oneOf } = union
    const { decoder } = toPortable(doc, { oneOf })
    expect(decode({ kind: 'note', body: null }, decoder)).toEqual({ kind: 'note' })
  })

  it('passes a value matching no branch through for the server to reject', () => {
    const { decoder } = toPortable(doc, union)
    expect(decode({ kind: 'video', body: null }, decoder)).toEqual({ kind: 'video', body: null })
    expect(decode({ body: null }, decoder)).toEqual({ body: null })
    expect(decode('text', decoder)).toBe('text')
  })

  it('leaves the input schema an anyOf of the closed branches', () => {
    const { schema } = toPortable(doc, union)
    expect(schema['anyOf']).toHaveLength(2)
    expect(JSON.stringify(schema)).not.toMatch(/"(oneOf|discriminator)"/)
  })
})
