import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument, OperationObject, ParameterObject } from './openapi'
import { documentPath } from '../test/documents'

const witness = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument

/**
 * The witness with the two filtered collection actions core's witness declares: `count` takes
 * every filter of the collection read and `bulk-archive` takes `status`, `rating` and `labels`.
 */
function withActionFilters(doc: OpenApiDocument): OpenApiDocument {
  const out = structuredClone(doc)
  out.info!['x-generator'] = { ...out.info!['x-generator'], contract: 25 }
  const paths = out.paths!
  const filters = (paths['/articles']!.get!.parameters ?? []).filter((param) =>
    (param as ParameterObject).name?.startsWith('filter['),
  )
  const action = (from: OperationObject, id: string, keys?: readonly string[]) => {
    const op = structuredClone(from)
    delete op.requestBody
    op.operationId = `action.articles.${id}`
    op.parameters = filters.filter(
      (param) => keys === undefined || keys.includes(param.name!.slice(7, -1)),
    )
    return op
  }
  paths['/articles/-actions/count'] = {
    get: action(paths['/articles/-actions/stats']!.get!, 'count'),
  }
  paths['/articles/-actions/bulk-archive'] = {
    post: action(paths['/articles/-actions/import']!.post!, 'bulk-archive', [
      'status',
      'rating',
      'labels',
    ]),
  }
  return out
}

const doc = withActionFilters(witness)
const descriptor = buildDescriptor(doc)
const source = emit(doc, descriptor)

describe('generator contract 25 (action filters)', () => {
  it('reads the document without a warning', () => {
    expect(doc.info?.['x-generator']?.contract).toBe(25)
    expect(checkContract(doc)).toBeUndefined()
  })

  it("records the filters a collection action takes, all of the read's or a subset", () => {
    const articles = descriptor['articles']!
    expect(articles.actions!['count']!.filterable).toEqual(articles.filterable)
    expect(articles.actions!['bulk-archive']!.filterable).toEqual(['labels', 'rating', 'status'])
  })

  it('records nothing on an action without filters', () => {
    for (const action of Object.values(buildDescriptor(witness)['articles']!.actions!)) {
      expect(action.filterable).toBeUndefined()
    }
    expect(descriptor['articles']!.actions!['stats']!.filterable).toBeUndefined()
  })

  it('names the deprecated filters of an action as a collection read does', () => {
    expect(source).toContain(
      '        /** The server marks the `state` filter deprecated. */\n        filterable: [',
    )
    expect(source.match(/The server marks the `state` filter deprecated/g)).toHaveLength(2)
  })

  it('types the filter option by the keys the action takes', () => {
    expect(diagnostics(PROBE)).toEqual([])
  }, 30_000)
})

const PROBE = `
import { createClient } from './contract-25.client.gen'
const client = createClient({ baseUrl: 'https://api.example.com' })
export const counted = client.articles.actions.count({ filter: { wordCount: 3, state: 'x' } })
export const archived = client.articles.actions['bulk-archive']({
  filter: { status: 'draft', rating: { min: 1 }, labels: ['a'] },
  signal: new AbortController().signal,
})
// @ts-expect-error -- wordCount is a filter of the collection read, not of bulk-archive
export const outOfScope = client.articles.actions['bulk-archive']({ filter: { wordCount: 3 } })
// @ts-expect-error -- stats takes no filters, so it takes no options
export const stats = client.articles.actions.stats({ filter: {} })
`

/** The semantic errors TypeScript reports for `probe` against the client emitted for `doc`. */
function diagnostics(probe: string): string[] {
  const configPath = fileURLToPath(new URL('../tsconfig.typecheck.json', import.meta.url))
  const config = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  )!
  const probePath = fileURLToPath(new URL('./contract-25-probe.ts', import.meta.url))
  const clientPath = fileURLToPath(new URL('./contract-25.client.gen.ts', import.meta.url))
  const files = new Map([
    [probePath, probe],
    [clientPath, source],
  ])
  const clientSource = fileURLToPath(new URL('../../client/src/index.ts', import.meta.url))
  const read = (file: string) => files.get(file) ?? ts.sys.readFile(file)
  const service = ts.createLanguageService({
    getScriptFileNames: () => [probePath],
    getScriptVersion: () => '1',
    getScriptSnapshot: (file) => {
      const content = read(file)
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content)
    },
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => ({
      ...config.options,
      paths: { '@haddowg/json-api-client': [clientSource] },
    }),
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: (file) => files.has(file) || ts.sys.fileExists(file),
    readFile: read,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  })
  return service
    .getSemanticDiagnostics(probePath)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}
