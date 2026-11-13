import { describe, expect, it } from 'vitest'
import { createJsonApiMcp } from './mcp'
import type { JsonSchema, OpenApiDocument, ParameterObject } from './openapi'
import { fixture, modelOf, source } from './test-fixtures'

type Mcp = ReturnType<typeof createJsonApiMcp>

const argument = (mcp: Mcp, name: string, member: string): JsonSchema =>
  (mcp.tools.find((t) => t.name === name)!.inputSchema['properties'] as Record<string, JsonSchema>)[
    member
  ]!

const filters = (mcp: Mcp, name: string): Record<string, JsonSchema> =>
  argument(mcp, name, 'filter')['properties'] as Record<string, JsonSchema>

const sortBranches = (mcp: Mcp, name: string): JsonSchema[] =>
  (argument(mcp, name, 'sort')['items'] as JsonSchema)['anyOf'] as JsonSchema[]

/** The witness model after `edit` has changed a copy of the document. */
function edited(edit: (doc: OpenApiDocument) => void): Mcp {
  const doc = structuredClone(source('contract-witness').document)
  edit(doc)
  return createJsonApiMcp(modelOf(doc))
}

/**
 * Core's witness describes the articles' `title` sort and `custom.fields` sort family, gives its
 * `value` filter family a description and an example, and defaults the articles' `language`
 * filter and the tags' `color` and `label` filters.
 */
describe('generator contract 34 (sort and filter documentation)', () => {
  const mcp = createJsonApiMcp(fixture('contract-witness'))

  it('reads the witness', () => {
    expect(mcp.contract).toBe(38)
  })

  it('lists what each described sort key orders by on its branch, not the markdown table', () => {
    const [fixed] = sortBranches(mcp, 'articles_list')
    expect(fixed).toEqual({
      type: 'string',
      enum: ['title', '-title', 'wordCount', '-wordCount'],
      description:
        'What each sort orders by, in either direction:\n- `title`: Alphabetical by title.',
    })
    expect(JSON.stringify(argument(mcp, 'articles_list', 'sort'))).not.toContain('| Sort |')
  })

  it("adds a sort family's description to its branch", () => {
    expect(sortBranches(mcp, 'articles_list').at(-1)!['description']).toBe(
      '`custom.fields.` followed by a name matching the regular expression `[^,]+`, optionally with a leading `-`. By a custom field value.',
    )
  })

  it("gives a filter family's description and its example as the entries the tool takes", () => {
    expect(filters(mcp, 'articles_list')['value.']!['description']).toBe(
      'Matches a custom field value. Filters on keys of the form `value.<name>`, one entry per key, such as `[{"name":"cap","value":["10","20"]}]`. Leave null to apply none.',
    )
    expect(filters(mcp, 'articles_count')['value.']!['description']).toContain(
      '`[{"name":"cap","value":["10","20"]}]`',
    )
    expect(filters(mcp, 'articles_list')['meta.']!['description']).toBe(
      'Filters on keys of the form `meta.<name>`, one entry per key. Leave null to apply none.',
    )
  })

  it("splits a list family's comma-separated example and keeps a one-value family's", () => {
    const mcp = edited((doc) => {
      const filter = doc.paths!['/articles']!.get!.parameters!.find(
        (p): p is ParameterObject => 'name' in p && p.name === 'filter',
      )!
      const families = filter.schema!['x-filter-families'] as JsonSchema[]
      families[0]!['example'] = { 'value.cap': '10,20' }
      families[2]!['example'] = { 'meta.colour': 'red', 'other.key': 'x' }
    })
    const members = filters(mcp, 'articles_list')
    expect(members['value.']!['description']).toContain('`[{"name":"cap","value":["10","20"]}]`')
    expect(members['meta.']!['description']).toContain('`[{"name":"colour","value":"red"}]`')
  })

  it('states a filter default once, from its schema, on the read and the list filter', () => {
    expect(filters(mcp, 'articles_list')['language']!['description']).toBe(
      'Filter the collection by `language`. Defaults to "en".',
    )
    const tags = filters(mcp, 'tags_list')
    expect(tags['color']!['description']).toBe(
      'Filter the collection by `color`. Defaults to "blue".',
    )
    expect(tags['label']!['description']).toBe(
      'Filter the collection by `label`. Defaults to ["php","json"].',
    )
  })

  it('leaves out a default the relation drops', () => {
    expect(filters(mcp, 'articles_tags_list')['color']!['description']).toBe(
      'Filter the collection by `color`.',
    )
  })

  it('says a filter left null still takes its default when any filter has one', () => {
    expect(argument(mcp, 'tags_list', 'filter')['description']).toBe(
      'Filters to apply. Leaving a filter null sends nothing for it, and leaving the whole object null sends none. A filter with a default then applies its default.',
    )
    expect(argument(mcp, 'articles_tags_list', 'filter')['description']).toBe(
      'Filters to apply. Leave a filter null to not apply it, or the whole object null for none.',
    )
  })
})
