/**
 * The keys a sparse fieldset selected of each attribute it narrowed, under the Field Selection
 * profile (https://haddowg.github.io/json-api/profiles/field-selection/): attribute name -> the
 * keys `fields[type]=<attribute>.<key>` named, in request order, each once. An attribute the
 * fieldset also lists whole is left out, since the server renders it whole. Empty when nothing
 * was narrowed.
 */
export type KeySelection = Readonly<Record<string, readonly string[]>>

const NONE: KeySelection = Object.freeze({})

/**
 * The {@link KeySelection} of one type's `fields[type]` members. The key is everything after the
 * first full stop, as the server reads it, and a member with an empty key selects nothing.
 */
export function keySelection(members: readonly string[] | undefined): KeySelection {
  if (members === undefined) {
    return NONE
  }
  const whole = new Set(members.filter((member) => !member.includes('.')))
  const out: Record<string, string[]> = {}
  for (const member of members) {
    const dot = member.indexOf('.')
    if (dot <= 0 || dot === member.length - 1) {
      continue
    }
    const attribute = member.slice(0, dot)
    if (whole.has(attribute)) {
      continue
    }
    const keys = (out[attribute] ??= [])
    const key = member.slice(dot + 1)
    if (!keys.includes(key)) {
      keys.push(key)
    }
  }
  return Object.keys(out).length === 0 ? NONE : out
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
