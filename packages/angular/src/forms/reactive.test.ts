import { Component } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { FormArray, FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms'
import { fieldErrors, JsonApiError } from '@haddowg/json-api-client'
import {
  type FieldTypeConfig,
  FieldType,
  type FormlyFieldConfig,
  FormlyModule,
} from '@ngx-formly/core'
import { describe, expect, it } from 'vitest'
import { applyServerErrors } from './reactive'

const albumForm = () =>
  new FormGroup({
    title: new FormControl(''),
    releaseInfo: new FormGroup({ label: new FormControl('') }),
    orderedTracks: new FormArray([
      new FormGroup({ $pivot: new FormGroup({ position: new FormControl(1) }) }),
    ]),
  })

const unprocessable = new JsonApiError(422, [
  { detail: 'must not be blank', path: 'title' },
  { detail: 'is too long', path: 'title' },
  { detail: 'unknown label', path: 'releaseInfo.label' },
  { detail: 'must be positive', path: 'orderedTracks[0].$pivot.position' },
  { detail: 'no such field', path: 'subtitle' },
  { detail: 'quota exceeded', source: { header: 'X-Quota' } },
])

describe('applyServerErrors', () => {
  it('puts the first message on the control each path names, and marks it touched', () => {
    const form = albumForm()
    applyServerErrors(form, fieldErrors(unprocessable))

    expect(form.get('title')?.errors).toEqual({ server: 'must not be blank' })
    expect(form.get('title')?.touched).toBe(true)
    expect(form.get(['releaseInfo', 'label'])?.errors).toEqual({ server: 'unknown label' })
    expect(form.get(['orderedTracks', 0, '$pivot', 'position'])?.errors).toEqual({
      server: 'must be positive',
    })
  })

  it('puts the rest on the form and returns them', () => {
    const form = albumForm()
    const unplaced = applyServerErrors(form, fieldErrors(unprocessable))

    expect(unplaced.map((issue) => issue.message)).toEqual(['quota exceeded', 'no such field'])
    expect(form.errors).toEqual({ server: 'quota exceeded' })
  })

  it('keeps the control’s own errors, and the next validation clears the server one', () => {
    const form = albumForm()
    const title = form.controls.title
    title.setErrors({ required: true })
    applyServerErrors(form, fieldErrors(unprocessable))
    expect(title.errors).toEqual({ required: true, server: 'must not be blank' })

    title.setValue('OK Computer')
    expect(title.errors).toBeNull()
  })

  it('does nothing for an error that is not about the form', () => {
    const form = albumForm()
    expect(applyServerErrors(form, fieldErrors(new JsonApiError(500, [])))).toEqual([])
    expect(form.errors).toBeNull()
  })
})

describe('with Formly', () => {
  it('shows a server error through a registered `server` validation message', async () => {
    const form = new FormGroup({})
    const fields: FormlyFieldConfig[] = [{ key: 'title', type: 'input' }]
    const Host = Component({
      selector: 'test-host',
      imports: [ReactiveFormsModule, FormlyModule],
      template: `<form [formGroup]="form"><formly-form [form]="form" [fields]="fields" [model]="{}" /></form>`,
    })(
      class {
        form = form
        fields = fields
      },
    )
    const Input = Component({
      selector: 'test-input',
      imports: [ReactiveFormsModule, FormlyModule],
      template: `<input [formControl]="formControl" />
        @if (field.formControl?.invalid) {
          <p class="error"><formly-validation-message [field]="field" /></p>
        }`,
    })(class extends FieldType<FieldTypeConfig> {})

    TestBed.configureTestingModule({
      imports: [
        Host,
        // The one line the recipe adds: Formly shows a `server` error's value as its message.
        FormlyModule.forRoot({
          types: [{ name: 'input', component: Input }],
          validationMessages: [{ name: 'server', message: (error: unknown) => String(error) }],
        }),
      ],
    })
    const fixture = TestBed.createComponent(Host)
    fixture.detectChanges()
    await fixture.whenStable()

    applyServerErrors(
      form,
      fieldErrors(new JsonApiError(422, [{ detail: 'must not be blank', path: 'title' }])),
    )
    fixture.detectChanges()

    expect(form.get('title')?.errors).toEqual({ server: 'must not be blank' })
    expect(fixture.nativeElement.querySelector('.error')?.textContent).toContain(
      'must not be blank',
    )
  })
})
