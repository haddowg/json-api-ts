import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { ApiDescriptor, TransportRequest, TransportResponse } from '@haddowg/json-api-client'
import { buildDescriptor, hashJson } from '@haddowg/json-api-codegen'
import { type BuildModelOptions, buildMcpModel } from './build'
import type { McpModel } from './model'
import type { OpenApiDocument } from './openapi'

type FixtureName = 'music-catalog' | 'music-catalog-admin' | 'contract-witness'

const require = createRequire(import.meta.url)

/** The pinned package and file each fixture document is read from. */
const DOCUMENTS: Record<FixtureName, string> = {
  'music-catalog': '@haddowg/json-api-symfony-specs/music-catalog.openapi.json',
  'music-catalog-admin': '@haddowg/json-api-symfony-specs/music-catalog-admin.openapi.json',
  'contract-witness': '@haddowg/json-api-witness/contract-witness.json',
}

/** The installed path of a fixture document, from the exact version pinned at the root. */
export function documentPath(name: FixtureName): string {
  return require.resolve(DOCUMENTS[name])
}

/** A fixture document, the same ones the codegen package's tests read. */
export function source(name: FixtureName): {
  document: OpenApiDocument
  descriptor: ApiDescriptor
} {
  const path = documentPath(name)
  const document = JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument
  const descriptor = buildDescriptor(document as Parameters<typeof buildDescriptor>[0])
  return { document, descriptor }
}

/** The model for a document, built the way the generator builds it. */
export function modelOf(
  document: OpenApiDocument,
  descriptor: ApiDescriptor = buildDescriptor(document as Parameters<typeof buildDescriptor>[0]),
  options: Omit<BuildModelOptions, 'hash'> = {},
): { model: McpModel } {
  return { model: buildMcpModel(document, descriptor, { ...options, hash: hashJson(document) }) }
}

/** The model for a fixture document. */
export function fixture(
  name: FixtureName,
  options: Omit<BuildModelOptions, 'hash'> = {},
): { model: McpModel } {
  const { document, descriptor } = source(name)
  return modelOf(document, descriptor, options)
}

/** A transport answering from a handler, recording every request. */
export function fakeTransport(
  handler: (req: TransportRequest) => Partial<TransportResponse> & { json?: unknown },
): {
  transport: (req: TransportRequest) => Promise<TransportResponse>
  requests: TransportRequest[]
} {
  const requests: TransportRequest[] = []
  return {
    requests,
    transport: async (req) => {
      requests.push(req)
      const { json, ...res } = handler(req)
      return {
        status: res.status ?? 200,
        headers: res.headers ?? {},
        body: res.body ?? (json === undefined ? '' : JSON.stringify(json)),
        ...(res.binary !== undefined ? { binary: res.binary } : {}),
      }
    },
  }
}

type Json = Record<string, unknown>

const PREFIX = '#/components/schemas/'

/** The JSON type core writes beside a reference to a component: an enum's from its values. */
function componentType(component: Json): unknown {
  if (component['type'] !== undefined) {
    return component['type']
  }
  const values = (component['enum'] as unknown[] | undefined) ?? []
  return values.every((value) => Number.isInteger(value)) ? 'integer' : 'string'
}

/**
 * A copy of a document with every reference to one of the named value shapes written the way
 * generator contract 38 writes it, with the component's JSON type beside it, and stamped 38. A
 * bare `$ref` and an `allOf` wrapper become `{ type, allOf: [{ $ref }] }`, and a nullable
 * `anyOf: [{ $ref }, { type: 'null' }]` gains `type: [..., 'null']`.
 */
export function retype(original: OpenApiDocument, shapes: readonly string[]): OpenApiDocument {
  const doc = structuredClone(original) as Json
  const schemas = ((doc['components'] as Json | undefined)?.['schemas'] ?? {}) as Record<
    string,
    Json
  >
  const shapeOf = (entry: unknown): string | undefined => {
    if (typeof entry !== 'object' || entry === null) return undefined
    const ref = (entry as Json)['$ref']
    if (typeof ref !== 'string' || Object.keys(entry).length !== 1) return undefined
    const name = ref.slice(PREFIX.length)
    return ref.startsWith(PREFIX) && shapes.includes(name) ? name : undefined
  }
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit)
    if (typeof node !== 'object' || node === null) return node
    const n = node as Json
    if (n['type'] === undefined) {
      const allOf = n['allOf']
      if (Array.isArray(allOf) && allOf.length === 1) {
        const name = shapeOf(allOf[0])
        if (name !== undefined) return { type: componentType(schemas[name]!), ...n }
      }
      const anyOf = n['anyOf']
      if (Array.isArray(anyOf) && anyOf.length === 2) {
        const name = shapeOf(anyOf[0])
        const second = anyOf[1] as Json
        if (name !== undefined && Object.keys(second).length === 1 && second['type'] === 'null') {
          return { type: [componentType(schemas[name]!), 'null'].flat(), ...n }
        }
      }
    }
    if (typeof n['$ref'] === 'string') {
      const name = shapeOf({ $ref: n['$ref'] })
      if (name !== undefined) {
        const { $ref, ...rest } = n
        return { type: componentType(schemas[name]!), allOf: [{ $ref }], ...rest }
      }
      return n
    }
    return Object.fromEntries(Object.entries(n).map(([key, value]) => [key, visit(value)]))
  }
  const components = doc['components'] as Json
  const out = visit({ ...doc, components: { ...components, schemas: {} } }) as Json
  // A component's own definition is not a use of it, so only its members are rewritten.
  ;(out['components'] as Json)['schemas'] = Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, visit(value)])),
    ]),
  )
  ;((out['info'] as Json)['x-generator'] as Json)['contract'] = 38
  return out as OpenApiDocument
}
