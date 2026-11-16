import { readFileSync } from 'node:fs'
import type { OpenApiDocument } from '../src/openapi'

type Json = Record<string, unknown>

/**
 * Core's `inboxes` singleton, cut from the contract witness of haddowg/json-api#369 with its
 * operation examples left out: the `/inbox` paths, the `Inboxes*` schemas and the
 * `InboxesRelatedQuery` parameter. Every other component it references is in the pinned witness.
 */
const INBOX = JSON.parse(
  readFileSync(new URL('./inbox-singleton.json', import.meta.url), 'utf8'),
) as { paths: Json; schemas: Json; parameters: Json }

/**
 * A copy of a witness with the `inboxes` singleton added the way core writes it, stamped with
 * generator contract 40: served at `/inbox` with an `owner` relation and a `mark-all-read` action,
 * and an update operation in the Atomic Operations unions.
 */
export function withInbox(original: OpenApiDocument): OpenApiDocument {
  const doc = structuredClone(original) as Json
  const info = doc['info'] as Json
  info['x-generator'] = { contract: 40 }
  Object.assign(doc['paths'] as Json, structuredClone(INBOX.paths))
  const components = doc['components'] as Json
  Object.assign(components['schemas'] as Json, structuredClone(INBOX.schemas))
  Object.assign(components['parameters'] as Json, structuredClone(INBOX.parameters))
  const schemas = components['schemas'] as Record<string, Json>
  const union = (node: Json, ref: string): void => {
    ;(node['oneOf'] as Json[]).push({ $ref: ref })
    ;((node['discriminator'] as Json)['mapping'] as Json)['inboxes'] = ref
  }
  const result = ((schemas['AtomicResult']!['properties'] as Json)['data'] as Json)['anyOf']
  union((result as Json[])[0]!, '#/components/schemas/InboxesResource')
  const update = (schemas['AtomicUpdateOperation']!['properties'] as Json)['data'] as Json
  union(update, '#/components/schemas/InboxesAtomicUpdate')
  return doc as OpenApiDocument
}
