import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { emit } from './emit'
import { emitSchemas } from './emit-schemas'
import type { OpenApiDocument, SchemaObject } from './openapi'

const fixture = readFileSync(
  fileURLToPath(new URL('../test/fixtures/music-catalog.openapi.json', import.meta.url)),
  'utf8',
)

const ENUM_KEY = 'X = 1; alert(1); type Y'
const ENUM_VALUE = 'it\'s "quoted" `tick` ${alert(2)}'

/** The music catalog with every free-text and naming field that reaches the output made awkward. */
function awkwardDocument(): OpenApiDocument {
  const doc = JSON.parse(
    fixture.replaceAll('#/components/schemas/AlbumStatus"', `#/components/schemas/${ENUM_KEY}"`),
  ) as OpenApiDocument
  doc.info = {
    ...doc.info,
    title: 'Music */ alert(3); /*\nalert(4)',
    version: '1.0 */\r\nalert(5)//',
  }
  doc.servers = [{ url: 'https://music.example/*/alert(6)//\u2028alert(7)' }]

  const schemas = doc.components!.schemas!
  const status = schemas['AlbumStatus']!
  delete schemas['AlbumStatus']
  schemas[ENUM_KEY] = {
    ...status,
    enum: [...(status.enum ?? []), ENUM_VALUE, 'line\u2028break'],
    'x-enum-descriptions': [...(status['x-enum-descriptions'] ?? []), '*/ alert(8) /*', 'x'],
  }

  const attributes = schemas['AlbumsAttributes']!.properties!
  const title = attributes['title'] as SchemaObject
  title.description = 'Title */ alert(9) /* end'
  const releaseInfo = attributes['releaseInfo'] as SchemaObject
  releaseInfo.properties = { ...releaseInfo.properties, '"; alert(10); "': { type: 'string' } }
  return doc
}

const scratch = mkdtempSync(join(tmpdir(), 'japi-codegen-strings-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Type-check a generated module against the client's source, returning the error messages. */
function typecheck(source: string): string[] {
  const file = join(scratch, `client-${Math.random().toString(36).slice(2)}.gen.ts`)
  writeFileSync(file, source)
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    paths: {
      '@haddowg/json-api-client': [
        fileURLToPath(new URL('../../client/src/index.ts', import.meta.url)),
      ],
    },
  })
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

/** The identifier tokens in a module, skipping comments and string literals. */
function identifiers(code: string): Set<string> {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, code)
  const out = new Set<string>()
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.Identifier) {
      out.add(scanner.getTokenText())
    }
  }
  return out
}

describe('emit (document strings)', () => {
  const doc = awkwardDocument()
  const descriptor = buildDescriptor(doc)
  Object.defineProperty(descriptor['albums']!.attributes, '__proto__', {
    value: 'string',
    enumerable: true,
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const source = emit(doc, descriptor)
  const warnings = warn.mock.calls.map((call) => String(call[0]))
  warn.mockRestore()

  it('type-checks the unmodified fixture', () => {
    const plain = JSON.parse(fixture) as OpenApiDocument
    expect(typecheck(emit(plain, buildDescriptor(plain)))).toEqual([])
  })

  it('type-checks output generated from awkward names and text', () => {
    expect(typecheck(source)).toEqual([])
  })

  it('keeps document text out of the code, in both the TS and the emitted JS', () => {
    const js = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
    expect(identifiers(source).has('alert')).toBe(false)
    expect(identifiers(js).has('alert')).toBe(false)
  })

  it('keeps the provenance header to one comment', () => {
    const header = source.slice(0, source.indexOf(' */\n') + 4)
    expect(header).toContain('Source spec: Music * / alert(3); /* alert(4) 1.0 * / alert(5)//')
    expect(header).toContain('Server:      https://music.example/* /alert(6)// alert(7)')
    expect(source.indexOf('*/')).toBe(header.length - 3)
  })

  it('names an enum component that is not an identifier after its sanitised key', () => {
    expect(source).toContain('export type X1Alert1TypeY =')
    expect(source).toContain('status: X1Alert1TypeY')
    expect(source).not.toContain(ENUM_KEY.slice(0, 5) + ';')
  })

  it('writes enum values as string literals', () => {
    expect(source).toContain(JSON.stringify(ENUM_VALUE))
    expect(source).toContain('"line\\u2028break"')
  })

  it('keeps a __proto__ member an own key of a runtime literal', () => {
    expect(source).toContain('["__proto__"]: "string"')
    expect(source).not.toMatch(/^\s*__proto__:/m)
  })

  it('warns when it renames an enum component', () => {
    expect(warnings).toContain(
      `Enum component ${JSON.stringify(ENUM_KEY)} can't be used as a TypeScript type name; emitting it as X1Alert1TypeY.`,
    )
  })
})

describe('emitSchemas (document strings)', () => {
  it('keeps a __proto__ member an own key', () => {
    const source = emitSchemas({ albums: { properties: { ['__proto__']: { type: 'string' } } } })
    expect(source).toContain('["__proto__"]:')
  })
})
