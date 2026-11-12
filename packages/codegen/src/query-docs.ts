import { filterParamKey } from './build-descriptor'
import type { OperationObject, SchemaObject } from './openapi'

function paramSchema(op: OperationObject | undefined, name: string): SchemaObject | undefined {
  return op?.parameters?.find((param) => param.in === 'query' && param.name === name)?.schema
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A value as inline code, strings quoted, so `"en"` and `["php","json"]` read as JSON. */
function code(value: unknown): string {
  return `\`${JSON.stringify(value)}\``
}

/**
 * What the sorts of an operation's `sort` parameter order by, from its `x-sort-descriptions`: one
 * line per described key, either direction. `undefined` when it describes none.
 */
export function sortKeysDoc(op: OperationObject | undefined): string | undefined {
  const described = paramSchema(op, 'sort')?.['x-sort-descriptions']
  if (!isRecord(described)) {
    return undefined
  }
  const lines = Object.entries(described).flatMap(([key, text]) =>
    typeof text === 'string' && text.trim() !== '' ? [`- \`${key}\`: ${text.trim()}`] : [],
  )
  return lines.length === 0
    ? undefined
    : `What each sort orders by, in either direction:\n${lines.join('\n')}`
}

/** The description of each sort family of an operation's `sort` parameter, by prefix. */
export function sortFamilyDocs(op: OperationObject | undefined): Map<string, string> {
  const out = new Map<string, string>()
  const families = paramSchema(op, 'sort')?.['x-sort-families']
  for (const family of Array.isArray(families) ? families : []) {
    const { prefix, description } = family as Record<string, unknown>
    if (typeof prefix === 'string' && typeof description === 'string' && description.trim()) {
      out.set(prefix, description.trim())
    }
  }
  return out
}

/**
 * The JSDoc of each filter family of an operation's `filter` parameter, by prefix: its
 * description, then its example key and value as an `@example`.
 */
export function filterFamilyDocs(op: OperationObject | undefined): Map<string, string> {
  const out = new Map<string, string>()
  const families = paramSchema(op, 'filter')?.['x-filter-families']
  for (const family of Array.isArray(families) ? families : []) {
    const { prefix, description, example } = family as Record<string, unknown>
    if (typeof prefix !== 'string') {
      continue
    }
    const parts: string[] = []
    if (typeof description === 'string' && description.trim() !== '') {
      parts.push(description.trim())
    }
    if (isRecord(example) && Object.keys(example).length > 0) {
      parts.push(`@example ${JSON.stringify(example)}`)
    }
    if (parts.length > 0) {
      out.set(prefix, parts.join('\n\n'))
    }
  }
  return out
}

/**
 * The defaults the server applies to an operation's filters when a read doesn't send them, read
 * from the `default` of each `filter[<key>]` parameter's schema, one sentence per key in key
 * order. A list filter shows its default on both its forms, so each key is named once.
 */
export function filterDefaultsDoc(op: OperationObject | undefined): string | undefined {
  const defaults = new Map<string, unknown>()
  for (const param of op?.parameters ?? []) {
    const key = filterParamKey(param)
    const schema = param.schema
    if (key !== undefined && schema !== undefined && 'default' in schema && !defaults.has(key)) {
      defaults.set(key, schema['default'])
    }
  }
  const keys = [...defaults.keys()]
  // oxlint-disable-next-line no-array-sort -- sorting a freshly-built array, as `filterable` is
  keys.sort()
  return keys.length === 0
    ? undefined
    : keys.map((key) => `The \`${key}\` filter defaults to ${code(defaults.get(key))}.`).join('\n')
}
