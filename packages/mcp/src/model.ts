/**
 * The generated artefact the runtime reads: everything a host needs to serve the tools, built
 * from the OpenAPI document at build time. It is plain JSON, so any host can load it, and it
 * carries the client's descriptor because the client can't make a call without one.
 */
import type { ApiDescriptor } from '@haddowg/json-api-client'
import type { ResultShape } from './catalogue'
import { MAXIMUM_CONTRACT, MINIMUM_CONTRACT } from './contract'
import type { ActionBodyPlan, QueryPlan, WritePlan } from './inputs'
import { isObject, type OperationObject, type SecurityRequirement } from './openapi'
import type { McpOperationKind, McpTool, SkippedOperation } from './types'

/** The artefact's own format. A runtime refuses a format it doesn't know. */
export const MODEL_FORMAT = 2

/** Every format this runtime reads. Format 1 has no `credentialSchemes`. */
const READABLE_FORMATS: readonly number[] = [1, MODEL_FORMAT]

/** The package that writes the artefact. */
export const MODEL_GENERATOR = '@haddowg/json-api-mcp'

/** One operation, as hooks see it, without the descriptor entries the runtime adds back. */
export interface McpModelOperation {
  operationId: string
  toolName: string
  kind: McpOperationKind
  type: string
  relation?: string
  action?: string
  /** The action's key in the type's descriptor `actions`. */
  actionKey?: string
  method: string
  path: string
  /**
   * The operation object, extensions included, without its `parameters`, `requestBody` and
   * `responses`: the tool already holds what those say, and they can refer to components the
   * artefact doesn't carry.
   */
  operation: OperationObject
  security: readonly SecurityRequirement[]
  /** The OAuth scopes the descriptor says the operation needs. Absent when none. */
  scopes?: readonly string[]
}

/** How the handler turns one tool's arguments into a client call. */
export interface McpModelPlan {
  query?: QueryPlan
  write?: WritePlan
  action?: ActionBodyPlan
}

export interface McpModelTool {
  operation: McpModelOperation
  tool: McpTool
  plan: McpModelPlan
  result: ResultShape
}

/** The generated artefact. */
export interface McpModel {
  format: 1 | typeof MODEL_FORMAT
  generator: typeof MODEL_GENERATOR
  /** The generator contract the source document declared. */
  contract: number
  /** Which document it was built from. */
  source: { title: string; hash: string }
  /** The document's first server URL, the default base URL. */
  baseUrl?: string
  /**
   * The security schemes an MCP caller authenticates with: the document's `oauth2` schemes.
   * Empty when it has none. A format 1 model doesn't carry it.
   */
  credentialSchemes?: string[]
  /** The json-api-ts descriptor the client calls through. */
  descriptor: ApiDescriptor
  tools: McpModelTool[]
  skipped: SkippedOperation[]
}

/** Thrown when an artefact can't be read: another format, or a contract out of range. */
export class McpModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpModelError'
  }
}

/** Check a parsed artefact before the runtime trusts it. */
export function assertModel(value: unknown): McpModel {
  if (!isObject(value) || value['generator'] !== MODEL_GENERATOR) {
    throw new McpModelError(
      `This isn't a model written by ${MODEL_GENERATOR}. Generate one with the json-api-mcp CLI.`,
    )
  }
  if (typeof value['format'] !== 'number' || !READABLE_FORMATS.includes(value['format'])) {
    throw new McpModelError(
      `The model is format ${String(value['format'])} and this runtime reads formats ${READABLE_FORMATS.join(' and ')}. Regenerate it with the same version of ${MODEL_GENERATOR} the server runs.`,
    )
  }
  const contract = value['contract']
  if (typeof contract !== 'number' || contract < MINIMUM_CONTRACT || contract > MAXIMUM_CONTRACT) {
    throw new McpModelError(
      `The model was built from a document with generator contract ${String(contract)}, and this runtime reads contracts ${MINIMUM_CONTRACT} to ${MAXIMUM_CONTRACT}.`,
    )
  }
  if (!isObject(value['descriptor']) || !Array.isArray(value['tools'])) {
    throw new McpModelError('The model has no descriptor or tools; regenerate it.')
  }
  const credentialSchemes = value['credentialSchemes']
  if (
    value['format'] !== 1 &&
    (!Array.isArray(credentialSchemes) || !credentialSchemes.every((s) => typeof s === 'string'))
  ) {
    throw new McpModelError('The model has no credentialSchemes list; regenerate it.')
  }
  return value as unknown as McpModel
}

/**
 * The schemes a format 1 model's caller is taken to authenticate with, since it doesn't record
 * them: every scheme some operation lists scopes under.
 */
export function inferCredentialSchemes(model: McpModel): string[] {
  const schemes = new Set<string>()
  for (const tool of model.tools) {
    for (const requirement of tool.operation.security) {
      for (const [scheme, scopes] of Object.entries(requirement)) {
        if (scopes.length > 0) schemes.add(scheme)
      }
    }
  }
  return [...schemes]
}
