import type { OpenApiDocument } from '../src/openapi'

type Json = Record<string, unknown>

const PREFIX = '#/components/schemas/'

/** The JSON type core writes beside a reference to a component: an enum's from its values. */
function componentType(component: Json): unknown {
  if (component['type'] !== undefined) {
    return component['type']
  }
  const values = (component['enum'] as unknown[] | undefined) ?? []
  return values.every((value) => Number.isInteger(value)) ? 'integer' : 'string'
}

/**
 * A copy of a document with every reference to one of the named value shapes written the way
 * generator contract 38 writes it, with the component's JSON type beside it, and stamped 38. A
 * bare `$ref` and an `allOf` wrapper become `{ type, allOf: [{ $ref }] }`, and a nullable
 * `anyOf: [{ $ref }, { type: 'null' }]` gains `type: [..., 'null']`.
 */
export function retype(original: OpenApiDocument, shapes: readonly string[]): OpenApiDocument {
  const doc = structuredClone(original) as Json
  const schemas = ((doc['components'] as Json | undefined)?.['schemas'] ?? {}) as Record<
    string,
    Json
  >
  const shapeOf = (entry: unknown): string | undefined => {
    if (typeof entry !== 'object' || entry === null) return undefined
    const ref = (entry as Json)['$ref']
    if (typeof ref !== 'string' || Object.keys(entry).length !== 1) return undefined
    const name = ref.slice(PREFIX.length)
    return ref.startsWith(PREFIX) && shapes.includes(name) ? name : undefined
  }
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit)
    if (typeof node !== 'object' || node === null) return node
    const n = node as Json
    if (n['type'] === undefined) {
      const allOf = n['allOf']
      if (Array.isArray(allOf) && allOf.length === 1) {
        const name = shapeOf(allOf[0])
        if (name !== undefined) return { type: componentType(schemas[name]!), ...n }
      }
      const anyOf = n['anyOf']
      if (Array.isArray(anyOf) && anyOf.length === 2) {
        const name = shapeOf(anyOf[0])
        const second = anyOf[1] as Json
        if (name !== undefined && Object.keys(second).length === 1 && second['type'] === 'null') {
          return { type: [componentType(schemas[name]!), 'null'].flat(), ...n }
        }
      }
    }
    if (typeof n['$ref'] === 'string') {
      const name = shapeOf({ $ref: n['$ref'] })
      if (name !== undefined) {
        const { $ref, ...rest } = n
        return { type: componentType(schemas[name]!), allOf: [{ $ref }], ...rest }
      }
      return n
    }
    return Object.fromEntries(Object.entries(n).map(([key, value]) => [key, visit(value)]))
  }
  const components = doc['components'] as Json
  const out = visit({ ...doc, components: { ...components, schemas: {} } }) as Json
  // A component's own definition is not a use of it, so only its members are rewritten.
  ;(out['components'] as Json)['schemas'] = Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, visit(value)])),
    ]),
  )
  ;((out['info'] as Json)['x-generator'] as Json)['contract'] = 38
  return out as OpenApiDocument
}
