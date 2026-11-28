import { describe, expect, expectTypeOf, it } from 'vitest'
import { JsonApiError } from './errors'
import { type FieldErrors, fieldErrors, type InputPath, type WriteError } from './field-errors'

interface AlbumInput {
  title: string
  releaseInfo?: { label?: string; year?: number }
  tags?: string[]
  artist?: { type: 'artists'; id: string } | null
  orderedTracks?: readonly { type: 'tracks'; id: string; $pivot?: { position?: number } }[]
  $meta?: { source?: string }
  id?: never
}

describe('fieldErrors', () => {
  it('keys each error on the input it points at, as a Standard Schema issue', () => {
    const fe = fieldErrors(
      new JsonApiError(422, [
        {
          code: 'VALUE_TOO_SHORT',
          title: 'Invalid attribute',
          detail: 'must not be blank',
          source: { pointer: '/data/attributes/title' },
          path: 'title',
        },
        {
          title: 'Invalid attribute',
          source: { pointer: '/data/attributes/title' },
          path: 'title',
        },
        {
          detail: 'must be positive',
          source: { pointer: '/data/relationships/orderedTracks/data/0/meta/pivot/position' },
          path: 'orderedTracks[0].$pivot.position',
        },
      ]),
    )

    expect(fe?.messages('title')).toEqual(['must not be blank', 'Invalid attribute'])
    expect(fe?.first('title')).toBe('must not be blank')
    expect(fe?.first('artist')).toBeUndefined()
    expect(fe?.fields['orderedTracks[0].$pivot.position']?.[0]).toMatchObject({
      message: 'must be positive',
      path: ['orderedTracks', 0, '$pivot', 'position'],
      key: 'orderedTracks[0].$pivot.position',
    })
    expect(fe?.issues[0]).toMatchObject({ code: 'VALUE_TOO_SHORT', path: ['title'] })
    expect(fe?.form).toEqual([])
  })

  it('falls back to the code, then a fixed word, when an error has no text', () => {
    const fe = fieldErrors(
      new JsonApiError(422, [
        { code: 'REQUIRED', path: 'title' },
        { path: 'title', detail: '', title: '' },
      ]),
    )
    expect(fe?.messages('title')).toEqual(['REQUIRED', 'Invalid'])
  })

  it('puts errors that point at no input in the form group', () => {
    const fe = fieldErrors(
      new JsonApiError(409, [
        { detail: 'slug is taken', source: { pointer: '/data/attributes/slug' }, path: 'slug' },
        { detail: 'type mismatch', source: { pointer: '/data/type' }, path: '/data/type' },
        { detail: 'bad header', source: { header: 'If-Match' } },
        { detail: 'unknown filter', source: { parameter: 'filter[x]' } },
        { detail: 'no source' },
      ]),
    )

    expect(Object.keys(fe?.fields ?? {})).toEqual(['slug'])
    expect(fe?.form.map((issue) => issue.message)).toEqual([
      'type mismatch',
      'bad header',
      'unknown filter',
      'no source',
    ])
    expect(fe?.form.every((issue) => issue.path.length === 0 && issue.key === '')).toBe(true)
  })

  it('takes any 4xx whose errors point at an input', () => {
    const pointed = [{ detail: 'malformed', path: 'releaseInfo.year' }]
    expect(
      fieldErrors(new JsonApiError(400, pointed))?.fields['releaseInfo.year']?.[0]?.path,
    ).toEqual(['releaseInfo', 'year'])
    expect(fieldErrors(new JsonApiError(409, pointed))).toBeDefined()
  })

  it('is undefined for anything else', () => {
    expect(
      fieldErrors(new JsonApiError(409, [{ detail: 'type mismatch', path: '/data/type' }])),
    ).toBeUndefined()
    expect(fieldErrors(new JsonApiError(403, [{ detail: 'Forbidden' }]))).toBeUndefined()
    expect(fieldErrors(new JsonApiError(500, [{ detail: 'boom', path: 'title' }]))).toBeUndefined()
    expect(fieldErrors(new Error('network'))).toBeUndefined()
    expect(fieldErrors(undefined)).toBeUndefined()
  })

  it("narrows to one atomic operation's errors", () => {
    const fe = fieldErrors(
      new JsonApiError(422, [
        { detail: 'artist name required', path: 'name', opIndex: 0 },
        { detail: 'album title required', path: 'title', opIndex: 1 },
      ]),
    )
    expect(fe?.op(1).fields).toEqual({ title: [expect.objectContaining({ opIndex: 1 })] })
    expect(fe?.op(0).first('name')).toBe('artist name required')
  })

  describe('types', () => {
    it('takes the input from a write error, or a type argument', () => {
      const tagged = new JsonApiError(422, []) as WriteError<'REQUIRED', AlbumInput>
      expectTypeOf(fieldErrors(tagged)).toEqualTypeOf<
        FieldErrors<AlbumInput, 'REQUIRED'> | undefined
      >()
      expectTypeOf(fieldErrors<AlbumInput>(new Error() as unknown)).toEqualTypeOf<
        FieldErrors<AlbumInput, string> | undefined
      >()
      expectTypeOf(fieldErrors(new Error() as unknown)).toEqualTypeOf<
        FieldErrors<unknown, string> | undefined
      >()
    })

    it('checks paths against the input', () => {
      const fe = fieldErrors<AlbumInput>(new JsonApiError(422, [{ path: 'title' }]))!
      fe.first('title')
      fe.first('releaseInfo.label')
      fe.first('orderedTracks[2].$pivot.position')
      fe.first('$meta.source')
      fe.first('$documentMeta.idempotencyKey')
      fe.first('tags[0]')
      // @ts-expect-error not an input key
      fe.first('titel')
      // @ts-expect-error a to-one ref has no paths below it
      fe.first('artist.id')
      // @ts-expect-error a ref member exposes only its pivot
      fe.first('orderedTracks[0].id')

      // Any string when the input is unknown.
      fieldErrors(new JsonApiError(422, [{ path: 'title' }]))?.first('anything.at[0].all')
    })

    it('lists every path of an input', () => {
      expectTypeOf<InputPath<AlbumInput>>().toEqualTypeOf<
        | 'title'
        | 'releaseInfo'
        | 'releaseInfo.label'
        | 'releaseInfo.year'
        | 'tags'
        | `tags[${number}]`
        | 'artist'
        | 'orderedTracks'
        | `orderedTracks[${number}]`
        | `orderedTracks[${number}].$pivot`
        | `orderedTracks[${number}].$pivot.position`
        | '$meta'
        | '$meta.source'
        | 'id'
        | `$documentMeta.${string}`
      >()
    })

    it('takes only the keys every member of a union value has', () => {
      type Credited = {
        credits: { producer: string; mixer?: string } | { producer: string; engineer: string }
      }
      expectTypeOf<InputPath<Credited>>().toEqualTypeOf<
        'credits' | 'credits.producer' | `$documentMeta.${string}`
      >()
    })
  })
})
