import { filterParamKey } from './build-descriptor'
import type { OpenApiDocument, OperationObject, SchemaObject, SchemaOrBool } from './openapi'

/** The sentence the server appends to a deprecated operation's description when it has a sunset. */
const SUNSET = /\s*This operation may stop responding on or after (\S+), its sunset date\.\s*$/

function isSchema(value: SchemaOrBool | undefined): value is SchemaObject {
  return typeof value === 'object' && value !== null
}

/** Inline code joined into prose: `a`, `b` and `c`. */
export function codeList(values: readonly string[]): string {
  const quoted = values.map((value) => `\`${value}\``)
  return quoted.length === 1
    ? quoted[0]!
    : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)!}`
}

/** A description without the sunset sentence the server appends, and the date it names. */
export function splitSunset(description: string | undefined): {
  description: string | undefined
  sunset: string | undefined
} {
  const match = description === undefined ? null : SUNSET.exec(description)
  if (match === null) {
    return { description, sunset: undefined }
  }
  return { description: description!.slice(0, match.index), sunset: match[1] }
}

/** The sunset date of an operation's description, when the server appended one. */
function sunsetOf(op: OperationObject | undefined): string | undefined {
  return splitSunset(op?.description).sunset
}

/** A `@deprecated` tag, naming the sunset date when there is one. */
function deprecatedTag(sunset: string | undefined): string {
  return sunset === undefined
    ? '@deprecated'
    : `@deprecated It may stop responding on or after ${sunset}.`
}

/**
 * The deprecation markers of a document, read per type. Operations are found by the operationIds
 * the projector stamps (`fetchOne.articles`, `fetchRelated.articles.author`,
 * `action.articles.retract`). Every reader returns `undefined` when nothing is marked, so a
 * document without markers emits what it did before.
 */
export class Deprecations {
  private readonly byType = new Map<string, Map<string, OperationObject>>()

  constructor(
    doc: OpenApiDocument,
    private readonly schemas: Record<string, SchemaObject>,
    private readonly baseByType: ReadonlyMap<string, string>,
  ) {
    for (const item of Object.values(doc.paths ?? {})) {
      for (const op of Object.values(item) as (OperationObject | undefined)[]) {
        const id = op?.operationId
        if (typeof id !== 'string') {
          continue
        }
        const [kind, type, ...rest] = id.split('.')
        if (type === undefined || kind === 'atomic') {
          continue
        }
        let ops = this.byType.get(type)
        if (ops === undefined) {
          ops = new Map()
          this.byType.set(type, ops)
        }
        ops.set([kind, ...rest].join('.'), op!)
      }
    }
  }

  /** `@deprecated` for a type whose every operation, actions included, is deprecated. */
  type(type: string): string | undefined {
    const ops = [...(this.byType.get(type)?.values() ?? [])]
    if (ops.length === 0 || ops.some((op) => op.deprecated !== true)) {
      return undefined
    }
    return deprecatedTag(sunsetOf(ops[0]))
  }

  /** `@deprecated` for one of a type's operations, keyed by its operationId without the type. */
  operation(type: string, name: string): string | undefined {
    return this.tag(this.byType.get(type)?.get(name))
  }

  /** `@deprecated` for a deprecated operation, naming its sunset date when it has one. */
  tag(op: OperationObject | undefined): string | undefined {
    return op?.deprecated === true ? deprecatedTag(sunsetOf(op)) : undefined
  }

  /**
   * What a relation's JSDoc says about deprecation: `@deprecated` when its property is marked in
   * the read resource or a write request, or when every endpoint it has is deprecated; otherwise
   * a sentence naming the endpoints that are.
   */
  relation(type: string, relation: string, operations: readonly string[]): string | undefined {
    const ops = this.byType.get(type)
    const endpoints = operations.flatMap((operation) => {
      const op = ops?.get(`${operation}.${relation}`)
      return op === undefined ? [] : [[operation, op] as const]
    })
    const deprecated = endpoints.filter(([, op]) => op.deprecated === true)
    if (this.relationMarked(type, relation)) {
      return deprecatedTag(undefined)
    }
    if (deprecated.length === 0) {
      return undefined
    }
    const sunset = sunsetOf(deprecated[0]![1])
    if (deprecated.length === endpoints.length) {
      return deprecatedTag(sunset)
    }
    const names = deprecated.map(([operation]) => operation)
    const sentence = `The ${codeList(names)} ${names.length === 1 ? 'endpoint is' : 'endpoints are'} deprecated.`
    return sunset === undefined
      ? sentence
      : `${sentence} ${names.length === 1 ? 'It' : 'They'} may stop responding on or after ${sunset}.`
  }

  private relationMarked(type: string, relation: string): boolean {
    const base = this.baseByType.get(type)
    if (base === undefined) {
      return false
    }
    const resource = this.schemas[`${base}Resource`]
    const sources = [
      resource?.properties?.['relationships'],
      ...['CreateRequest', 'UpdateRequest'].map((suffix) => {
        const data = this.schemas[`${base}${suffix}`]?.properties?.['data']
        return isSchema(data) ? data.properties?.['relationships'] : undefined
      }),
    ]
    return sources.some((source) => {
      const property = isSchema(source) ? source.properties?.[relation] : undefined
      return isSchema(property) && property['deprecated'] === true
    })
  }

  /** The sentence naming a type's deprecated filters, read off its collection read. */
  filters(type: string): string | undefined {
    return this.operationFilters(this.collection(type))
  }

  /** The sentence naming the deprecated `filter[...]` parameters of an operation. */
  operationFilters(op: OperationObject | undefined): string | undefined {
    const keys = [
      ...new Set(
        (op?.parameters ?? []).flatMap((param) => {
          const key = param.deprecated === true ? filterParamKey(param) : undefined
          return key === undefined ? [] : [key]
        }),
      ),
    ]
    // oxlint-disable-next-line no-array-sort -- sorting a freshly-built array, as `filterable` is
    keys.sort()
    return keys.length === 0
      ? undefined
      : `The server marks the ${codeList(keys)} ${keys.length === 1 ? 'filter' : 'filters'} deprecated.`
  }

  /** The sentence naming a type's deprecated fixed sort keys. */
  sorts(type: string): string | undefined {
    const listed = this.sortSchema(type)?.['x-deprecated-sorts']
    const keys = Array.isArray(listed)
      ? listed.filter((key): key is string => typeof key === 'string')
      : []
    return keys.length === 0
      ? undefined
      : `The server marks the ${codeList(keys)} ${keys.length === 1 ? 'sort' : 'sorts'} deprecated, in either direction.`
  }

  /** The sentence naming the deprecated filter families of an operation, by prefix. */
  operationFilterFamilies(op: OperationObject | undefined): string | undefined {
    const schema = op?.parameters?.find((param) => param.name === 'filter')?.schema
    const families = schema?.['x-filter-families']
    const prefixes = (Array.isArray(families) ? families : []).flatMap((family) =>
      family.deprecated === true && typeof family.prefix === 'string' ? [family.prefix] : [],
    )
    return prefixes.length === 0
      ? undefined
      : `The server marks the ${codeList(prefixes)} filter ${prefixes.length === 1 ? 'family' : 'families'} deprecated.`
  }

  /** The sentence naming a type's deprecated filter families, by prefix. */
  filterFamilies(type: string): string | undefined {
    return this.operationFilterFamilies(this.collection(type))
  }

  /** The sentence naming a type's deprecated sort families, by prefix. */
  sortFamilies(type: string): string | undefined {
    const families = this.sortSchema(type)?.['x-sort-families']
    const prefixes = (Array.isArray(families) ? families : []).flatMap((family) =>
      family.deprecated === true && typeof family.prefix === 'string' ? [family.prefix] : [],
    )
    return prefixes.length === 0
      ? undefined
      : `The server marks the ${codeList(prefixes)} sort ${prefixes.length === 1 ? 'family' : 'families'} deprecated.`
  }

  private collection(type: string): OperationObject | undefined {
    return this.byType.get(type)?.get('fetchCollection')
  }

  private sortSchema(type: string): SchemaObject | undefined {
    return this.collection(type)?.parameters?.find((param) => param.name === 'sort')?.schema
  }
}
