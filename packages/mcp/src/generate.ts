/**
 * @haddowg/json-api-mcp/generate: the build-time half. It reads an OpenAPI document, builds the
 * descriptor with `@haddowg/json-api-codegen` and writes the model the runtime serves. Run it
 * against the committed spec and commit its output, as with the generated client. The runtime
 * entry point never loads this module or the codegen.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ApiDescriptor } from '@haddowg/json-api-client'
import { buildMcpModel } from './build'
import type { McpModel } from './model'
import type { OpenApiDocument } from './openapi'

export { buildMcpModel } from './build'
export type { BuildModelOptions } from './build'

type Codegen = typeof import('@haddowg/json-api-codegen')

async function codegen(): Promise<Codegen> {
  try {
    return await import('@haddowg/json-api-codegen')
  } catch (error) {
    throw new Error(
      'Generating an MCP model needs @haddowg/json-api-codegen; add it to your dev dependencies.',
      { cause: error },
    )
  }
}

/** Options for {@link generateMcpModel}. */
export interface GenerateModelOptions {
  /** The page size a list tool asks for when the model gives none. Defaults to 10. */
  defaultPageSize?: number
  /**
   * How many relationships deep a tool's `include` may reach, 1 by default. `null` keeps every
   * path the document declares.
   */
  includeDepth?: number | null
}

/** Build the model from a parsed document, building its descriptor with the codegen. */
export async function generateMcpModel(
  document: OpenApiDocument,
  options: GenerateModelOptions = {},
): Promise<McpModel> {
  const { buildDescriptor, hashJson } = await codegen()
  const descriptor = buildDescriptor(
    document as Parameters<typeof buildDescriptor>[0],
  ) as ApiDescriptor
  return buildMcpModel(document, descriptor, { ...options, hash: hashJson(document) })
}

/** The model as the generator writes it: two-space JSON with a trailing newline. */
export function serialiseMcpModel(model: McpModel): string {
  return `${JSON.stringify(model, null, 2)}\n`
}

/** Options for {@link writeMcpModel}. */
export interface WriteModelOptions extends GenerateModelOptions {
  /** The OpenAPI document: an http(s) URL or a local file, JSON or YAML. */
  input: string
  /** Where the model goes, such as `src/api.mcp.json`. */
  output: string
  /** Compare against the committed model instead of writing it. */
  check?: boolean
}

/** What {@link writeMcpModel} did. */
export interface WriteModelResult {
  path: string
  /** For a check: whether the committed model matches. Always true after a write. */
  upToDate: boolean
}

/**
 * Read the document, build the model and write it, or with `check` compare it with the committed
 * file. The comparison is of the parsed JSON, so a formatter rewriting the file's whitespace
 * doesn't count as a change.
 */
export async function writeMcpModel(options: WriteModelOptions): Promise<WriteModelResult> {
  const { readDocument } = await codegen()
  const document = (await readDocument(options.input)) as OpenApiDocument
  const generateOptions: GenerateModelOptions = {}
  if (options.defaultPageSize !== undefined)
    generateOptions.defaultPageSize = options.defaultPageSize
  if (options.includeDepth !== undefined) generateOptions.includeDepth = options.includeDepth
  const content = serialiseMcpModel(await generateMcpModel(document, generateOptions))
  if (options.check === true) {
    let committed: unknown
    try {
      committed = JSON.parse(await readFile(options.output, 'utf8')) as unknown
    } catch {
      return { path: options.output, upToDate: false }
    }
    return {
      path: options.output,
      upToDate: JSON.stringify(committed) === JSON.stringify(JSON.parse(content)),
    }
  }
  await mkdir(dirname(options.output), { recursive: true })
  await writeFile(options.output, content, 'utf8')
  return { path: options.output, upToDate: true }
}
