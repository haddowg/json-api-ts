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
 * TODO: parse the OpenAPI document into an internal model, then emit the descriptor.
 *  - readDocument(input): fetch URL or read file; parse JSON/YAML
 *  - buildDescriptor(doc): walk components/paths -> ApiDescriptor + type interfaces
 *  - emit(descriptor): write `<output>` (descriptor `as const` + ApiFor types + createClient)
 *  - detect verb/relationship collisions and route those types through `.rel(name)`
 */
export async function generate(config: CodegenConfig): Promise<void> {
  void config
  throw new Error('not implemented yet — see the build order in this file')
}
