import type { OpenApiDocument } from './openapi'

/**
 * Keywords that annotate a schema without constraining it. A single-entry `allOf` wrapper is
 * read as its `$ref` only when the wrapper carries nothing else, plus any `x-` extension.
 */
const ANNOTATIONS = new Set([
  'title',
  'description',
  'example',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  '$comment',
])

const unwrapped = new WeakMap<OpenApiDocument, OpenApiDocument>()

/**
 * The document with every `{ allOf: [{ $ref }], ...annotations }` node rewritten as
 * `{ $ref, ...annotations }`. From generator contract 9 the projector wraps a `$ref` that
 * carries an `example`, `examples` or `default` this way, because OAS 3.0 tooling ignores a
 * `$ref`'s siblings. Reading the wrapper as its `$ref` keeps every lookup that follows a `$ref`
 * working, and keeps the annotations for the TSDoc. The input is not modified.
 */
export function unwrapRefs(doc: OpenApiDocument): OpenApiDocument {
  let out = unwrapped.get(doc)
  if (out === undefined) {
    out = unwrapNode(doc) as OpenApiDocument
    unwrapped.set(doc, out)
    unwrapped.set(out, out)
  }
  return out
}

function unwrapNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(unwrapNode)
  }
  if (typeof node !== 'object' || node === null) {
    return node
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    out[key] = unwrapNode(value)
  }
  const ref = wrappedRef(out)
  if (ref === undefined) {
    return out
  }
  const { allOf: _allOf, ...annotations } = out
  return { $ref: ref, ...annotations }
}

/** The `$ref` a node wraps in a single-entry `allOf`, when that is all the node constrains. */
function wrappedRef(node: Record<string, unknown>): string | undefined {
  const allOf = node['allOf']
  if (!Array.isArray(allOf) || allOf.length !== 1 || '$ref' in node) {
    return undefined
  }
  const entry: unknown = allOf[0]
  if (typeof entry !== 'object' || entry === null) {
    return undefined
  }
  const keys = Object.keys(entry)
  const ref = (entry as Record<string, unknown>)['$ref']
  if (keys.length !== 1 || typeof ref !== 'string') {
    return undefined
  }
  const annotationsOnly = Object.keys(node).every(
    (key) => key === 'allOf' || ANNOTATIONS.has(key) || key.startsWith('x-'),
  )
  return annotationsOnly ? ref : undefined
}
