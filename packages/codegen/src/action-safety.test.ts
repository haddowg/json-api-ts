import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { TransportRequest } from '@haddowg/json-api-client'
import { describe, expect, it } from 'vitest'
import { createClient } from '../test/generated/contract-witness.client.gen'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument, OperationObject } from './openapi'

function loadWitness(): OpenApiDocument {
  const path = fileURLToPath(
    new URL('../test/fixtures/contract-witness.openapi.json', import.meta.url),
  )
  return JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument
}

const witness = loadWitness()

/**
 * The witness as a server before contract 15 projects it: every method of an action shares one
 * operation id, and no action declares its safety.
 */
function beforeContract15(): OpenApiDocument {
  const doc = loadWitness()
  doc.info = { ...doc.info, 'x-generator': { contract: 14 } }
  for (const [path, item] of Object.entries(doc.paths!)) {
    if (!path.includes('/-actions/')) {
      continue
    }
    for (const op of Object.values(item)) {
      if (op.operationId !== undefined) {
        op.operationId = op.operationId.replace(/\.(get|post|put|patch|delete)$/, '')
      }
      delete op['x-safety']
    }
  }
  return doc
}

function recordingClient(requests: TransportRequest[]) {
  return createClient({
    baseUrl: 'https://api.example.com',
    transport: async (request) => {
      requests.push(request)
      return { status: 200, headers: {}, body: JSON.stringify({ meta: { rows: 3 } }) }
    },
  })
}

describe('generator contract 15 (action method ids and safety)', () => {
  const actions = buildDescriptor(witness).articles!.actions!

  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(18)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('keeps the preferred method of a multi-method action under its name', () => {
    expect(actions['export']).toEqual({
      scope: 'collection',
      path: '/articles/-actions/export',
      input: 'none',
      output: 'meta',
    })
  })

  it('names each other method after the action and the method', () => {
    expect(actions['exportGet']).toEqual({
      scope: 'collection',
      path: '/articles/-actions/export',
      input: 'none',
      output: 'meta',
      method: 'GET',
    })
  })

  it('sends each method from its own accessor', async () => {
    const requests: TransportRequest[] = []
    const client = recordingClient(requests)
    await client.articles.actions.export()
    await client.articles.actions.exportGet()
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'POST https://api.example.com/articles/-actions/export',
      'GET https://api.example.com/articles/-actions/export',
    ])
  })

  it('carries the declared safety flags, false ones included', () => {
    expect(actions['preview']).toMatchObject({
      readOnly: true,
      destructive: false,
      idempotent: true,
    })
    expect(actions['purge']).toEqual({
      scope: 'resource',
      path: '/articles/{id}/-actions/purge',
      input: 'none',
      output: 'none',
      destructive: true,
    })
  })

  it('leaves the flags off an action that declares none', () => {
    for (const name of ['export', 'exportGet', 'publish', 'import']) {
      expect(actions[name]).not.toHaveProperty('readOnly')
      expect(actions[name]).not.toHaveProperty('destructive')
      expect(actions[name]).not.toHaveProperty('idempotent')
    }
  })

  it('says what an action declares in its docblock', () => {
    const source = emit(witness, buildDescriptor(witness))
    expect(source).toContain(
      '/** The server declares this action read-only, not destructive and idempotent. */\n      preview: {',
    )
    expect(source).toContain('/** The server declares this action destructive. */\n      purge: {')
  })
})

describe('multi-method action naming', () => {
  function withMethods(name: string): OpenApiDocument {
    const doc = loadWitness()
    const path = `/articles/-actions/${name}`
    const op = (method: string): OperationObject => ({
      operationId: `action.articles.${name}.${method}`,
      responses: { '204': {} },
    })
    doc.paths![path] = { get: op('get'), patch: op('patch'), delete: op('delete') }
    return doc
  }

  it('joins the method the way the name joins its words', () => {
    expect(Object.keys(buildDescriptor(withMethods('re-index')).articles!.actions!)).toEqual(
      expect.arrayContaining(['re-index', 're-index-delete', 're-index-patch']),
    )
    expect(Object.keys(buildDescriptor(withMethods('re_index')).articles!.actions!)).toEqual(
      expect.arrayContaining(['re_index', 're_index_delete', 're_index_patch']),
    )
  })

  it('keeps the first method under the name when none is POST', () => {
    const actions = buildDescriptor(withMethods('reindex')).articles!.actions!
    expect(actions['reindex']?.method).toBe('GET')
    expect(actions['reindexPatch']?.method).toBe('PATCH')
    expect(actions['reindexDelete']?.method).toBe('DELETE')
  })

  it('ignores a safety flag that is not a boolean', () => {
    const doc = loadWitness()
    doc.paths!['/articles/{id}/-actions/purge']!.post!['x-safety'] = {
      destructive: 'yes',
      idempotent: true,
    }
    const purge = buildDescriptor(doc).articles!.actions!['purge']!
    expect(purge).not.toHaveProperty('destructive')
    expect(purge.idempotent).toBe(true)
  })
})

describe('a document before contract 15', () => {
  const older = beforeContract15()

  it('exposes only the preferred method of an action whose methods share one id', () => {
    const actions = buildDescriptor(older).articles!.actions!
    expect(actions['export']).toBeDefined()
    expect(actions).not.toHaveProperty('exportGet')
  })

  it('emits no safety flags and no safety docblock', () => {
    const source = emit(older, buildDescriptor(older))
    expect(source).not.toMatch(/readOnly|destructive|idempotent/)
    expect(source).not.toContain('The server declares this action')
  })
})
