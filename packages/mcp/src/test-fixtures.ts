import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ApiDescriptor, TransportRequest, TransportResponse } from '@haddowg/json-api-client'
import { buildDescriptor, hashJson } from '@haddowg/json-api-codegen'
import { buildMcpModel } from './build'
import type { McpModel } from './model'
import type { OpenApiDocument } from './openapi'

type FixtureName = 'music-catalog' | 'music-catalog-admin' | 'contract-witness'

/** A fixture document from the codegen package, the same ones its own tests read. */
export function source(name: FixtureName): {
  document: OpenApiDocument
  descriptor: ApiDescriptor
} {
  const path = fileURLToPath(
    new URL(`../../codegen/test/fixtures/${name}.openapi.json`, import.meta.url),
  )
  const document = JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument
  const descriptor = buildDescriptor(document as Parameters<typeof buildDescriptor>[0])
  return { document, descriptor }
}

/** The model for a document, built the way the generator builds it. */
export function modelOf(
  document: OpenApiDocument,
  descriptor: ApiDescriptor = buildDescriptor(document as Parameters<typeof buildDescriptor>[0]),
): { model: McpModel } {
  return { model: buildMcpModel(document, descriptor, { hash: hashJson(document) }) }
}

/** The model for a fixture document. */
export function fixture(name: FixtureName): { model: McpModel } {
  const { document, descriptor } = source(name)
  return modelOf(document, descriptor)
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
