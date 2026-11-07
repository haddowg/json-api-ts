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
