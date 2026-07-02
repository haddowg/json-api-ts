import { createHash } from 'node:crypto'
import type { OpenApiDocument } from './openapi'

/**
 * A deterministic provenance record identifying the spec a client was generated from.
 * Stamped into every generated artifact's header so a reader (and the `--check` drift
 * gate) can tell which spec produced the committed output. Deliberately timestamp-free
 * — the same spec must always produce byte-identical output so `--check` can compare.
 */
export interface Provenance {
  /** `<title> <version>` from the document's `info` (falls back to `unknown` parts). */
  readonly source: string
  /** The first declared server URL, or `undefined` when none is declared. */
  readonly server: string | undefined
  /** A SHA-256 (first 16 hex chars) of the canonicalised source document. */
  readonly hash: string
}

/**
 * Canonicalise a JSON value with object keys sorted recursively, so the content hash is
 * insensitive to key ordering in the served document (two byte-different-but-equivalent
 * specs hash the same). Arrays keep their order (it is significant in OpenAPI).
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    // oxlint-disable-next-line no-array-sort -- sorting a freshly-created key array
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalise((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** A SHA-256 over an arbitrary JSON value (canonicalised), truncated to 16 hex chars (64 bits). */
export function hashJson(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalise(value)))
    .digest('hex')
    .slice(0, 16)
}

/**
 * Derive the provenance record for a source OpenAPI document. The `source` identifier is
 * `<info.title> <info.version>` (each part `unknown` when absent); the `hash` is a stable
 * content hash of the whole document.
 */
export function deriveProvenance(doc: OpenApiDocument): Provenance {
  const title = doc.info?.title ?? 'unknown'
  const version = doc.info?.version ?? 'unknown'
  return {
    source: `${title} ${version}`,
    server: doc.servers?.[0]?.url,
    hash: hashJson(doc),
  }
}

/**
 * Render the provenance record as the JSDoc header lines stamped into a generated artifact
 * (each already prefixed with ` * `). Deterministic: no timestamp, so re-generating from the
 * same spec yields byte-identical output.
 */
export function provenanceLines(provenance: Provenance): string[] {
  const lines = [` * Source spec: ${provenance.source}`, ` * Spec hash:   ${provenance.hash}`]
  if (provenance.server !== undefined) {
    lines.splice(1, 0, ` * Server:      ${provenance.server}`)
  }
  return lines
}
