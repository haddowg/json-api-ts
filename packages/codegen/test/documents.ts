import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * The server documents the tests read, each from the exact version of its package pinned in
 * the workspace root: the bundle's music-catalog example (`@haddowg/json-api-symfony-specs`)
 * and core's contract witness (`@haddowg/json-api-witness`).
 */
const DOCUMENTS = {
  'music-catalog.openapi.json': '@haddowg/json-api-symfony-specs/music-catalog.openapi.json',
  'music-catalog.schemas.json': '@haddowg/json-api-symfony-specs/music-catalog.schemas.json',
  'music-catalog-admin.openapi.json':
    '@haddowg/json-api-symfony-specs/music-catalog-admin.openapi.json',
  'music-catalog-admin.schemas.json':
    '@haddowg/json-api-symfony-specs/music-catalog-admin.schemas.json',
  'contract-witness.json': '@haddowg/json-api-witness/contract-witness.json',
} as const

export type DocumentName = keyof typeof DOCUMENTS

/** The installed path of a pinned server document. */
export function documentPath(name: DocumentName): string {
  return require.resolve(DOCUMENTS[name])
}
