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

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildDescriptor } from './build-descriptor'
import { detectVerbCollisions, emit } from './emit'
import { emitSchemas } from './emit-schemas'
import { readDocument, readSchemas } from './reader'

export { buildAtomic, buildDescriptor, DescriptorBuilder } from './build-descriptor'
export { detectVerbCollisions, emit, Emitter } from './emit'
export type { VerbCollision } from './emit'
export { emitSchemas } from './emit-schemas'
export type * from './openapi'
export { deriveProvenance, hashJson, provenanceLines } from './provenance'
export type { Provenance } from './provenance'
export { readDocument, readSchemas } from './reader'
export type { SchemaBundle } from './reader'

export interface CodegenConfig {
  /** OpenAPI document source: an http(s) URL or a local file path. */
  input: string
  /** Output file (or directory) for the generated client. */
  output: string
  /** Server name to target (the spec is per-server). Defaults to the default server. */
  server?: string
  /** JSON Schema source for the validation seam (URL or path). Off when omitted. */
  schemas?: string
  /**
   * Drift-check mode: regenerate in-memory and compare against the committed `output`
   * (and its schema artifact when `schemas` is set) instead of writing. Nothing is
   * written; {@link check} reports whether the committed artifacts are up to date.
   */
  check?: boolean
}

/** One artifact's drift status: the file it stands for, and whether it is up to date. */
export interface ArtifactDrift {
  /** The committed artifact path (the client output, or its schema sibling). */
  path: string
  /** True when the committed file matches the freshly generated content. */
  upToDate: boolean
}

/** The outcome of a {@link check} run: `ok` iff every checked artifact is up to date. */
export interface CheckResult {
  ok: boolean
  artifacts: ArtifactDrift[]
}

/**
 * The schema-artifact path beside a client output path: `client.gen.ts` -> `client.schemas.gen.ts`
 * (any `.gen.ts`/`.ts` suffix is preserved; a suffix-less path just gains `.schemas`).
 */
export function schemasOutputPath(output: string): string {
  if (output.endsWith('.gen.ts')) {
    return `${output.slice(0, -'.gen.ts'.length)}.schemas.gen.ts`
  }
  if (output.endsWith('.ts')) {
    return `${output.slice(0, -'.ts'.length)}.schemas.ts`
  }
  return `${output}.schemas`
}

/** One rendered artifact: its target path and the freshly generated content. */
interface RenderedArtifact {
  path: string
  content: string
}

/**
 * Read the source spec(s), build the descriptor and render every generated artifact in
 * memory (the client source first, then the schema artifact when `config.schemas` is set)
 * — the shared core of {@link generate} (which writes them) and {@link check} (which
 * compares them). Verb-collision warnings are emitted here so both paths surface them.
 */
async function render(config: CodegenConfig): Promise<RenderedArtifact[]> {
  const doc = await readDocument(config.input)
  const descriptor = buildDescriptor(doc)

  for (const { type, relation } of detectVerbCollisions(descriptor)) {
    console.warn(
      `[json-api-codegen] "${type}" has a relation named "${relation}" which collides with a ` +
        'reserved verb on the resource handle; it will be reachable via .rel("' +
        `${relation}") in the fluent client.`,
    )
  }

  const artifacts: RenderedArtifact[] = [{ path: config.output, content: emit(doc, descriptor) }]

  if (config.schemas !== undefined) {
    const bundle = await readSchemas(config.schemas)
    artifacts.push({ path: schemasOutputPath(config.output), content: emitSchemas(bundle) })
  }

  return artifacts
}

/**
 * Read the OpenAPI document, build the runtime descriptor, emit the generated client
 * module and write it to `config.output` (creating parent directories as needed).
 *
 * When `config.schemas` is set, also read the bundle's JSON Schema bundle and write a
 * separate per-type schema artifact (`<output>.schemas.gen.ts`) beside the client, wiring
 * the opt-in validation seam (ADR 0004). The main client output is unchanged either way.
 *
 * `config.server` is metadata-only for now: the served document is already per-server,
 * so the caller selects the server by pointing `input` at the right document.
 *
 * Returns the generated client source. When `config.check` is set nothing is written;
 * call {@link check} instead for the drift-gate result.
 */
export async function generate(config: CodegenConfig): Promise<string> {
  const artifacts = await render(config)
  await mkdir(dirname(config.output), { recursive: true })
  for (const { path, content } of artifacts) {
    await writeFile(path, content, 'utf8')
  }
  // The first artifact is always the client source.
  return artifacts[0]!.content
}

/**
 * Drift gate: regenerate every artifact in memory and compare it byte-for-byte against the
 * committed file on disk, WITHOUT writing anything. A missing committed file counts as drift
 * (not up to date). Returns per-artifact status plus an aggregate `ok` (true iff all match) —
 * the CI drift check reads `ok` and exits non-zero when it is false.
 */
export async function check(config: CodegenConfig): Promise<CheckResult> {
  const artifacts = await render(config)
  const results: ArtifactDrift[] = []
  for (const { path, content } of artifacts) {
    let committed: string | undefined
    try {
      committed = await readFile(path, 'utf8')
    } catch {
      committed = undefined
    }
    results.push({ path, upToDate: committed === content })
  }
  return { ok: results.every((r) => r.upToDate), artifacts: results }
}
