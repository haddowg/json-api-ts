/**
 * Helpers for writing strings read from the OpenAPI document into generated TypeScript. Every
 * name, literal and comment the emitters take from the document goes through one of these.
 */

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Line terminators as JavaScript counts them. */
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/

/** A string as a TS string literal. U+2028/U+2029 are escaped too, which JSON leaves raw. */
export function stringLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * A JSON value as a TS literal, indented two spaces with the value's key order kept. A
 * `__proto__` key becomes computed so it stays an own key, and U+2028/U+2029 are escaped.
 */
export function jsonLiteral(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/^(\s*)"__proto__":/gm, '$1["__proto__"]:')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** True when a string is a bare identifier. */
export function isIdentifier(value: string): boolean {
  return IDENTIFIER.test(value)
}

/**
 * A property key for an object literal or an interface: bare when it's an identifier, quoted
 * otherwise. `__proto__` is written as a computed key, which a runtime literal keeps as an own
 * property instead of setting the prototype.
 */
export function propertyKey(name: string): string {
  if (name === '__proto__') {
    return `[${stringLiteral(name)}]`
  }
  return isIdentifier(name) ? name : stringLiteral(name)
}

/** Text that can sit inside a block comment: any `*\/` is broken up so it can't close it. */
export function commentText(text: string): string {
  return text.replace(/\*\//g, '* /')
}

/** {@link commentText} split into lines, for a multi-line block comment. */
export function commentLines(text: string): string[] {
  return commentText(text).split(LINE_BREAK)
}

/** {@link commentText} on one line, for a single comment line such as the provenance header. */
export function commentLine(text: string): string {
  return commentText(text).split(LINE_BREAK).join(' ')
}

/** Words a type alias can't be named: reserved words and the built-in type names. */
const RESERVED_TYPE_NAMES = new Set([
  'any',
  'bigint',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'never',
  'new',
  'null',
  'number',
  'object',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'string',
  'super',
  'switch',
  'symbol',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'unknown',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

/** True when `name` can be used as is for an exported type. */
export function isTypeName(name: string): boolean {
  return isIdentifier(name) && !RESERVED_TYPE_NAMES.has(name)
}
