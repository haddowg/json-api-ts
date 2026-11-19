import { readFileSync } from 'node:fs'
import type { OpenApiDocument } from '../src/openapi'

type Json = Record<string, unknown>

/**
 * Core's field selection, cut from the contract witness of haddowg/json-api#396: the `scores`,
 * `totals`, `location` and `lines` attributes of the articles, as each attributes component writes
 * them, and the `fields[articles]` parameter whose items accept single keys of the three objects,
 * the keys of `location.geo`, and the keys of every item of `lines` and of each item's `price`. It
 * goes once the pins move to core's published 2.22 witness.
 */
const FIELD_SELECTION = JSON.parse(
  readFileSync(new URL('./field-selection.json', import.meta.url), 'utf8'),
) as { attributes: Record<string, Json>; fields: Json }

/**
 * A copy of a witness with the articles' `scores` object, `totals` map, `location` object and
 * `lines` list added after `metrics`, the way core writes them, and every `fields[articles]` parameter replaced by the
 * one accepting their single keys, stamped with generator contract 42.
 */
export function withFieldSelection(original: OpenApiDocument): OpenApiDocument {
  const doc = structuredClone(original) as Json
  ;(doc['info'] as Json)['x-generator'] = { contract: 42 }
  const schemas = (doc['components'] as Json)['schemas'] as Record<string, Json>
  for (const [component, added] of Object.entries(FIELD_SELECTION.attributes)) {
    const schema = schemas[component]!
    const properties: Json = {}
    for (const [name, property] of Object.entries(schema['properties'] as Json)) {
      properties[name] = property
      if (name === 'metrics') {
        Object.assign(properties, structuredClone(added))
      }
    }
    schema['properties'] = properties
    const required = schema['required'] as string[] | undefined
    if (component === 'ArticlesAttributes' && required !== undefined) {
      required.splice(required.indexOf('metrics') + 1, 0, ...Object.keys(added))
    }
  }
  for (const item of Object.values(doc['paths'] as Record<string, Json>)) {
    for (const op of Object.values(item) as Json[]) {
      const parameters = op['parameters'] as Json[] | undefined
      const at = parameters?.findIndex((param) => param['name'] === 'fields[articles]') ?? -1
      if (at >= 0) {
        parameters![at] = structuredClone(FIELD_SELECTION.fields)
      }
    }
  }
  return doc as OpenApiDocument
}
