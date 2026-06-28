/**
 * @haddowg/json-api-codegen — reads the bundle's OpenAPI 3.1 document (from a URL or
 * a local file) and emits the runtime descriptor + derived types + a bound
 * `createClient` (ADR 0001). Optionally reads the bundle's JSON Schemas to wire the
 * opt-in validation seam.
 *
 * The spec is fully self-describing for our needs (see CONTEXT.md): type identity is
 * `properties.type.const`; relationships, cardinality and related types come from the
 * relationship components' `data`; allowed `?include` paths are a bounded, pre-expanded
 * enum per endpoint; the create client-id policy is encoded in the create request
 * schema (`id: false` / required / optional).
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildDescriptor } from './build-descriptor'
import { detectVerbCollisions, emit } from './emit'
import { readDocument } from './reader'

export { buildDescriptor, DescriptorBuilder } from './build-descriptor'
export { detectVerbCollisions, emit, Emitter } from './emit'
export type { VerbCollision } from './emit'
export type * from './openapi'
export { readDocument } from './reader'

export interface CodegenConfig {
  /** OpenAPI document source: an http(s) URL or a local file path. */
  input: string
  /** Output file (or directory) for the generated client. */
  output: string
  /** Server name to target (the spec is per-server). Defaults to the default server. */
  server?: string
  /** JSON Schema source for the validation seam (URL or path). Off when omitted. */
  schemas?: string
}

/**
 * Read the OpenAPI document, build the runtime descriptor, emit the generated client
 * module and write it to `config.output` (creating parent directories as needed).
 *
 * `config.server` is metadata-only for now: the served document is already per-server,
 * so the caller selects the server by pointing `input` at the right document.
 */
export async function generate(config: CodegenConfig): Promise<string> {
  const doc = await readDocument(config.input)
  const descriptor = buildDescriptor(doc)

  for (const { type, relation } of detectVerbCollisions(descriptor)) {
    console.warn(
      `[json-api-codegen] "${type}" has a relation named "${relation}" which collides with a ` +
        'reserved verb on the resource handle; it will be reachable via .rel("' +
        `${relation}") in the fluent client.`,
    )
  }

  const source = emit(doc, descriptor)
  await mkdir(dirname(config.output), { recursive: true })
  await writeFile(config.output, source, 'utf8')
  return source
}
