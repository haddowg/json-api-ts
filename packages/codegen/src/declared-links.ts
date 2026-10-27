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
 * The named links of a `<Type>ResourceLinks` component. From generator contract 18 the component
 * is an `allOf` of the shared `ResourceLinks` and an object listing them; before, it listed them
 * beside `self`.
 */
function namedLinks(component: SchemaObject | undefined): [string, SchemaOrBool][] {
  const own = Object.entries(component?.properties ?? {})
  const extended = (component?.allOf ?? [])
    .filter((member) => member.$ref === undefined)
    .flatMap((member) => Object.entries(member.properties ?? {}))
  return [...own, ...extended]
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
  for (const [name, schema] of namedLinks(component)) {
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
