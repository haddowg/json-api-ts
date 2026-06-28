import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import type { OpenApiDocument } from './openapi'
import type { SchemaObject } from './openapi'

/** A self-contained JSON Schema document, keyed by JSON:API type, as served at `GET /schemas.json`. */
export type SchemaBundle = Record<string, SchemaObject>

/** True when the input looks like an http(s) URL rather than a local path. */
function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input)
}

/** Decide YAML vs JSON by extension first, then by a cheap content sniff. */
function looksLikeYaml(source: string, text: string): boolean {
  if (/\.ya?ml$/i.test(source)) {
    return true
  }
  if (/\.json$/i.test(source)) {
    return false
  }
  // No decisive extension: JSON documents start with `{`/`[` once trimmed.
  return !/^\s*[{[]/.test(text)
}

function parse<T>(source: string, text: string, label: string): T {
  const doc = looksLikeYaml(source, text) ? parseYaml(text) : JSON.parse(text)
  if (doc === null || typeof doc !== 'object') {
    throw new Error(`${label} at ${source} did not parse to an object`)
  }
  return doc as T
}

/**
 * Fetch (URL) or read (file) `input`, then parse it as JSON or YAML (decided by extension,
 * falling back to a content sniff). Shared by the OpenAPI and JSON Schema readers.
 */
async function readSource<T>(input: string, label: string): Promise<T> {
  if (isHttpUrl(input)) {
    const res = await fetch(input)
    if (!res.ok) {
      throw new Error(`Failed to fetch ${label} from ${input}: ${res.status}`)
    }
    return parse<T>(input, await res.text(), label)
  }

  return parse<T>(input, await readFile(input, 'utf8'), label)
}

/**
 * Read an OpenAPI document from an http(s) URL or a local file path. Supports both JSON
 * and YAML (decided by extension, falling back to a content sniff).
 */
export async function readDocument(input: string): Promise<OpenApiDocument> {
  return readSource<OpenApiDocument>(input, 'OpenAPI document')
}

/**
 * Read the bundle's JSON Schema bundle (`GET /schemas.json`) from an http(s) URL or a
 * local file path — a map keyed by JSON:API type, each value a self-contained JSON Schema
 * 2020-12 resource-object document. Supports both JSON and YAML, like {@link readDocument}.
 */
export async function readSchemas(input: string): Promise<SchemaBundle> {
  return readSource<SchemaBundle>(input, 'JSON Schema bundle')
}
