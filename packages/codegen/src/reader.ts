import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import type { OpenApiDocument } from './openapi'

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

function parse(source: string, text: string): OpenApiDocument {
  const doc = looksLikeYaml(source, text) ? parseYaml(text) : JSON.parse(text)
  if (doc === null || typeof doc !== 'object') {
    throw new Error(`OpenAPI document at ${source} did not parse to an object`)
  }
  return doc as OpenApiDocument
}

/**
 * Read an OpenAPI document from an http(s) URL or a local file path. Supports both JSON
 * and YAML (decided by extension, falling back to a content sniff).
 */
export async function readDocument(input: string): Promise<OpenApiDocument> {
  if (isHttpUrl(input)) {
    const res = await fetch(input)
    if (!res.ok) {
      throw new Error(`Failed to fetch OpenAPI document from ${input}: ${res.status}`)
    }
    return parse(input, await res.text())
  }

  return parse(input, await readFile(input, 'utf8'))
}
