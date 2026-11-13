import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'

const fixturePath = documentPath('contract-witness.json')
const witness = JSON.parse(readFileSync(fixturePath, 'utf8')) as OpenApiDocument
const source = emit(witness, buildDescriptor(witness))

const SHAPE =
  '{ radius: number; width?: never; height?: never } | { width: number; height: number; radius?: never } | null'

describe('generator contract 23 (closed objects, undiscriminated unions)', () => {
  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(38)
    expect(checkContract(witness)).toBeUndefined()
  })

  it("types an undiscriminated union so each branch rules out the other branches' members", () => {
    expect(source).toContain(`  shape: ${SHAPE}\n`)
    expect(source.split(`  shape?: ${SHAPE}\n`)).toHaveLength(3)
  })

  it('leaves a discriminated union to its literal member', () => {
    expect(source).not.toMatch(/kind: "heading";[^}]*\?: never/)
  })

  it('leaves a union of open objects as it was', () => {
    const doc = JSON.parse(JSON.stringify(witness), (key, value: unknown) =>
      key === 'additionalProperties' && value === false ? undefined : value,
    ) as OpenApiDocument
    expect(emit(doc, buildDescriptor(doc))).toContain(
      '  shape: { radius: number } | { width: number; height: number } | null\n',
    )
  })

  it('names the new core error code', () => {
    expect(source).toContain('ATTRIBUTE_MEMBER_UNRECOGNIZED: "ATTRIBUTE_MEMBER_UNRECOGNIZED",')
  })

  it('accepts either branch and rejects a write that mixes them', () => {
    expect(errorsIn(PROBE)).toEqual([7, 8])
  }, 30_000)
})

const PROBE = `
import type { ArticlesUpdateAttributes } from '../test/generated/contract-witness.client.gen'
export const circle: ArticlesUpdateAttributes = { shape: { radius: 2 } }
export const rectangle: ArticlesUpdateAttributes = { shape: { width: 3, height: 4 } }
export const cleared: ArticlesUpdateAttributes = { shape: null }
export const area = (a: { shape: Exclude<ArticlesUpdateAttributes['shape'], undefined | null> }) => a.shape.radius !== undefined ? a.shape.radius : a.shape.width * a.shape.height
export const mixed: ArticlesUpdateAttributes = { shape: { radius: 2, width: 3 } }
export const partial: ArticlesUpdateAttributes = { shape: { width: 3 } }
`

/** The 1-based lines of `text` the TypeScript compiler reports an error on. */
function errorsIn(text: string): number[] {
  const configPath = fileURLToPath(new URL('../tsconfig.typecheck.json', import.meta.url))
  const config = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    },
  )!
  const probe = fileURLToPath(new URL('./union-probe.ts', import.meta.url))
  const clientSource = fileURLToPath(new URL('../../client/src/index.ts', import.meta.url))
  const service = ts.createLanguageService({
    getScriptFileNames: () => [probe],
    getScriptVersion: () => '1',
    getScriptSnapshot: (file) => {
      const content = file === probe ? text : ts.sys.readFile(file)
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content)
    },
    getCurrentDirectory: () => process.cwd(),
    // Against the client's source, as the tests run, so no build is needed first.
    getCompilationSettings: () => ({
      ...config.options,
      paths: { '@haddowg/json-api-client': [clientSource] },
    }),
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: (file) => file === probe || ts.sys.fileExists(file),
    readFile: (file) => (file === probe ? text : ts.sys.readFile(file)),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  })
  const file = ts.createSourceFile(probe, text, ts.ScriptTarget.Latest)
  return service
    .getSemanticDiagnostics(probe)
    .map((d) => file.getLineAndCharacterOfPosition(d.start!).line + 1)
}
