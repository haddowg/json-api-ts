import type {
  ActionDescriptor,
  ApiDescriptor,
  ApiExamples,
  MediaExamples,
  OperationExamples,
  ResourceExamples,
} from '@haddowg/json-api-client'
import type { HttpMethod, MediaTypeObject, OpenApiDocument, OperationObject } from './openapi'

/** Operations that belong to no single type, so they have no place under one. */
const SERVER_OPERATIONS = new Set(['action', 'atomic'])

/** The `example` of each media type that declares one, in the document's order. */
function mediaExamples(
  content: Readonly<Record<string, MediaTypeObject>> | undefined,
): MediaExamples | undefined {
  const out: Record<string, unknown> = {}
  for (const [mediaType, media] of Object.entries(content ?? {})) {
    if (media !== null && typeof media === 'object' && 'example' in media) {
      out[mediaType] = media.example
    }
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * The request example and the `2xx` response examples of one operation, or `undefined` when it
 * declares none. Error responses are shared components rather than per-operation, so they are
 * left out.
 */
export function operationExamples(op: OperationObject | undefined): OperationExamples | undefined {
  if (op === undefined) {
    return undefined
  }
  const out: { request?: MediaExamples; responses?: Record<string, MediaExamples> } = {}
  const request = mediaExamples(op.requestBody?.content)
  if (request !== undefined) {
    out.request = request
  }
  for (const [status, response] of Object.entries(op.responses ?? {})) {
    const examples = status.startsWith('2') ? mediaExamples(response.content) : undefined
    if (examples !== undefined) {
      out.responses ??= {}
      out.responses[status] = examples
    }
  }
  return out.request === undefined && out.responses === undefined ? undefined : out
}

/** The operation an action is invoked over: its declared method, else `POST`. */
export function actionOperation(
  doc: OpenApiDocument,
  action: ActionDescriptor,
): OperationObject | undefined {
  const method = (action.method ?? 'POST').toLowerCase() as HttpMethod
  return doc.paths?.[action.path]?.[method]
}

function sorted<V>(record: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {}
  // oxlint-disable-next-line no-array-sort -- sorting a freshly-created key array
  for (const key of Object.keys(record).sort()) {
    out[key] = record[key]!
  }
  return out
}

/**
 * Collect the worked examples a contract 12 document puts on each operation, per type. A type's
 * operations are found by the `operationId`s the projector stamps (`create.albums`,
 * `fetchRelated.albums.tracks`) and keyed by that id without the type; its actions are keyed by
 * name, as the descriptor keys them. Types, operations and parts with no example are left out, so
 * a document without examples gives `{}`.
 */
export function buildExamples(doc: OpenApiDocument, descriptor: ApiDescriptor): ApiExamples {
  const operations = new Map<string, Record<string, OperationExamples>>()
  for (const item of Object.values(doc.paths ?? {})) {
    for (const op of Object.values(item) as (OperationObject | undefined)[]) {
      const id = op?.operationId
      if (typeof id !== 'string') {
        continue
      }
      // JSON:API member names can't hold a `.`, so the type is always the second segment.
      const [prefix, type, ...relation] = id.split('.')
      if (
        prefix === undefined ||
        type === undefined ||
        SERVER_OPERATIONS.has(prefix) ||
        !Object.hasOwn(descriptor, type)
      ) {
        continue
      }
      const examples = operationExamples(op)
      if (examples === undefined) {
        continue
      }
      let byName = operations.get(type)
      if (byName === undefined) {
        byName = {}
        operations.set(type, byName)
      }
      byName[[prefix, ...relation].join('.')] = examples
    }
  }

  const out: Record<string, ResourceExamples> = {}
  for (const [type, resource] of Object.entries(descriptor)) {
    const entry: {
      operations?: Record<string, OperationExamples>
      actions?: Record<string, OperationExamples>
    } = {}
    const byName = operations.get(type)
    if (byName !== undefined) {
      entry.operations = sorted(byName)
    }
    for (const [name, action] of Object.entries(resource.actions ?? {})) {
      const examples = operationExamples(actionOperation(doc, action))
      if (examples !== undefined) {
        entry.actions ??= {}
        entry.actions[name] = examples
      }
    }
    if (entry.operations !== undefined || entry.actions !== undefined) {
      out[type] = entry
    }
  }
  return out
}
