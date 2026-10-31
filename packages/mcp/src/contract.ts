import type { OpenApiDocument } from './openapi'

/** The oldest generator contract this package reads: the baseline current servers stamp. */
export const MINIMUM_CONTRACT = 13

/** The newest generator contract this package reads. */
export const MAXIMUM_CONTRACT = 19

/**
 * Throw unless the document's `info.x-generator.contract` is in the range this package reads. A
 * document outside it would yield tools that miss or misread what the server offers, so there is
 * no warning mode.
 */
export function assertContract(doc: OpenApiDocument): number {
  const contract = doc.info?.['x-generator']?.contract
  if (typeof contract !== 'number') {
    throw new Error(
      `The OpenAPI document declares no generator contract (info.x-generator.contract). @haddowg/json-api-mcp reads contracts ${MINIMUM_CONTRACT} to ${MAXIMUM_CONTRACT}; regenerate the document from a newer haddowg/json-api server.`,
    )
  }
  if (contract < MINIMUM_CONTRACT) {
    throw new Error(
      `The OpenAPI document declares generator contract ${contract}, older than this package reads (${MINIMUM_CONTRACT} to ${MAXIMUM_CONTRACT}). Regenerate it from a newer haddowg/json-api server.`,
    )
  }
  if (contract > MAXIMUM_CONTRACT) {
    throw new Error(
      `The OpenAPI document declares generator contract ${contract}, newer than this package reads (${MINIMUM_CONTRACT} to ${MAXIMUM_CONTRACT}). Upgrade @haddowg/json-api-mcp.`,
    )
  }
  return contract
}
