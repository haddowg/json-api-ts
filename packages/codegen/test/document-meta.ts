import { readFileSync } from 'node:fs'
import type { OpenApiDocument } from '../src/openapi'

type Json = Record<string, unknown>

/**
 * Core's `notices` type, cut from the contract witness of core main after haddowg/json-api#376
 * with its operation examples left out: the `/notices` paths, the `Notices*` schemas and the
 * `NoticesRelatedQuery` parameter. Every other component it references is in the pinned witness.
 */
const NOTICES = JSON.parse(
  readFileSync(new URL('./notices-document-meta.json', import.meta.url), 'utf8'),
) as { paths: Json; schemas: Json; parameters: Json }

/**
 * A copy of a witness with the `notices` type added the way core writes it, stamped with generator
 * contract 41. Its collection, single read, update, `replies` related read and delete declare
 * their top-level `meta`, and so do its `mark-read` and `snapshot` actions. Its create keeps the
 * shared document. Its operations join the Atomic Operations unions.
 */
export function withNotices(original: OpenApiDocument): OpenApiDocument {
  const doc = structuredClone(original) as Json
  const info = doc['info'] as Json
  info['x-generator'] = { contract: 41 }
  Object.assign(doc['paths'] as Json, structuredClone(NOTICES.paths))
  const components = doc['components'] as Json
  Object.assign(components['schemas'] as Json, structuredClone(NOTICES.schemas))
  Object.assign(components['parameters'] as Json, structuredClone(NOTICES.parameters))
  const schemas = components['schemas'] as Record<string, Json>
  const union = (node: Json, component: string): void => {
    const ref = `#/components/schemas/${component}`
    ;(node['oneOf'] as Json[]).push({ $ref: ref })
    ;((node['discriminator'] as Json)['mapping'] as Json)['notices'] = ref
  }
  const data = (component: string): Json =>
    (schemas[component]!['properties'] as Json)['data'] as Json
  union(data('AtomicAddOperation'), 'NoticesAtomicAdd')
  union(data('AtomicUpdateOperation'), 'NoticesAtomicUpdate')
  union(schemas['AtomicIdentifier']!, 'NoticesAtomicIdentifier')
  const result = data('AtomicResult')['anyOf'] as Json[]
  union(result[0]!, 'NoticesResource')
  union(result[1]!, 'NoticesResourceIdentifier')
  union(result[2]!['items'] as Json, 'NoticesResourceIdentifier')
  return doc as OpenApiDocument
}
