import type { OpenApiDocument } from './openapi'

/**
 * Keywords that annotate a schema without constraining it. A single-entry `allOf` wrapper is
 * read as its `$ref` only when the wrapper carries nothing else, plus any `x-` extension and
 * the non-empty keywords below.
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

/**
 * The non-empty keywords a required use of a named shape carries beside its `$ref`. They narrow
 * the value without changing its type, so a wrapper holding them still reads as its `$ref`.
 */
const NON_EMPTY = new Set(['minLength', 'minItems', 'minProperties'])

const unwrapped = new WeakMap<OpenApiDocument, OpenApiDocument>()

/**
 * The document with every `{ allOf: [{ $ref }], ...annotations }` node rewritten as
 * `{ $ref, ...annotations }`. From generator contract 9 the projector wraps a `$ref` that
 * carries an `example`, `examples` or `default` this way, because OAS 3.0 tooling ignores a
 * `$ref`'s siblings. Reading the wrapper as its `$ref` keeps every lookup that follows a `$ref`
 * working, and keeps the annotations for the TSDoc. The input is not modified.
 *
 * From contract 38 a reference to a named value shape also carries its component's JSON `type`,
 * as `{ type, allOf: [{ $ref }] }` or, nullable, `{ type: [..., 'null'], anyOf: [{ $ref },
 * { type: 'null' }] }`. That `type` repeats the component's, so it is dropped and the node reads
 * as the reference. It stays when it disagrees with the component's own `type`.
 */
export function unwrapRefs(doc: OpenApiDocument): OpenApiDocument {
  let out = unwrapped.get(doc)
  if (out === undefined) {
    const schemas = (doc.components?.schemas ?? {}) as Record<string, unknown>
    out = unwrapNode(doc, schemas) as OpenApiDocument
    unwrapped.set(doc, out)
    unwrapped.set(out, out)
  }
  return out
}

type Schemas = Record<string, unknown>

function unwrapNode(node: unknown, schemas: Schemas): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) => unwrapNode(entry, schemas))
  }
  if (typeof node !== 'object' || node === null) {
    return node
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    out[key] = unwrapNode(value, schemas)
  }
  if (nullableTypedRef(out, schemas)) {
    const { type: _type, ...rest } = out
    return rest
  }
  const ref = wrappedRef(out, schemas)
  if (ref === undefined) {
    return out
  }
  const { allOf: _allOf, type: _type, ...annotations } = out
  return { $ref: ref, ...annotations }
}

/** Whether a key only annotates or narrows a reference, leaving its type alone. */
function annotates(key: string): boolean {
  return ANNOTATIONS.has(key) || NON_EMPTY.has(key) || key.startsWith('x-')
}

/** The `$ref` a node wraps in a single-entry `allOf`, when that is all the node constrains. */
function wrappedRef(node: Record<string, unknown>, schemas: Schemas): string | undefined {
  const allOf = node['allOf']
  if (!Array.isArray(allOf) || allOf.length !== 1 || '$ref' in node) {
    return undefined
  }
  const ref = bareRef(allOf[0])
  if (ref === undefined) {
    return undefined
  }
  const annotationsOnly = Object.keys(node).every(
    (key) => key === 'allOf' || key === 'type' || annotates(key),
  )
  if (!annotationsOnly) {
    return undefined
  }
  if ('type' in node) {
    const types = typeList(node['type'])
    if (types === undefined || types.includes('null') || !agrees(types, ref, schemas)) {
      return undefined
    }
  }
  return ref
}

/**
 * Whether a node is a nullable reference written `{ type: [..., 'null'], anyOf: [{ $ref },
 * { type: 'null' }] }` whose `type` agrees with the referenced component, so dropping it leaves
 * the same nullable reference.
 */
function nullableTypedRef(node: Record<string, unknown>, schemas: Schemas): boolean {
  const anyOf = node['anyOf']
  const types = typeList(node['type'])
  if (!Array.isArray(anyOf) || anyOf.length !== 2 || types === undefined || '$ref' in node) {
    return false
  }
  if (
    !types.includes('null') ||
    !Object.keys(node).every((key) => key === 'anyOf' || key === 'type' || annotates(key))
  ) {
    return false
  }
  const ref = bareRef(anyOf[0])
  if (ref === undefined || !isNullSchema(anyOf[1])) {
    return false
  }
  return agrees(
    types.filter((type) => type !== 'null'),
    ref,
    schemas,
  )
}

/** The `$ref` of an entry that holds nothing else. */
function bareRef(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return undefined
  }
  const ref = (entry as Record<string, unknown>)['$ref']
  return Object.keys(entry).length === 1 && typeof ref === 'string' ? ref : undefined
}

function isNullSchema(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) {
    return false
  }
  return Object.keys(entry).length === 1 && (entry as Record<string, unknown>)['type'] === 'null'
}

/** A `type` keyword as a list of names, or undefined when it is neither a name nor a list of them. */
function typeList(type: unknown): string[] | undefined {
  if (typeof type === 'string') {
    return [type]
  }
  if (Array.isArray(type) && type.length > 0 && type.every((entry) => typeof entry === 'string')) {
    return type as string[]
  }
  return undefined
}

/**
 * Whether a sibling `type` agrees with the component a local `$ref` names: the component declares
 * no `type`, as an enum component doesn't, or it declares the same set of JSON types, ignoring
 * `null`. A `$ref` that resolves to no local component never agrees.
 */
function agrees(types: readonly string[], ref: string, schemas: Schemas): boolean {
  const prefix = '#/components/schemas/'
  if (!ref.startsWith(prefix)) {
    return false
  }
  const component = schemas[ref.slice(prefix.length)]
  if (typeof component !== 'object' || component === null) {
    return false
  }
  if (!('type' in component)) {
    return true
  }
  const own = typeList((component as Record<string, unknown>)['type'])
  if (own === undefined) {
    return false
  }
  const expected = new Set(own.filter((type) => type !== 'null'))
  const given = new Set(types)
  return expected.size === given.size && [...given].every((type) => expected.has(type))
}
