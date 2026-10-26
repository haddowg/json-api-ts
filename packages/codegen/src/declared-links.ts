import type { SchemaObject, SchemaOrBool } from './openapi'

const LINK_OBJECT_REF = '#/components/schemas/LinkObject'

/**
 * A link a resource type declares by name (generator contract 14). A link with meta or static
 * members is a link `object`, whose schema lists `href`, each static member as a `const` and its
 * `meta`. A link with neither is `bare`: the server renders it as a URL string.
 */
export interface DeclaredLink {
  name: string
  kind: 'object' | 'bare'
  /** The link's own schema, which carries its description and example. */
  schema: SchemaObject
}

function isSchema(value: SchemaOrBool | undefined): value is SchemaObject {
  return typeof value === 'object' && value !== null
}

/**
 * The declared links on a `<Type>ResourceLinks` component, in document order. `self` is never
 * declared, and a link the server builds itself, such as an action's link, points at
 * `RenderedLink`, so neither is read. A server that renders its links as strings points those at
 * `LinkObject` instead, so they read as bare links, which is the shape they render in. Expects
 * the document's single-entry `allOf` wrappers already read as their `$ref`.
 */
export function readDeclaredLinks(component: SchemaObject | undefined): DeclaredLink[] {
  const out: DeclaredLink[] = []
  for (const [name, schema] of Object.entries(component?.properties ?? {})) {
    if (name === 'self' || !isSchema(schema)) {
      continue
    }
    if (schema.$ref === LINK_OBJECT_REF) {
      out.push({ name, kind: 'bare', schema })
    } else if (schema.$ref === undefined && isSchema(schema.properties?.['href'])) {
      out.push({ name, kind: 'object', schema })
    }
  }
  return out
}
