import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildDescriptor } from './build-descriptor'
import { checkContract } from './contract'
import { emit } from './emit'
import type { OpenApiDocument } from './openapi'
import { documentPath } from '../test/documents'

const witness = JSON.parse(
  readFileSync(documentPath('contract-witness.json'), 'utf8'),
) as OpenApiDocument
const source = emit(witness, buildDescriptor(witness))

/**
 * Core's witness describes the articles' `title` sort and its `custom.fields` sort family, gives
 * its `value` filter family a description and an example, and defaults the articles' `language`
 * filter and the tags' `color` filter and `label` list filter.
 */
describe('generator contract 34 (sort and filter documentation)', () => {
  it('reads the witness without a warning', () => {
    expect(witness.info?.['x-generator']?.contract).toBe(35)
    expect(checkContract(witness)).toBeUndefined()
  })

  it('lists what each described sort orders by on the sortable keys', () => {
    expect(source).toContain(
      [
        '    /**',
        '     * What each sort orders by, in either direction:',
        '     * - `title`: Alphabetical by title.',
        '     *',
        '     * The server marks the `length` sort deprecated, in either direction.',
        '     */',
        '    sortable: [',
      ].join('\n'),
    )
  })

  it('documents a described sort family on its own entry', () => {
    expect(source).toContain(
      '      /** By a custom field value. */\n      {\n        prefix: "custom.fields",',
    )
    // The `meta` family has no description, so its entry carries no comment.
    expect(source).toContain('      },\n      {\n        prefix: "meta",')
  })

  it("documents a filter family's description and example on its entry, for a read and an action", () => {
    const entry = [
      '/**',
      ' * Matches a custom field value.',
      ' *',
      ' * @example {"value.cap":["10","20"]}',
      ' */',
      '{',
      '  prefix: "value",',
    ]
    const at = (indent: string) => entry.map((line) => `${indent}${line}`).join('\n')
    expect(source).toContain(at('      '))
    expect(source).toContain(at('          '))
  })

  it('names the default of each filter that has one, a list filter once', () => {
    expect(source).toContain(
      '    /**\n     * The `language` filter defaults to `"en"`.\n     *\n     * The server marks the `state` filter deprecated.\n     */\n    filterable: [',
    )
    expect(source).toContain(
      [
        '    /**',
        '     * The `color` filter defaults to `"blue"`.',
        '     * The `label` filter defaults to `["php","json"]`.',
        '     */',
        '    filterable: [',
      ].join('\n'),
    )
  })

  it('reads a field example from the OAS 3.1 examples keyword', () => {
    expect(source).toContain('   * @example example-slug\n')
  })
})

describe('sort and filter documentation on a relation that records its own', () => {
  // The witness's `articles.sponsors` is polymorphic, so the relation records the sorts and
  // filters of its own reads. Describe a sort and default its filter on its related read.
  const doc = structuredClone(witness)
  const params = doc.paths!['/articles/{id}/sponsors']!.get!.parameters!
  const sort = params.find((param) => param.name === 'sort')!.schema!
  sort['x-sort-descriptions'] = { rank: 'Where the sponsor ranks.' }
  params.find((param) => param.name === 'filter[minRank]')!.schema!['default'] = 2
  const out = emit(doc, buildDescriptor(doc))
  const sponsors = out.slice(out.indexOf('      sponsors: {'))

  it('documents the sorts and the defaults the relation records', () => {
    expect(sponsors).toContain(
      '        /**\n         * What each sort orders by, in either direction:\n         * - `rank`: Where the sponsor ranks.\n         */\n        sortable: [',
    )
    expect(sponsors).toContain(
      '        /** The `minRank` filter defaults to `2`. */\n        filterable: [',
    )
  })
})
