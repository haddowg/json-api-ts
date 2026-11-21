import { provideHttpClient, withInterceptors } from '@angular/common/http'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { App } from './app'
import { API_URL, apiProviders } from './app.config'
import { mockBackendInterceptor } from './mock-backend'
import { RequestTracker, trackRequestsInterceptor } from './request-tracker'

// Render smokes: the real components, the real client and TanStack Query bindings, and the app's
// own interceptor in front of the in-memory mock server. The mock answers after a short delay, so
// a request can be seen in flight, superseded, or waiting on its write.
//
// The docs cite each `describe` block by name.

const LATENCY_MS = 60

const wait = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Type into an input the way a user does, so its `(input)` listener runs. */
const type = (input: HTMLInputElement, value: string): void => {
  input.value = value
  input.dispatchEvent(new Event('input'))
}

/** Submit the form an input belongs to. */
const submit = (input: HTMLInputElement): void => {
  input.form?.dispatchEvent(new Event('submit', { cancelable: true }))
}

function mount() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(
        withInterceptors([trackRequestsInterceptor, mockBackendInterceptor(API_URL, LATENCY_MS)]),
      ),
      ...apiProviders,
    ],
  })
  const fixture = TestBed.createComponent(App)
  const root: HTMLElement = fixture.nativeElement
  const tracker = TestBed.inject(RequestTracker)

  /** Let the pending effects and promises run, then render what they changed. */
  const flush = async (): Promise<void> => {
    fixture.detectChanges()
    await wait()
    fixture.detectChanges()
  }
  /** Retry `check` until it passes, rendering between attempts. */
  const until = (check: () => void): Promise<void> =>
    vi.waitFor(
      () => {
        fixture.detectChanges()
        check()
      },
      { timeout: 3000, interval: 10 },
    )

  const rows = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('ul li')]
  const rowTitles = (): (string | null)[] =>
    rows().map((row) => row.querySelector('button')?.textContent ?? null)
  const field = (label: string): HTMLInputElement => {
    const input = root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
    if (input === null) {
      throw new Error(`No input labelled "${label}"`)
    }
    return input
  }
  const select = (title: string): void => {
    const button = [...root.querySelectorAll('li button')].find((b) => b.textContent === title)
    ;(button as HTMLButtonElement).click()
  }
  const detail = (): HTMLElement | null => root.querySelector('section')

  return {
    fixture,
    root,
    tracker,
    flush,
    until,
    rows,
    rowTitles,
    field,
    select,
    detail,
  }
}

describe('reading the catalog', () => {
  it('renders the first page of albums with their artists, and the signed-in account', async () => {
    const app = mount()
    app.fixture.detectChanges()

    await app.until(() => expect(app.rows()).toHaveLength(5))
    expect(app.rowTitles()).toEqual(['Blue Lines', 'Dummy', 'Geogaddi', 'Homogenic', 'In Rainbows'])
    // The artist rides the same request through `include`, the year comes from a DatePipe.
    expect(app.rows()[0]?.textContent).toContain('Massive Attack, 1991')
    // The page position and the declared collection meta are typed members of the result.
    expect(app.root.textContent).toContain('Page 1')
    expect(app.root.textContent).toContain('1 explicit on this page')

    await app.until(() => expect(app.root.textContent).toContain('Signed in as Ada'))
  })

  it('loads the detail of the album that is picked, and nothing before', async () => {
    const app = mount()
    await app.until(() => expect(app.rows()).toHaveLength(5))
    const sentBeforePick = app.tracker.sent()
    expect(app.detail()).toBeNull()

    app.select('Blue Lines')

    await app.until(() => expect(app.detail()?.querySelector('h2')?.textContent).toBe('Blue Lines'))
    expect(app.detail()?.textContent).toContain('by Massive Attack')
    expect(app.tracker.sent()).toBe(sentBeforePick + 1)
  })

  it('pages with the links the server answered', async () => {
    const app = mount()
    await app.until(() => expect(app.rows()).toHaveLength(5))

    const next = [...app.root.querySelectorAll('nav button')].find(
      (b) => b.textContent === 'Next',
    ) as HTMLButtonElement
    next.click()

    // The first page stays on screen until the second arrives.
    await app.flush()
    expect(app.rowTitles()[0]).toBe('Blue Lines')
    await app.until(() => expect(app.root.textContent).toContain('Page 2'))
    expect(app.rowTitles()).toEqual([
      'Kid A',
      'Mezzanine',
      'Music Has the Right to Children',
      'OK Computer',
      'Portishead',
    ])
  })
})

describe('filtering cancels the request it supersedes', () => {
  it('aborts the read in flight and renders the results of the new filter', async () => {
    const app = mount()
    await app.until(() => expect(app.rows()).toHaveLength(5))
    await app.until(() => expect(app.tracker.inFlight()).toBe(0))
    expect(app.tracker.cancelled()).toBe(0)

    const search = app.root.querySelector<HTMLInputElement>('input[type="search"]')!
    type(search, 'o')
    await app.flush()
    expect(app.tracker.inFlight()).toBe(1)
    // The previous page stays on screen while the new one loads.
    expect(app.rowTitles()).toContain('Blue Lines')
    expect(app.root.querySelector('ul')?.getAttribute('aria-busy')).toBe('true')

    type(search, 'ok')
    await app.flush()
    // The first filter's request was abandoned, and the tracker saw it end without a response.
    expect(app.tracker.cancelled()).toBe(1)

    await app.until(() => expect(app.rowTitles()).toEqual(['OK Computer']))
    expect(app.root.querySelector('ul')?.getAttribute('aria-busy')).toBe('false')
    expect(app.tracker.cancelled()).toBe(1)
  })
})

describe('renaming an album optimistically', () => {
  it('shows the new title at once, then the server’s, without refetching the list', async () => {
    const app = mount()
    await app.until(() => expect(app.rows()).toHaveLength(5))
    app.select('Blue Lines')
    await app.until(() => expect(app.detail()?.querySelector('h2')?.textContent).toBe('Blue Lines'))
    await app.until(() => expect(app.tracker.inFlight()).toBe(0))
    const sent = app.tracker.sent()

    // The mock server collapses repeated spaces, so what it answers with differs from what was sent.
    type(app.field('Title'), 'Blue  Lines II')
    submit(app.field('Title'))
    await app.flush()

    // Before the server has answered, the list row and the detail already show the new title,
    // and the row is marked while the write is pending.
    expect(app.tracker.inFlight()).toBe(1)
    expect(app.rowTitles()[0]).toBe('Blue  Lines II')
    expect(app.detail()?.querySelector('h2')?.textContent).toBe('Blue  Lines II')
    expect(app.rows()[0]?.classList).toContain('pending')
    expect(app.rows()[1]?.classList).not.toContain('pending')

    // The server's answer replaces the guess in both places and clears the mark.
    await app.until(() => expect(app.detail()?.textContent).toContain('Saved as "Blue Lines II"'))
    expect(app.rowTitles()[0]).toBe('Blue Lines II')
    expect(app.detail()?.querySelector('h2')?.textContent).toBe('Blue Lines II')
    expect(app.rows()[0]?.classList).not.toContain('pending')
    // One request for the write, and none to read the list or the album again.
    await wait(LATENCY_MS * 2)
    expect(app.tracker.sent()).toBe(sent + 1)
  })

  it('rolls back a refused write and shows its error through the pipe', async () => {
    const app = mount()
    await app.until(() => expect(app.rows()).toHaveLength(5))
    app.select('Blue Lines')
    await app.until(() => expect(app.detail()?.querySelector('h2')?.textContent).toBe('Blue Lines'))

    // The mock server answers a blank title with a 422 pointing at the title.
    type(app.field('Title'), '   ')
    submit(app.field('Title'))
    await app.flush()
    expect(app.rowTitles()[0]).toBe('   ')
    expect(app.rows()[0]?.classList).toContain('pending')

    await app.until(() =>
      expect(app.detail()?.querySelector('.error')?.textContent).toBe(
        'This value should not be blank.',
      ),
    )
    expect(app.rowTitles()[0]).toBe('Blue Lines')
    expect(app.detail()?.querySelector('h2')?.textContent).toBe('Blue Lines')
    expect(app.rows()[0]?.classList).not.toContain('pending')
  })
})

describe('the account singleton', () => {
  it('renames through the id the read returned and patches the header without a refetch', async () => {
    const app = mount()
    await app.until(() => expect(app.root.textContent).toContain('Signed in as Ada'))
    await app.until(() => expect(app.tracker.inFlight()).toBe(0))
    const sent = app.tracker.sent()

    type(app.field('Display name'), 'Ada Lovelace')
    submit(app.field('Display name'))

    await app.until(() => expect(app.root.textContent).toContain('Signed in as Ada Lovelace'))
    await wait(LATENCY_MS * 2)
    expect(app.tracker.sent()).toBe(sent + 1)
  })
})
