import type { OpenApiDocument } from './openapi'

/** Below this the document predates the structures this codegen reads. */
export const MINIMUM_CONTRACT = 1

/** Above this the document carries structures this codegen does not read. */
export const MAXIMUM_CONTRACT = 13

/**
 * Check the document's `info.x-generator.contract` against the range this codegen reads. A
 * document older than the range throws; a newer one returns a warning, because its new
 * structures would go unread and the client would silently miss what the server offers. A
 * document with no contract (json-api before 1.1.0) passes.
 */
export function checkContract(doc: OpenApiDocument): string | undefined {
  const contract = doc.info?.['x-generator']?.contract
  if (typeof contract !== 'number') {
    return undefined
  }
  if (contract < MINIMUM_CONTRACT) {
    throw new Error(
      `the document declares contract ${contract}, which predates what this codegen reads (it supports ${MINIMUM_CONTRACT} to ${MAXIMUM_CONTRACT}). Use an older codegen release, or regenerate the document from a newer server.`,
    )
  }
  if (contract > MAXIMUM_CONTRACT) {
    return `the document declares contract ${contract} and this codegen reads up to ${MAXIMUM_CONTRACT}. It describes capabilities that were not generated; upgrade the codegen to pick them up.`
  }
  return undefined
}
