import type { FilterFamilyDescriptor } from './descriptor'

/** The filter vocabulary {@link listFilterMatcher} reads: a type's, or a collection action's. */
export interface FilterSpec {
  filterable?: readonly string[]
  listFilters?: readonly string[]
  filterFamilies?: readonly FilterFamilyDescriptor[]
}

/**
 * Whether a `filter[...]` key takes a list, by the rule the server matches keys with: an exact
 * key first, then the filter family with the longest prefix whose suffix pattern accepts the rest
 * of the key. A family never matches its bare prefix. `undefined` when nothing in `spec` takes a
 * list, so every filter value is sent as before.
 */
export function listFilterMatcher(
  spec: FilterSpec | undefined,
): ((key: string) => boolean) | undefined {
  const lists = new Set(spec?.listFilters ?? [])
  const families = (spec?.filterFamilies ?? []).filter((family) => family.list === true)
  if (lists.size === 0 && families.length === 0) {
    return undefined
  }
  const exact = new Set(spec?.filterable ?? [])
  // oxlint-disable-next-line no-array-sort -- sorting a freshly-copied array
  const byLength = [...(spec?.filterFamilies ?? [])].sort(
    (a, b) => b.prefix.length - a.prefix.length,
  )
  return (key) => {
    if (lists.has(key)) {
      return true
    }
    if (exact.has(key)) {
      return false
    }
    for (const family of byLength) {
      const prefix = `${family.prefix}.`
      if (!key.startsWith(prefix)) {
        continue
      }
      const suffix = key.slice(prefix.length)
      if (suffix !== '' && new RegExp(`^(?:${family.suffixPattern})$`, 'u').test(suffix)) {
        return family.list === true
      }
    }
    return false
  }
}
