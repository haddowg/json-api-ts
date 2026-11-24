import { Injector, signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { form, submit } from '@angular/forms/signals'
import { fieldErrors, JsonApiError } from '@haddowg/json-api-client'
import { describe, expect, it } from 'vitest'
import { serverErrors } from './index'

const unprocessable = new JsonApiError(422, [
  { detail: 'must not be blank', path: 'title' },
  { detail: 'must be positive', path: 'orderedTracks[0].$pivot.position' },
  { detail: 'no such field', path: 'subtitle' },
  { detail: 'quota exceeded', source: { header: 'X-Quota' } },
])

const albumForm = () =>
  form(
    signal({
      title: '',
      orderedTracks: [{ id: '1', $pivot: { position: 1 } }],
    }),
    { injector: TestBed.inject(Injector) },
  )

describe('serverErrors', () => {
  it('targets the field each path names, and leaves the rest on the form', () => {
    const album = albumForm()
    const errors = serverErrors(album, fieldErrors(unprocessable))

    expect(errors[0]).toEqual({
      kind: 'server',
      message: 'must not be blank',
      fieldTree: album.title,
    })
    expect(errors[1]?.fieldTree).toBe(album.orderedTracks[0]!.$pivot.position)
    expect(errors.slice(2)).toEqual([
      { kind: 'server', message: 'no such field' },
      { kind: 'server', message: 'quota exceeded' },
    ])
  })

  it('shows them on the fields when a submit action returns them', async () => {
    const album = albumForm()
    await submit(album, async () => serverErrors(album, fieldErrors(unprocessable)))

    expect(
      album
        .title()
        .errors()
        .map((e) => e.message),
    ).toEqual(['must not be blank'])
    expect(
      album.orderedTracks[0]!.$pivot.position()
        .errors()
        .map((e) => e.message),
    ).toEqual(['must be positive'])
    expect(
      album()
        .errors()
        .map((e) => e.message),
    ).toEqual(['no such field', 'quota exceeded'])
  })

  it('is empty for an error that is not about the form', () => {
    expect(serverErrors(albumForm(), fieldErrors(new Error('offline')))).toEqual([])
  })
})
