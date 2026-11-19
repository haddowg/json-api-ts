import { readFileSync } from 'node:fs'
import type { OpenApiDocument } from '../src/openapi'
import { withFieldSelection } from './field-selection'

type Json = Record<string, unknown>

/** An entry of a section: a component or path added after `after`, or one whose value changed. */
interface Entry {
  after?: string | null
  value?: unknown
  operations?: Json
}

type Section = Record<string, Entry>

interface DocumentDelta {
  schemas?: Section
  parameters?: Section
  paths?: Section
}

/**
 * Core's typed request and resource object meta, cut from the contract witness of core main after
 * haddowg/json-api#389: every component and path that witness adds or changes against the pinned
 * one with field selection grafted on, and the baseline's closed pivots. It goes once the pins move
 * to core's published 2.22 witness.
 */
const TYPED_REQUEST_META = JSON.parse(
  readFileSync(new URL('./typed-request-meta.json', import.meta.url), 'utf8'),
) as { witness: DocumentDelta; baseline: DocumentDelta }

/** A copy of `record` with each entry of `section` set, an added one placed after its `after` key. */
function applied(record: Json, section: Section): Json {
  let out = { ...record }
  for (const [name, entry] of Object.entries(section)) {
    if (entry.operations !== undefined) {
      out[name] = { ...(out[name] as Json), ...structuredClone(entry.operations) }
    } else if (entry.after === undefined) {
      out[name] = structuredClone(entry.value)
    } else {
      const next: Json = {}
      if (entry.after === null) {
        next[name] = structuredClone(entry.value)
      }
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

function graft(original: OpenApiDocument, delta: DocumentDelta): OpenApiDocument {
  const doc = structuredClone(original) as Json
  ;(doc['info'] as Json)['x-generator'] = { contract: 43 }
  const components = doc['components'] as Json
  for (const key of ['schemas', 'parameters'] as const) {
    if (delta[key] !== undefined) {
      components[key] = applied((components[key] ?? {}) as Json, delta[key])
    }
  }
  if (delta.paths !== undefined) {
    doc['paths'] = applied(doc['paths'] as Json, delta.paths)
  }
  return doc as OpenApiDocument
}

/**
 * A copy of the pinned witness as core main exports it, stamped 43: field selection, then the
 * bookings, rooms and jobs types that declare request, resource, relationship and accepted meta,
 * the atomic kinds of their own, and the closed pivot and identifier meta objects.
 */
export function withTypedRequestMeta(witness: OpenApiDocument): OpenApiDocument {
  return graft(withFieldSelection(witness), TYPED_REQUEST_META.witness)
}

/** A copy of the pinned baseline witness as core main exports it: its pivots closed, stamped 43. */
export function baselineWithClosedPivots(baseline: OpenApiDocument): OpenApiDocument {
  return graft(baseline, TYPED_REQUEST_META.baseline)
}
