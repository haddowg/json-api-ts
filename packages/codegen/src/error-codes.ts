import type { OpenApiDocument, SchemaObject, SchemaOrBool } from './openapi'
import { commentLines, propertyKey, stringLiteral } from './source'

const REF_PREFIX = '#/components/schemas/'
const RESPONSE_PREFIX = '#/components/responses/'
const JSON_API_MEDIA_TYPE = 'application/vnd.api+json'
const ERROR_DOCUMENT = /^ErrorDocument(\d{3})?(With[A-Za-z0-9]+)?$/

/** One documented error code, with whatever the document says about it. */
export interface DocumentedErrorCode {
  code: string
  /** The code's default title, from its branch of its shape's `code`. */
  title?: string
  /** What the code means and what a client should do, from its branch's `description`. */
  description?: string
  /** Example `detail` values, from the code's entry in `components.examples`. */
  examples: unknown[]
  /** The `meta` object its shape declares, when it declares one. */
  meta?: SchemaObject
  /** Whether every error object of the code carries `meta`. */
  metaRequired?: boolean
}

/** The server's error catalogue as the codegen reads it. */
export interface ErrorCatalogue {
  /** Every code any error document offers, sorted by code. */
  codes: DocumentedErrorCode[]
  /**
   * Per status, the codes its error documents offer, sorted by code: the shared
   * `ErrorDocument<NNN>` and each operation's own document at that status. A status whose
   * documents offer only the generic `Error` maps to an empty list.
   */
  byStatus: Map<number, string[]>
  /**
   * Per operation id, the codes only that operation and others like it raise, sorted: the
   * scoped codes its own error documents add to the shared ones.
   */
  byOperation: Map<string, string[]>
}

function isSchema(value: SchemaOrBool | undefined): value is SchemaObject {
  return typeof value === 'object' && value !== null
}

/** A schema node and its `allOf` members, where a shape keeps its narrowing. */
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

function required(schema: SchemaObject, name: string): boolean {
  return layers(schema).some((layer) => (layer.required ?? []).includes(name))
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** The `detail` of the one error a code's example document holds. */
function exampleDetail(doc: OpenApiDocument, code: string): unknown[] {
  const example = doc.components?.examples?.[code] as
    | { value?: { errors?: { detail?: unknown }[] } }
    | undefined
  const detail = example?.value?.errors?.[0]?.detail
  return detail === undefined ? [] : [detail]
}

function sortCodes(codes: Iterable<string>): string[] {
  // oxlint-disable-next-line no-array-sort -- sorting a freshly-created array
  return [...codes].sort()
}

/** Whether a component name is a shared error document: `ErrorDocument` or `ErrorDocument<NNN>`. */
function isSharedDocument(name: string): boolean {
  return /^ErrorDocument(\d{3})?$/.test(name)
}

/** One error response of one operation: its status and the error document its schema names. */
interface OperationErrorDocument {
  operationId: string
  status: number
  document: string
}

/**
 * The error document each operation answers with at each error status: the `$ref` of its
 * response's JSON:API schema, read inline or through the response component it references.
 */
function operationErrorDocuments(doc: OpenApiDocument): OperationErrorDocument[] {
  const responses = doc.components?.responses ?? {}
  const found: OperationErrorDocument[] = []
  for (const item of Object.values(doc.paths ?? {})) {
    for (const operation of Object.values(item ?? {})) {
      const op = operation as {
        operationId?: unknown
        responses?: Record<string, unknown>
      }
      if (typeof op !== 'object' || op === null || typeof op.operationId !== 'string') {
        continue
      }
      for (const [code, raw] of Object.entries(op.responses ?? {})) {
        const status = Number(code)
        if (!Number.isInteger(status) || status < 400 || status > 599) {
          continue
        }
        let response = raw as { $ref?: unknown } | undefined
        if (typeof response?.$ref === 'string') {
          response = response.$ref.startsWith(RESPONSE_PREFIX)
            ? (responses[response.$ref.slice(RESPONSE_PREFIX.length)] as typeof response)
            : undefined
        }
        const media = (response as { content?: Record<string, { schema?: { $ref?: unknown } }> })
          ?.content?.[JSON_API_MEDIA_TYPE]
        const ref = media?.schema?.$ref
        if (typeof ref === 'string' && ref.startsWith(REF_PREFIX)) {
          found.push({
            operationId: op.operationId,
            status,
            document: ref.slice(REF_PREFIX.length),
          })
        }
      }
    }
  }
  return found
}

/**
 * Read the documented error codes off a document's error documents: `ErrorDocument`, each
 * `ErrorDocument<NNN>`, each `ErrorDocument<NNN>With…`, and each document an operation's error
 * response names. They offer error shapes as `errors.items.anyOf` branches that `$ref` a shape
 * component, after the generic `Error`. A shape's `code` is an `anyOf` of `const` branches, one
 * per code, each carrying the code's `title` and `description`; its `meta`, when declared, types
 * every code in it.
 */
export function readErrorCatalogue(doc: OpenApiDocument): ErrorCatalogue {
  const schemas = doc.components?.schemas ?? {}
  const codes = new Map<string, DocumentedErrorCode>()
  const byStatus = new Map<number, Set<string>>()
  const byDocument = new Map<string, Set<string>>()
  const answered = operationErrorDocuments(doc).filter(({ document }) => {
    const schema = schemas[document]
    return schema !== undefined && property(schema, 'errors') !== undefined
  })
  const answeredNames = new Set(answered.map(({ document }) => document))

  const addToStatus = (status: number, documentCodes: Iterable<string>) => {
    const seen = byStatus.get(status) ?? new Set<string>()
    for (const code of documentCodes) {
      seen.add(code)
    }
    byStatus.set(status, seen)
  }

  for (const [name, schema] of Object.entries(schemas)) {
    const match = ERROR_DOCUMENT.exec(name)
    if (match === null && !answeredNames.has(name)) {
      continue
    }
    const items = property(schema, 'errors')?.items
    const branches = items === undefined ? [] : [...(items.anyOf ?? []), ...(items.oneOf ?? [])]
    const documentCodes = new Set<string>()
    for (const branch of branches) {
      const shape =
        typeof branch.$ref === 'string' && branch.$ref.startsWith(REF_PREFIX)
          ? schemas[branch.$ref.slice(REF_PREFIX.length)]
          : branch
      if (shape === undefined) {
        continue
      }
      const meta = property(shape, 'meta')
      for (const codeBranch of property(shape, 'code')?.anyOf ?? []) {
        const code = codeBranch.const
        if (typeof code !== 'string') {
          continue
        }
        documentCodes.add(code)
        if (!codes.has(code)) {
          const title = nonBlank(codeBranch.title)
          const description = nonBlank(codeBranch.description)
          codes.set(code, {
            code,
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
            examples: exampleDetail(doc, code),
            ...(meta ? { meta, metaRequired: required(shape, 'meta') } : {}),
          })
        }
      }
    }
    byDocument.set(name, documentCodes)
    if (match?.[1] !== undefined) {
      addToStatus(Number(match[1]), documentCodes)
    }
  }
  // A document named for an operation carries no status in its name: it takes the status of
  // the response that names it.
  for (const { status, document } of answered) {
    addToStatus(status, byDocument.get(document) ?? [])
  }

  return {
    // oxlint-disable-next-line no-array-sort -- sorting a freshly-created array
    codes: [...codes.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
    // oxlint-disable-next-line no-array-sort -- sorting a freshly-created array
    byStatus: new Map(
      [...byStatus].sort(([a], [b]) => a - b).map(([status, set]) => [status, sortCodes(set)]),
    ),
    byOperation: scopedCodesByOperation(answered, byDocument),
  }
}

/**
 * The codes each operation's own error documents add to the shared ones. An operation answering
 * a status with a document other than `ErrorDocument` or `ErrorDocument<NNN>` offers that
 * status's shared codes plus its scoped ones, so its scoped codes are the document's codes less
 * the shared `ErrorDocument<NNN>` codes.
 */
function scopedCodesByOperation(
  answered: OperationErrorDocument[],
  byDocument: Map<string, Set<string>>,
): Map<string, string[]> {
  const byOperation = new Map<string, Set<string>>()
  for (const { operationId, status, document } of answered) {
    if (isSharedDocument(document)) {
      continue
    }
    const shared = byDocument.get(`ErrorDocument${status}`) ?? new Set<string>()
    const scoped = byOperation.get(operationId) ?? new Set<string>()
    for (const code of byDocument.get(document) ?? []) {
      if (!shared.has(code)) {
        scoped.add(code)
      }
    }
    byOperation.set(operationId, scoped)
  }
  return new Map(
    // oxlint-disable-next-line no-array-sort -- sorting a freshly-created array
    [...byOperation]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, set]) => [id, sortCodes(set)]),
  )
}

/** A TSDoc block for one code: its description, then each example detail as an `@example`. */
function codeDoc(entry: DocumentedErrorCode, indent: string): string | undefined {
  const lines: string[] = []
  if (entry.title !== undefined) {
    lines.push(...commentLines(entry.title + '.'))
  }
  if (entry.description !== undefined) {
    if (lines.length > 0) {
      lines.push('')
    }
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
 * union derived from it, `ErrorCodeByStatus`, the codes each status's error documents offer,
 * `ErrorCodeByOperation`, the codes only some operations raise, `ErrorMetaByCode`, each code's
 * declared `meta` typed by `tsType`, and the guard and finder bound to them. A document with no
 * code catalogue gets an empty `ErrorCodes` and `ErrorCode = string`, so the bound guard still
 * takes any code.
 */
export function emitErrorCodes(
  catalogue: ErrorCatalogue,
  tsType: (schema: SchemaObject) => string = () => 'Record<string, unknown>',
): string {
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

  const operationLines = [...catalogue.byOperation].map(([id, codes]) => {
    const members = codes.map((c) => stringLiteral(c))
    const line = `  ${propertyKey(id)}: ${members.length === 0 ? 'never' : members.join(' | ')}`
    return line.length <= 100
      ? line
      : `  ${propertyKey(id)}:\n${members.map((m) => `    | ${m}`).join('\n')}`
  })
  const byOperation = [
    '/**',
    ' * The error codes only some operations raise, by operation id: what each adds to the codes its',
    ' * status documents for every operation.',
    ' */',
    operationLines.length === 0
      ? 'export interface ErrorCodeByOperation {}'
      : `export interface ErrorCodeByOperation {\n${operationLines.join('\n')}\n}`,
  ].join('\n')

  const metaLines = catalogue.codes
    .filter((entry) => entry.meta !== undefined)
    .map((entry) => {
      const type = tsType(entry.meta!)
      return `  ${propertyKey(entry.code)}: ${entry.metaRequired ? type : `${type} | undefined`}`
    })
  const metaByCode = [
    '/**',
    ' * The `meta` each documented code declares, by code. A code not listed carries untyped `meta`,',
    ' * and one whose `meta` is optional may arrive without it.',
    ' */',
    metaLines.length === 0
      ? 'export interface ErrorMetaByCode {}'
      : `export interface ErrorMetaByCode {\n${metaLines.join('\n')}\n}`,
  ].join('\n')

  const guard = [
    '/**',
    ' * True when `err` is a `JsonApiError` and any of its error objects carries `code`. Only takes a',
    ' * documented code; match an undocumented one with `hasErrorCode` from',
    " * '@haddowg/json-api-client'.",
    ' */',
    'export const hasErrorCode = hasErrorCodeRuntime as ErrorCodeGuard<ErrorCode>',
    '',
    '/**',
    ' * The first error object in `err` carrying `code`, with its `meta` typed when the code declares',
    ' * one, or `undefined`. Only takes a documented code; find an undocumented one with `findError`',
    " * from '@haddowg/json-api-client'.",
    ' */',
    'export const findError = findErrorRuntime as ErrorFinder<ErrorCode, ErrorMetaByCode>',
  ].join('\n')

  return [codeTypes, byStatus, byOperation, metaByCode, guard].join('\n\n')
}
