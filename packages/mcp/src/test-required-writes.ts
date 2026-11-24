import type { OpenApiDocument } from './openapi'

type Node = Record<string, unknown>

const at = (node: unknown, ...keys: string[]): Node => {
  let cursor = node as Node
  for (const key of keys) {
    cursor = cursor[key] as Node
  }
  return cursor
}

const relationshipsOf = (schemas: Node, request: string): Node =>
  at(schemas, request, 'properties', 'data', 'properties', 'relationships')

const narrow = (relationships: Node, relation: string, data: Node): void => {
  const properties = at(relationships, 'properties')
  properties[relation] = { allOf: [properties[relation], { properties: { data } }] }
}

const requireMembers = (node: Node, ...members: string[]): void => {
  node['required'] = [...((node['required'] as string[] | undefined) ?? []), ...members]
}

/**
 * What core main's projector does to the pinned 2.24.0 witness, which no release has published
 * yet: `people.company` is required on create and update, `tags.articles` on create, and a create
 * must send its attributes when one is required. A write narrows the shared relationship object
 * beside its reference in an `allOf`, the reference first, and the document is stamped 46. It goes
 * once the pins move to a core release at 46.
 */
export function requiredWrites(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc)
  const schemas = at(copy, 'components', 'schemas')
  const refusesNull = { type: 'object' }

  // The baseline witness has no credits.
  for (const request of ['ArticlesCreateRequest', 'CreditsCreateRequest']) {
    if (schemas[request] !== undefined) {
      requireMembers(at(schemas, request, 'properties', 'data'), 'attributes')
    }
  }
  requireMembers(at(schemas, 'ArticlesAtomicAdd'), 'attributes')

  for (const request of ['PeopleCreateRequest', 'PeopleUpdateRequest']) {
    narrow(relationshipsOf(schemas, request), 'company', refusesNull)
  }
  requireMembers(relationshipsOf(schemas, 'PeopleCreateRequest'), 'company')
  requireMembers(
    at(schemas, 'PeopleCreateRequest', 'properties', 'data'),
    'attributes',
    'relationships',
  )
  for (const write of ['PeopleAtomicAdd', 'PeopleAtomicUpdate']) {
    const company = at(schemas, write, 'properties', 'relationships', 'properties', 'company')
    const data = at(company, 'properties', 'data')
    at(company, 'properties')['data'] = (data['anyOf'] as Node[])[0]
  }
  requireMembers(at(schemas, 'PeopleAtomicAdd', 'properties', 'relationships'), 'company')
  requireMembers(at(schemas, 'PeopleAtomicAdd'), 'attributes', 'relationships')
  const replace = at(
    copy,
    'paths',
    '/people/{id}/relationships/company',
    'patch',
    'requestBody',
    'content',
    'application/vnd.api+json',
  )
  replace['schema'] = { allOf: [replace['schema'], { properties: { data: refusesNull } }] }

  narrow(relationshipsOf(schemas, 'TagsCreateRequest'), 'articles', { minItems: 1 })
  requireMembers(relationshipsOf(schemas, 'TagsCreateRequest'), 'articles')
  requireMembers(
    at(schemas, 'TagsCreateRequest', 'properties', 'data'),
    'attributes',
    'relationships',
  )
  at(
    schemas,
    'TagsAtomicAdd',
    'properties',
    'relationships',
    'properties',
    'articles',
    'properties',
    'data',
  )['minItems'] = 1
  requireMembers(at(schemas, 'TagsAtomicAdd', 'properties', 'relationships'), 'articles')
  requireMembers(at(schemas, 'TagsAtomicAdd'), 'attributes', 'relationships')

  copy.info!['x-generator'] = { contract: 46 }
  return copy
}

/**
 * The write-only `articles.watchers` to-many with item bounds on its create and update, so both
 * bodies narrow it in an `allOf` and neither references it directly.
 */
export function boundedWriteOnly(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc)
  const schemas = at(copy, 'components', 'schemas')
  for (const request of ['ArticlesCreateRequest', 'ArticlesUpdateRequest']) {
    const relationships = relationshipsOf(schemas, request)
    const watchers = at(relationships, 'properties', 'watchers')
    const { writeOnly, ...reference } = watchers
    at(relationships, 'properties')['watchers'] = {
      allOf: [reference, { properties: { data: { minItems: 1 } } }],
      writeOnly,
    }
  }
  return copy
}
