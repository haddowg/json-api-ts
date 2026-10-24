import type { OpenApiDocument, SchemaObject, SchemaOrBool } from './openapi'
import { commentLines, propertyKey, stringLiteral } from './source'

const REF_PREFIX = '#/components/schemas/'
const ERROR_DOCUMENT = /^ErrorDocument(\d{3})?$/

/** One documented error code, with whatever the document says about it. */
export interface DocumentedErrorCode {
  code: string
  /** The `<Code>Error` component's `description`, when the document has one (contract 4). */
  description?: string
  /** Example `detail` values, from the component's `detail` property (`example` / `examples`). */
  examples: unknown[]
}

/** The server's error catalogue as the codegen reads it. */
export interface ErrorCatalogue {
  /** Every code any error document offers, sorted by code. */
  codes: DocumentedErrorCode[]
  /**
   * Per status, the codes its `ErrorDocument<NNN>` offers, sorted by code. A status whose
   * document offers only the generic `Error` maps to an empty list.
   */
  byStatus: Map<number, string[]>
}

function isSchema(value: SchemaOrBool | undefined): value is SchemaObject {
  return typeof value === 'object' && value !== null
}

/** A schema node and its `allOf` members, where a code variant keeps its narrowing. */
function layers(schema: SchemaObject): SchemaObject[] {
  return [schema, ...(schema.allOf ?? []).filter((member) => member.$ref === undefined)]
}

function property(schema: SchemaObject, name: string): SchemaObject | undefined {
  for (const layer of layers(schema)) {
    const prop = layer.properties?.[name]
    if (isSchema(prop)) {
      return prop
    }
  }
  return undefined
}

function examplesOf(detail: SchemaObject | undefined): unknown[] {
  if (detail === undefined) {
    return []
  }
  const examples = Array.isArray(detail['examples']) ? [...(detail['examples'] as unknown[])] : []
  if ('example' in detail && !examples.includes(detail['example'])) {
    examples.unshift(detail['example'])
  }
  return examples
}

/**
 * Read the documented error codes off a document's error documents. `ErrorDocument` and each
 * `ErrorDocument<NNN>` offer their codes as `errors.items.anyOf` branches that `$ref` a
 * `<Code>Error` component; a branch with a `code` const names a code, and the generic `Error`
 * branch (no const) names none.
 */
export function readErrorCatalogue(doc: OpenApiDocument): ErrorCatalogue {
  const schemas = doc.components?.schemas ?? {}
  const codes = new Map<string, DocumentedErrorCode>()
  const byStatus = new Map<number, string[]>()

  for (const [name, schema] of Object.entries(schemas)) {
    const match = ERROR_DOCUMENT.exec(name)
    if (match === null) {
      continue
    }
    const items = property(schema, 'errors')?.items
    const branches = items === undefined ? [] : [...(items.anyOf ?? []), ...(items.oneOf ?? [])]
    const documentCodes = new Set<string>()
    for (const branch of branches) {
      const component =
        typeof branch.$ref === 'string' && branch.$ref.startsWith(REF_PREFIX)
          ? schemas[branch.$ref.slice(REF_PREFIX.length)]
          : branch
      const code = component === undefined ? undefined : property(component, 'code')?.const
      if (component === undefined || typeof code !== 'string') {
        continue
      }
      documentCodes.add(code)
      if (!codes.has(code)) {
        const description = layers(component)
          .map((layer) => layer.description?.trim())
          .find((text) => text !== undefined && text !== '')
        codes.set(code, {
          code,
          ...(description ? { description } : {}),
          examples: examplesOf(property(component, 'detail')),
        })
      }
    }
    if (match[1] !== undefined) {
      // oxlint-disable-next-line no-array-sort -- sorting a freshly-created array
      byStatus.set(Number(match[1]), [...documentCodes].sort())
    }
  }

  return {
    // oxlint-disable-next-line no-array-sort -- sorting a freshly-created array
    codes: [...codes.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
    // oxlint-disable-next-line no-array-sort -- sorting a freshly-created array
    byStatus: new Map([...byStatus].sort(([a], [b]) => a - b)),
  }
}

/** A TSDoc block for one code: its description, then each example detail as an `@example`. */
function codeDoc(entry: DocumentedErrorCode, indent: string): string | undefined {
  const lines: string[] = []
  if (entry.description !== undefined) {
    lines.push(...commentLines(entry.description))
  }
  for (const example of entry.examples) {
    if (lines.length > 0) {
      lines.push('')
    }
    const text = typeof example === 'string' ? example : JSON.stringify(example)
    lines.push(...commentLines(`@example ${text}`))
  }
  if (lines.length === 0) {
    return undefined
  }
  if (lines.length === 1) {
    return `${indent}/** ${lines[0]!} */`
  }
  return [
    `${indent}/**`,
    ...lines.map((line) => `${indent} * ${line}`.trimEnd()),
    `${indent} */`,
  ].join('\n')
}

/**
 * Emit `ErrorCodes`, a const object keyed by every documented code with its TSDoc on the key
 * (editors show TSDoc on an object key, not on a string-literal union member), the `ErrorCode`
 * union derived from it, and `ErrorCodeByStatus`, the codes each status's error document offers.
 * A document with no code catalogue gets an empty `ErrorCodes` and `ErrorCode = string`, so the
 * bound guard still takes any code.
 */
export function emitErrorCodes(catalogue: ErrorCatalogue): string {
  const codeTypes =
    catalogue.codes.length === 0
      ? [
          '/** The documented error codes. This document catalogues none. */',
          'export const ErrorCodes = {} as const',
          '',
          '/** The documented error codes. This document catalogues none, so any code is accepted. */',
          'export type ErrorCode = string',
        ].join('\n')
      : [
          '/**',
          ' * Every error code this server documents, keyed by itself. Hover a key for what the code',
          ' * means: `hasErrorCode(error, ErrorCodes.RESOURCE_NOT_FOUND)`.',
          ' */',
          'export const ErrorCodes = {',
          ...catalogue.codes.flatMap((entry) => {
            const doc = codeDoc(entry, '  ')
            const member = `  ${propertyKey(entry.code)}: ${stringLiteral(entry.code)},`
            return doc === undefined ? [member] : [doc, member]
          }),
          '} as const',
          '',
          '/**',
          ' * Every error code this server documents. An error may still carry a code that is not',
          ' * listed: the catalogue is open.',
          ' */',
          'export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]',
        ].join('\n')

  const statusLines = [...catalogue.byStatus].map(([status, codes]) => {
    const members = codes.map((c) => stringLiteral(c))
    const line = `  ${status}: ${members.length === 0 ? 'never' : members.join(' | ')}`
    return line.length <= 100
      ? line
      : `  ${status}:\n${members.map((m) => `    | ${m}`).join('\n')}`
  })
  const byStatus = [
    '/**',
    ' * The documented error codes per HTTP status. `never` marks a status whose error document',
    ' * documents no specific code.',
    ' */',
    statusLines.length === 0
      ? 'export interface ErrorCodeByStatus {}'
      : `export interface ErrorCodeByStatus {\n${statusLines.join('\n')}\n}`,
  ].join('\n')

  const guard = [
    '/**',
    ' * True when `err` is a `JsonApiError` and any of its error objects carries `code`. Only takes a',
    ' * documented code; match an undocumented one with `hasErrorCode` from',
    " * '@haddowg/json-api-client'.",
    ' */',
    'export const hasErrorCode = hasErrorCodeRuntime as ErrorCodeGuard<ErrorCode>',
  ].join('\n')

  return [codeTypes, byStatus, guard].join('\n\n')
}
