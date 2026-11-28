import { describe, expect, it } from 'vitest'
import { createClient } from './client'
import type { ApiDescriptor } from './descriptor'
import { fieldErrors } from './field-errors'
import {
  type InputSchemas,
  InputValidationError,
  type StandardSchema,
  type StandardSchemaIssue,
} from './input-validation'
import type { TransportRequest, TransportResponse } from './transport'

const BASE = 'https://api.example'

const descriptor = {
  albums: {
    attributes: { title: 'string' },
    relations: {},
    paths: {
      fetchMany: '/albums',
      fetchOne: '/albums/{id}',
      create: '/albums',
      update: '/albums/{id}',
    },
    paginator: 'none',
    clientId: 'forbidden',
  },
} as const satisfies ApiDescriptor

// A Standard Schema that wants a non-blank `title` when it is present (or always, on create).
function titleSchema(required: boolean, async = false): StandardSchema {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value) => {
        const title = (value as { title?: unknown }).title
        const issues: StandardSchemaIssue[] =
          (required || title !== undefined) && (typeof title !== 'string' || title === '')
            ? [{ message: 'Title is required', path: [{ key: 'title' }] }]
            : []
        const result = issues.length > 0 ? { issues } : { value }
        return async ? Promise.resolve(result) : result
      },
    },
  }
}

function recorder(validateInput?: InputSchemas) {
  const requests: TransportRequest[] = []
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req)
    const body = { data: { type: 'albums', id: '1', attributes: { title: 'Kid A' } } }
    return { status: req.method === 'POST' ? 201 : 200, headers: {}, body: JSON.stringify(body) }
  }
  const client = createClient(descriptor, {
    baseUrl: BASE,
    transport,
    ...(validateInput === undefined ? {} : { validateInput }),
  })
  return { requests, client }
}

describe('validateInput', () => {
  const schemas = { albums: { create: titleSchema(true), update: titleSchema(false) } }

  it('rejects an invalid create before sending anything', async () => {
    const { requests, client } = recorder(schemas)
    const error = await client.albums.create({ title: '' }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(InputValidationError)
    expect(error).toMatchObject({ type: 'albums', operation: 'create' })
    expect((error as Error).message).toBe('The albums create input is invalid: Title is required')
    expect(requests).toHaveLength(0)
  })

  it('sends a valid create and update', async () => {
    const { requests, client } = recorder(schemas)
    await client.albums.create({ title: 'Kid A' })
    await client.albums.id('1').update({})
    expect(requests.map((r) => r.method)).toEqual(['POST', 'PATCH'])
  })

  it('checks an update against the update schema', async () => {
    const { requests, client } = recorder(schemas)
    await expect(client.albums.id('1').update({ title: '' })).rejects.toBeInstanceOf(
      InputValidationError,
    )
    expect(requests).toHaveLength(0)
  })

  it('waits for an async schema', async () => {
    const { requests, client } = recorder({ albums: { create: titleSchema(true, true) } })
    await expect(client.albums.create({ title: '' })).rejects.toBeInstanceOf(InputValidationError)
    expect(requests).toHaveLength(0)
  })

  it('starts the request at once for a write with no schema', () => {
    const { requests, client } = recorder({ albums: { create: titleSchema(true) } })
    void client.albums.id('1').update({ title: '' })
    expect(requests).toHaveLength(1)
  })

  it('gives fieldErrors() the issues as field errors', async () => {
    const { client } = recorder(schemas)
    const error = await client.albums.create({ title: '' }).catch((e: unknown) => e)
    const fe = fieldErrors<{ title: string }>(error)

    expect(fe?.first('title')).toBe('Title is required')
    expect(fe?.fields['title']?.[0]).toEqual({
      message: 'Title is required',
      path: ['title'],
      key: 'title',
    })
  })

  it('checks the creates and updates of an atomic batch before posting it', async () => {
    const requests: TransportRequest[] = []
    const client = createClient(descriptor, {
      baseUrl: BASE,
      transport: async (req) => {
        requests.push(req)
        return { status: 200, headers: {}, body: JSON.stringify({ 'atomic:results': [{}, {}] }) }
      },
      atomic: { path: '/operations' },
      validateInput: schemas,
    })

    const error = await client
      .atomic((tx) => {
        tx.create({ type: 'albums', title: 'Kid A' })
        tx.update({ type: 'albums', id: '1', title: '' })
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InputValidationError)
    expect(error).toMatchObject({ type: 'albums', operation: 'update', opIndex: 1 })
    expect(fieldErrors(error)?.op(1).first('title')).toBe('Title is required')
    expect(requests).toHaveLength(0)

    await client.atomic((tx) => {
      tx.create({ type: 'albums', title: 'Kid A' })
      tx.update({ type: 'albums', id: '1', title: 'Amnesiac' })
    })
    expect(requests).toHaveLength(1)
  })

  it('keys nested and indexed issue paths the way the runtime keys server errors', () => {
    const fe = fieldErrors(
      new InputValidationError('albums', 'create', [
        { message: 'a', path: ['releaseInfo', { key: 'label' }] },
        { message: 'b', path: ['orderedTracks', 0, '$pivot', 'position'] },
        { message: 'c' },
      ]),
    )
    expect(Object.keys(fe?.fields ?? {})).toEqual([
      'releaseInfo.label',
      'orderedTracks[0].$pivot.position',
    ])
    expect(fe?.form.map((issue) => issue.message)).toEqual(['c'])
  })
})
