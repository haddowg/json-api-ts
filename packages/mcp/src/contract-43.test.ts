import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument } from './openapi'
import { fakeTransport, modelOf, source } from './test-fixtures'

const { document: typed } = source('contract-witness')

const toolsOf = (doc: OpenApiDocument) => createJsonApiMcp(modelOf(doc)).tools
const tool = (name: string) => toolsOf(typed).find((entry) => entry.name === name)!
const argument = (name: string, arg: string): JsonSchema | undefined =>
  (tool(name).inputSchema['properties'] as Record<string, JsonSchema>)[arg]

/** Call a tool against a transport answering `json` with `status`, returning what it sent. */
async function call(name: string, args: Record<string, unknown>, json: unknown, status = 200) {
  const { transport, requests } = fakeTransport(() => ({ status, json }))
  const mcp = createJsonApiMcp({ ...modelOf(typed), transport })
  const tools = await mcp.forRequest({ context: undefined })
  const result = await tools.callTool(name, args)
  return {
    result,
    requests,
    sent: requests.map((req) => JSON.parse(req.body ?? 'null') as unknown),
  }
}

const booking = {
  type: 'bookings',
  id: 'bk-1',
  attributes: { title: 'Weekend' },
  meta: { nights: 3, heldUntil: null, channel: 'web' },
}

/**
 * A write declaring its request `meta` takes a request document of its own marked
 * `x-request-meta`, and a type declaring its resource objects' `meta` gets components marked
 * `x-resource-meta`. The write tools take each as an argument, and the output carries the
 * declared resource meta.
 */
describe('generator contract 43 (typed request and resource object meta)', () => {
  it('reads the witness', () => {
    expect(createJsonApiMcp(modelOf(typed)).contract).toBe(44)
  })

  it('takes the meta each write declares, required when the document requires it', () => {
    expect(argument('bookings_create', 'meta')).toMatchObject({
      type: 'object',
      properties: { idempotencyKey: { type: 'string' } },
      required: ['idempotencyKey'],
      additionalProperties: false,
    })
    expect(argument('bookings_update', 'meta')).toMatchObject({
      type: ['object', 'null'],
      properties: { reason: { type: ['string', 'null'] } },
    })
    expect(argument('bookings_delete', 'meta')).toMatchObject({
      properties: { cancellationReason: { type: 'string' } },
    })
    expect(argument('bookings_quote', 'meta')).toMatchObject({
      properties: { currency: { type: 'string' } },
    })
    // A meta-only request document takes no body, only the meta.
    expect(Object.keys(tool('bookings_confirm_post').inputSchema['properties']!)).toEqual([
      'id',
      'meta',
    ])
    for (const name of ['rooms_create', 'rooms_update', 'rooms_delete', 'bookings_confirm_patch']) {
      expect(argument(name, 'meta')).toBeUndefined()
      expect(argument(name, 'resourceMeta')).toBeUndefined()
    }
  })

  it('takes a resource meta whose undeclared members are typed as JSON text', () => {
    const schema = argument('bookings_create', 'resourceMeta')!
    expect(schema['type']).toEqual(['string', 'null'])
    expect(schema['description']).toMatch(/^The resource object's own `meta`/)
  })

  it('sends a create’s meta and resource meta, and returns the declared resource meta', async () => {
    const { result, sent } = await call(
      'bookings_create',
      {
        title: 'Weekend',
        rooms: null,
        guest: null,
        resourceMeta: '{"source":"web","campaign":"autumn"}',
        meta: { idempotencyKey: 'k-1' },
      },
      { data: booking },
      201,
    )
    expect(sent[0]).toEqual({
      data: {
        type: 'bookings',
        attributes: { title: 'Weekend' },
        meta: { source: 'web', campaign: 'autumn' },
      },
      meta: { idempotencyKey: 'k-1' },
    })
    expect(result.structuredContent).toMatchObject({
      data: { id: 'bk-1', title: 'Weekend', meta: { nights: 3, heldUntil: null, channel: 'web' } },
    })
  })

  it('sends a delete’s and an action’s meta-only document', async () => {
    const deleted = await call(
      'bookings_delete',
      { id: 'bk-1', meta: { cancellationReason: 'ill' } },
      undefined,
      204,
    )
    expect(deleted.requests[0]!.method).toBe('DELETE')
    expect(deleted.sent[0]).toEqual({ meta: { cancellationReason: 'ill' } })
    const confirmed = await call(
      'bookings_confirm_post',
      { id: 'bk-1', meta: { silent: true } },
      undefined,
      204,
    )
    expect(confirmed.sent[0]).toEqual({ meta: { silent: true } })
  })

  it('describes the declared resource meta in the output, and only for the types declaring it', () => {
    const meta = (name: string, type: string) =>
      (
        (tool(name).outputSchema!['$defs'] as Record<string, JsonSchema>)[type]!['properties'] as
          | Record<string, JsonSchema>
          | undefined
      )?.['meta']
    expect(meta('bookings_get', 'bookings')).toMatchObject({
      type: 'object',
      properties: { nights: { type: ['integer', 'null'] }, heldUntil: {} },
      additionalProperties: { type: ['string', 'null'] },
    })
    expect(meta('bookings_get', 'bookings')?.['x-resource-meta']).toBeUndefined()
    expect(meta('rooms_get', 'rooms')).toMatchObject({ additionalProperties: false })
    expect(meta('articles_get', 'articles')).toBeUndefined()
  })
})

/**
 * A write or action declaring a `202 Accepted` may answer with a job document whose `meta` the
 * operation declares. The tool returns that meta beside the job, and its output takes either.
 */
describe('an accepted write or action', () => {
  const job = { type: 'jobs', id: 'job-1', attributes: {} }
  const create = { title: 'Weekend', rooms: null, guest: null, meta: { idempotencyKey: 'k-1' } }

  async function accepted(name: string, args: Record<string, unknown>, json: unknown) {
    const { transport } = fakeTransport(() => ({
      status: 202,
      json,
      headers: { 'Content-Location': '/jobs/job-1', 'Retry-After': '5' },
    }))
    const mcp = createJsonApiMcp({ ...modelOf(typed), transport })
    const tools = await mcp.forRequest({ context: undefined })
    return tools.callTool(name, args)
  }

  const conforms = (name: string, value: unknown): boolean => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false })
    return ajv.validate(tool(name).outputSchema!, value)
  }

  it('returns the job beside the meta its 202 document carries', async () => {
    const created = await accepted('bookings_create', create, {
      data: job,
      meta: { queuePosition: 7 },
    })
    expect(created.structuredContent).toEqual({
      data: { id: 'job-1', type: 'jobs' },
      meta: { queuePosition: 7 },
    })
    expect(conforms('bookings_create', created.structuredContent)).toBe(true)
  })

  it('returns a meta-only job document as its meta', async () => {
    const created = await accepted('bookings_create', create, { meta: { queuePosition: 2 } })
    expect(created.structuredContent).toEqual({ meta: { queuePosition: 2 } })
    expect(conforms('bookings_create', created.structuredContent)).toBe(true)
  })

  it('returns the job of an action that otherwise answers with nothing', async () => {
    const confirmed = await accepted(
      'bookings_confirm_post',
      { id: 'bk-1' },
      { data: job, meta: { queuePosition: 4 } },
    )
    expect(confirmed.structuredContent).toEqual({
      data: { id: 'job-1', type: 'jobs' },
      meta: { queuePosition: 4 },
    })
  })

  it('types only the job for an operation whose only success is the 202', () => {
    const exports = createJsonApiMcp(modelOf(source('music-catalog').document)).tools.find(
      (entry) => entry.name === 'catalog_exports_create',
    )!
    const output = exports.outputSchema!
    expect(output['anyOf']).toBeUndefined()
    expect(output['properties']).toMatchObject({ data: { $ref: '#/$defs/export-jobs' } })
    expect(Object.keys(output['$defs'] as object)).toEqual(['export-jobs'])
  })

  it('types the job and its meta beside the usual result', async () => {
    const output = tool('bookings_create').outputSchema!
    expect(output['anyOf']).toEqual([
      expect.objectContaining({
        properties: expect.objectContaining({
          data: expect.objectContaining({ $ref: '#/$defs/bookings' }),
        }),
      }),
      expect.objectContaining({
        properties: {
          data: expect.objectContaining({ $ref: '#/$defs/jobs' }),
          meta: expect.objectContaining({
            properties: { queuePosition: { type: ['integer', 'null'] } },
            additionalProperties: false,
          }),
        },
      }),
    ])
    expect(Object.keys(output['$defs'] as object)).toEqual(
      expect.arrayContaining(['bookings', 'jobs']),
    )
    // The job's meta doesn't fit the usual result, nor the booking a job.
    expect(
      conforms('bookings_create', {
        data: { id: 'job-1', type: 'jobs' },
        meta: { queuePosition: 'x' },
      }),
    ).toBe(false)
    const { result } = await call('bookings_create', create, { data: booking }, 201)
    expect(conforms('bookings_create', result.structuredContent)).toBe(true)
  })
})
