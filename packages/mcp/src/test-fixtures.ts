import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ApiDescriptor, TransportRequest, TransportResponse } from '@haddowg/json-api-client'
import { buildDescriptor } from '@haddowg/json-api-codegen'
import type { OpenApiDocument } from './openapi'

/** A fixture document from the codegen package, the same ones its own tests read. */
export function fixture(name: 'music-catalog' | 'music-catalog-admin' | 'contract-witness'): {
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
