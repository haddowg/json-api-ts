import { Component, signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { JsonApiError, StructuralGuardError } from '@haddowg/json-api-client'
import type { ReadError } from '@haddowg/json-api-query'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { AdminErrorCode } from '../test-api'
import { asJsonApiError, JsonApiErrorPipe } from './error'

const conflict = (): JsonApiError<AdminErrorCode> =>
  new JsonApiError<AdminErrorCode>(409, [
    {
      status: '409',
      code: 'ACCESS_DENIED',
      detail: 'Taken',
      source: { pointer: '/data/attributes/name' },
    },
  ])

describe('asJsonApiError', () => {
  it('returns a JsonApiError and nothing else', () => {
    const error = conflict()
    expect(asJsonApiError(error)).toBe(error)
    expect(asJsonApiError(new StructuralGuardError('not a document'))).toBeUndefined()
    expect(asJsonApiError(new Error('offline'))).toBeUndefined()
    expect(asJsonApiError(null)).toBeUndefined()
    expect(asJsonApiError(undefined)).toBeUndefined()
    expect(asJsonApiError('nope')).toBeUndefined()
  })

  it("keeps a typed read's error codes, and otherwise takes them as given", () => {
    expectTypeOf(asJsonApiError(null as ReadError<AdminErrorCode> | null)).toEqualTypeOf<
      JsonApiError<AdminErrorCode> | undefined
    >()
    // The test client registers no error codes, so the default is `string`.
    expectTypeOf(asJsonApiError(null as unknown)).toEqualTypeOf<JsonApiError<string> | undefined>()
    expectTypeOf(asJsonApiError<AdminErrorCode>(null as unknown)).toEqualTypeOf<
      JsonApiError<AdminErrorCode> | undefined
    >()
  })
})

describe('JsonApiErrorPipe', () => {
  it('narrows an error in a template', async () => {
    const error = signal<unknown>(null)
    const Host = Component({
      selector: 'host-cmp',
      imports: [JsonApiErrorPipe],
      template: `@if (error() | jsonApiError; as e) {<p>{{ e.status }} {{ e.byPath()['/data/attributes/name']?.[0]?.detail }}</p>} @else {<p>none</p>}`,
    })(
      class {
        readonly error = error
      },
    )
    const fixture = TestBed.createComponent(Host)
    await fixture.whenStable()
    expect(fixture.nativeElement.textContent.trim()).toBe('none')

    error.set(conflict())
    await fixture.whenStable()
    expect(fixture.nativeElement.textContent.trim()).toBe('409 Taken')

    error.set(new Error('offline'))
    await fixture.whenStable()
    expect(fixture.nativeElement.textContent.trim()).toBe('none')
  })

  it('types the transform as asJsonApiError does', () => {
    const pipe = new JsonApiErrorPipe()
    expectTypeOf(pipe.transform(null as ReadError<AdminErrorCode> | null)).toEqualTypeOf<
      JsonApiError<AdminErrorCode> | undefined
    >()
    expectTypeOf(pipe.transform(null as unknown)).toEqualTypeOf<JsonApiError<string> | undefined>()
  })
})
