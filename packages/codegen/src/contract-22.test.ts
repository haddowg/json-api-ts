import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument, OperationObject } from './openapi'
import { documentPath } from '../test/documents'

const fixturePath = documentPath('contract-witness.json')
const witness = JSON.parse(readFileSync(fixturePath, 'utf8')) as OpenApiDocument
const source = emit(witness, buildDescriptor(witness))

/** The witness with `edit` applied to a deep copy. */
function edited(edit: (doc: OpenApiDocument) => void): OpenApiDocument {
  const doc = structuredClone(witness)
  edit(doc)
  return doc
}

function operation(doc: OpenApiDocument, path: string, method: 'get' | 'post'): OperationObject {
  return doc.paths![path]![method]!
}

describe('generator contract 22 (deprecation)', () => {
  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(29)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('tags a deprecated attribute in the read, create and update interfaces', () => {
    expect(source).toContain('  /** @deprecated */\n  subtitle: string | null\n')
    expect(source.split('  /** @deprecated */\n  subtitle?: string\n')).toHaveLength(3)
  })

  it('tags a deprecated relation on its descriptor entry', () => {
    expect(source).toContain(
      '       * - `updateRelationship` needs `articles:write`\n       *\n       * @deprecated\n       */\n      formerAuthor: {',
    )
  })

  it('names a relation endpoint deprecated on its own without tagging the relation', () => {
    expect(source).toContain(
      '       * The `fetchRelated` endpoint is deprecated.\n       */\n      author: {',
    )
  })

  it('tags a deprecated action', () => {
    expect(source).toContain('      /** @deprecated */\n      retract: {')
  })

  it('tags a type whose every operation is deprecated, with its sunset date', () => {
    const tag = '/** @deprecated It may stop responding on or after 2027-06-30. */'
    expect(source).toContain(`  ${tag}\n  tags: {`)
    for (const key of ['create', 'delete', 'fetchMany', 'fetchOne', 'update']) {
      expect(source).toMatch(new RegExp(`      ${escape(tag)}\\n      ${key}: "/tags`))
    }
    expect(source).toContain(
      '       * @deprecated It may stop responding on or after 2027-06-30.\n       */\n      articles: {',
    )
  })

  it('names the deprecated filters, sorts and sort families of a collection', () => {
    expect(source).toContain(
      '    /** The server marks the `state` filter deprecated. */\n    filterable: [',
    )
    expect(source).toContain(
      '    /** The server marks the `length` sort deprecated, in either direction. */\n    sortable: [',
    )
    expect(source).toContain(
      '    /** The server marks the `legacy` sort family deprecated. */\n    sortFamilies: [',
    )
  })

  it('moves an action sunset sentence into its tag and keeps the author description', () => {
    const doc = edited((d) => {
      const op = operation(d, '/articles/{id}/-actions/retract', 'post')
      op.description =
        'Withdraw the article.\n\nThis operation may stop responding on or after 2027-01-01, its sunset date.'
    })
    expect(emit(doc, buildDescriptor(doc))).toContain(
      '      /**\n       * Withdraw the article.\n       *\n       * @deprecated It may stop responding on or after 2027-01-01.\n       */\n      retract: {',
    )
  })

  it('names several deprecated endpoints, filters and sorts in one sentence', () => {
    const doc = edited((d) => {
      operation(d, '/articles/{id}/relationships/author', 'get').deprecated = true
      const list = operation(d, '/articles', 'get')
      for (const param of list.parameters ?? []) {
        if (param.name === 'filter[status]') {
          ;(param as { deprecated?: boolean }).deprecated = true
        }
        if (param.name === 'sort') {
          param.schema!['x-deprecated-sorts'] = ['length', 'title']
        }
      }
    })
    const out = emit(doc, buildDescriptor(doc))
    expect(out).toContain('The `fetchRelated` and `fetchRelationship` endpoints are deprecated.')
    expect(out).toContain('The server marks the `state` and `status` filters deprecated.')
    expect(out).toContain('The server marks the `length` and `title` sorts deprecated')
  })

  it('emits nothing about deprecation for a document without markers', () => {
    const doc = JSON.parse(JSON.stringify(witness), (key, value: unknown) =>
      key === 'deprecated' || key === 'x-deprecated-sorts' ? undefined : value,
    ) as OpenApiDocument
    expect(emit(doc, buildDescriptor(doc))).not.toMatch(/deprecated/i)
  })

  it('strikes the deprecated members through at the call site', () => {
    expect(deprecationsIn(PROBE)).toEqual(['tags', 'retract', 'formerAuthor', 'subtitle'])
  }, 30_000)
})

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const PROBE = `
import { createClient } from '../test/generated/contract-witness.client.gen'
const client = createClient({ baseUrl: 'https://api.example.com' })
export const tags = client.tags
export const retract = client.articles.id('1').actions.retract
export const formerAuthor = client.articles.id('1').formerAuthor
export async function read() {
  const article = await client.articles.id('1').get()
  return article.subtitle
}
`

/** The names the TypeScript language service reports as deprecated in `text`, as an editor would. */
function deprecationsIn(text: string): string[] {
  const configPath = fileURLToPath(new URL('../tsconfig.typecheck.json', import.meta.url))
  const config = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    },
  )!
  const probe = fileURLToPath(new URL('./deprecation-probe.ts', import.meta.url))
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
  expect(service.getSemanticDiagnostics(probe).map((d) => d.messageText)).toEqual([])
  return service
    .getSuggestionDiagnostics(probe)
    .filter((diagnostic) => diagnostic.reportsDeprecated)
    .map((diagnostic) => text.slice(diagnostic.start, diagnostic.start! + diagnostic.length!))
}
