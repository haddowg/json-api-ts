/**
 * The keys a sparse fieldset selected of each attribute it narrowed, under the Field Selection
 * profile (https://haddowg.github.io/json-api/profiles/field-selection/): attribute name -> the
 * paths `fields[type]=<attribute>.<path>` named, in request order, each once. A path into a nested
 * object, such as `geo.lat`, names one key per level, and a path through a list names its items
 * `*`, such as `*.sku`. An attribute the fieldset also lists whole
 * is left out, and so is a path whose key the fieldset also lists whole, since the server renders
 * those whole. A path ending in `*` names the list itself, so `lines.*` lists `lines` whole and
 * `shipping.parcels.*` selects `parcels` whole. Empty when nothing was narrowed.
 */
export type KeySelection = Readonly<Record<string, readonly string[]>>

const NONE: KeySelection = Object.freeze({})

/**
 * The {@link KeySelection} of one type's `fields[type]` members. The path is everything after the
 * first full stop, as the server reads it, and a member with an empty key at any level selects
 * nothing.
 */
export function keySelection(listed: readonly string[] | undefined): KeySelection {
  if (listed === undefined) {
    return NONE
  }
  const members = listed.map(listItself)
  const whole = new Set(members.filter((member) => !member.includes('.')))
  const out: Record<string, string[]> = {}
  for (const member of members) {
    const dot = member.indexOf('.')
    if (dot <= 0) {
      continue
    }
    const attribute = member.slice(0, dot)
    if (whole.has(attribute)) {
      continue
    }
    const path = member.slice(dot + 1)
    if (path.split('.').includes('')) {
      continue
    }
    const paths = (out[attribute] ??= [])
    if (!paths.includes(path)) {
      paths.push(path)
    }
  }
  for (const [attribute, paths] of Object.entries(out)) {
    out[attribute] = paths.filter(
      (path) => !paths.some((other) => other !== path && path.startsWith(`${other}.`)),
    )
  }
  return Object.keys(out).length === 0 ? NONE : out
}

/** A member ending in `.*` with the wildcard dropped, since it names the list itself. */
function listItself(member: string): string {
  let out = member
  while (out.endsWith('.*')) {
    out = out.slice(0, -2)
  }
  return out
}

/**
 * The `fields[type]` members a request URL carries, by type, for a link the client follows as
 * given, such as a `next` page, whose query it didn't build.
 */
export function fieldsOfUrl(url: string): Record<string, string[]> | undefined {
  let params: URLSearchParams
  try {
    params = new URL(url, 'http://link.invalid').searchParams
  } catch {
    return undefined
  }
  let out: Record<string, string[]> | undefined
  params.forEach((value, name) => {
    const type = /^fields\[(.+)\]$/.exec(name)?.[1]
    if (type !== undefined) {
      ;(out ??= {})[type] = value === '' ? [] : value.split(',')
    }
  })
  return out
}
