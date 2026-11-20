import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { ApiDescriptor, TransportRequest, TransportResponse } from '@haddowg/json-api-client'
import { buildDescriptor, hashJson } from '@haddowg/json-api-codegen'
import { type BuildModelOptions, buildMcpModel } from './build'
import type { McpModel } from './model'
import type { OpenApiDocument } from './openapi'

type FixtureName =
  | 'music-catalog'
  | 'music-catalog-admin'
  | 'contract-witness'
  | 'contract-witness-baseline'

const require = createRequire(import.meta.url)

/** The pinned package and file each fixture document is read from. */
const DOCUMENTS: Record<FixtureName, string> = {
  'music-catalog': '@haddowg/json-api-symfony-specs/music-catalog.openapi.json',
  'music-catalog-admin': '@haddowg/json-api-symfony-specs/music-catalog-admin.openapi.json',
  'contract-witness': '@haddowg/json-api-witness/contract-witness.json',
  'contract-witness-baseline': '@haddowg/json-api-witness/contract-witness-baseline.json',
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

/**
 * A copy of a witness with core's nested fieldsets added, stamped 42: the articles' `scores` object,
 * `totals` map and `location` object, and the `fields[articles]` parameter accepting their single
 * keys and the keys of `location.geo`, from the
 * fragment the codegen's tests cut from core main's witness. It goes once the pins move to core's
 * published 2.22 witness.
 */
export function withNestedFieldsets(original: OpenApiDocument): OpenApiDocument {
  const fragment = JSON.parse(
    readFileSync(new URL('../../codegen/test/nested-fieldsets.json', import.meta.url), 'utf8'),
  ) as { attributes: Record<string, Json>; components: Record<string, Json>; fields: Json }
  const doc = structuredClone(original) as Json
  ;(doc['info'] as Json)['x-generator'] = { contract: 42 }
  const schemas = (doc['components'] as Json)['schemas'] as Record<string, Json>
  Object.assign(schemas, structuredClone(fragment.components))
  for (const [component, added] of Object.entries(fragment.attributes)) {
    const schema = schemas[component]!
    const properties: Json = {}
    for (const [name, property] of Object.entries(schema['properties'] as Json)) {
      properties[name] = property
      if (name === 'metrics') {
        Object.assign(properties, structuredClone(added))
      }
    }
    schema['properties'] = properties
    const required = schema['required'] as string[] | undefined
    if (component === 'ArticlesAttributes' && required !== undefined) {
      required.splice(required.indexOf('metrics') + 1, 0, ...Object.keys(added))
    }
  }
  for (const item of Object.values(doc['paths'] as Record<string, Json>)) {
    for (const op of Object.values(item) as Json[]) {
      const parameters = op['parameters'] as Json[] | undefined
      const at = parameters?.findIndex((param) => param['name'] === 'fields[articles]') ?? -1
      if (at >= 0) {
        parameters![at] = structuredClone(fragment.fields)
      }
    }
  }
  return doc as OpenApiDocument
}

/** An entry of a section of the typed request meta fragment: added after `after`, or changed. */
interface FragmentEntry {
  after?: string | null
  value?: unknown
  operations?: Json
}

type FragmentDelta = Partial<
  Record<'schemas' | 'parameters' | 'paths', Record<string, FragmentEntry>>
>

/** A copy of `record` with each entry of `section` set, an added one placed after its `after` key. */
function grafted(record: Json, section: Record<string, FragmentEntry>): Json {
  let out = { ...record }
  for (const [name, entry] of Object.entries(section)) {
    if (entry.operations !== undefined) {
      out[name] = { ...(out[name] as Json), ...structuredClone(entry.operations) }
    } else if (entry.after === undefined) {
      out[name] = structuredClone(entry.value)
    } else {
      const next: Json = entry.after === null ? { [name]: structuredClone(entry.value) } : {}
      for (const [key, value] of Object.entries(out)) {
        next[key] = value
        if (key === entry.after) {
          next[name] = structuredClone(entry.value)
        }
      }
      out = next
    }
  }
  return out
}

/**
 * A copy of the pinned witness as core main exports it, stamped 43: nested fieldsets, then the
 * bookings, rooms and jobs types declaring request, resource, relationship and accepted meta, from
 * the fragment the codegen's tests cut from core main's witness. It goes once the pins move to
 * core's published 2.22 witness.
 */
export function withTypedRequestMeta(original: OpenApiDocument): OpenApiDocument {
  const fragment = JSON.parse(
    readFileSync(new URL('../../codegen/test/typed-request-meta.json', import.meta.url), 'utf8'),
  ) as { witness: FragmentDelta }
  const doc = withNestedFieldsets(original) as unknown as Json
  ;(doc['info'] as Json)['x-generator'] = { contract: 43 }
  const components = doc['components'] as Json
  for (const key of ['schemas', 'parameters'] as const) {
    const section = fragment.witness[key]
    if (section !== undefined) {
      components[key] = grafted((components[key] ?? {}) as Json, section)
    }
  }
  if (fragment.witness.paths !== undefined) {
    doc['paths'] = grafted(doc['paths'] as Json, fragment.witness.paths)
  }
  return doc as OpenApiDocument
}
