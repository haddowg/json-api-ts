import { QueryClientProvider, useMutation } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { mockStore, queryClient, writes } from './api/client'
import { App } from './App'
import { PlaylistsPage } from './pages/PlaylistsPage'

/**
 * A create made elsewhere in an app without `complete`: nothing supplies the playlist's server-only
 * `slug`, which a list of whole playlists promises, so the list can only hold it as a pending entry.
 */
function QuickCreate({ title }: { title: string }) {
  const create = useMutation(writes.playlists.create({ optimistic: { into: () => 'start' } }))
  return (
    <button type="button" onClick={() => create.mutate({ title, public: true })}>
      Quick create
    </button>
  )
}

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[path]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// The mock store and the shared QueryClient are module singletons; reset both so each test starts
// from the seed (mutations persist in-session, which would otherwise leak across tests).
beforeEach(() => {
  mockStore?.reset()
  queryClient.clear()
})

/**
 * Render smokes: mount the real app against the singleton client — which, with no `VITE_API_URL`,
 * runs off the seeded in-memory mock — and assert real seed data reaches the DOM. These guard the
 * whole wiring: client -> mock transport -> handler -> store -> react-query -> materialised
 * resource -> rendered view, across a browse view, a detail view, and a mutation.
 */
describe('app smoke', () => {
  it('renders seeded albums and artists on the Browse view', async () => {
    renderAt('/')

    // The page chrome is synchronous; the data arrives after the mock transport resolves.
    expect(screen.getByRole('heading', { name: 'Browse', level: 1 })).toBeInTheDocument()

    // A seeded album hydrated with its included artist (proves include + materialise + render).
    // The artist name appears on both the album subtitle and the artist card, hence findAll.
    expect(await screen.findByText('OK Computer')).toBeInTheDocument()
    expect((await screen.findAllByText(/Radiohead/)).length).toBeGreaterThan(0)

    // A seeded artist card (proves the second, parallel query also rendered).
    expect(await screen.findByText('Portishead')).toBeInTheDocument()
  })

  it('renders an album detail with its tracklist and included artist', async () => {
    renderAt('/albums/1')

    // The album header + a track from the compound `include: [artist, tracks]` read.
    expect(
      await screen.findByRole('heading', { name: 'OK Computer', level: 1 }),
    ).toBeInTheDocument()
    expect(await screen.findByText('Airbag')).toBeInTheDocument()
    expect(await screen.findByText('Paranoid Android')).toBeInTheDocument()
    // The include renders the first two tracks; loadAll reads the third from the next page.
    expect(await screen.findByText('Exit Music (For a Film)')).toBeInTheDocument()
    // The artist link is hydrated off the included relation.
    expect(await screen.findByRole('link', { name: 'Radiohead' })).toBeInTheDocument()
  })

  it('renders an artist detail with its discography from the include', async () => {
    renderAt('/artists/1')

    // The artist header + an album from the compound `include: ['albums']` read (the artist's
    // `albums` relation is includable, so the discography rides one request).
    expect(await screen.findByRole('heading', { name: 'Radiohead', level: 1 })).toBeInTheDocument()
    expect(await screen.findByText('OK Computer')).toBeInTheDocument()
  })

  it('searches the catalogue via the shared filter[q] across types', async () => {
    renderAt('/search')

    // Typing narrows every section by the one `filter[q]` key: "comput" keeps OK Computer and
    // drops the non-matching album (Dummy).
    fireEvent.change(await screen.findByLabelText('Search the catalogue'), {
      target: { value: 'comput' },
    })

    expect(await screen.findByText('OK Computer')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByText('Dummy')).not.toBeInTheDocument()
    })
  })

  it('renders a playlist detail with ordered tracks carrying the pivot position', async () => {
    renderAt('/playlists/00000000-0000-4000-8000-000000000001')

    expect(await screen.findByRole('heading', { name: 'Late Night', level: 1 })).toBeInTheDocument()
    // The related-endpoint read renders the ordered tracks; the first edge's pivot position is 1.
    // (Scope to the tracklist — the same title also appears in the catalogue "Add tracks" picker.)
    const firstRow = await screen.findByLabelText('Move Exit Music (For a Film) up')
    const row = firstRow.closest('.track-row')
    expect(row?.textContent).toContain('Exit Music (For a Film)')
    expect(row?.textContent).toContain('1')
  })

  it('adds a track to a playlist (relationship add) — the cache reflects it optimistically', async () => {
    renderAt('/playlists/00000000-0000-4000-8000-000000000002') // Focus Beats: seeded with 2 tracks

    // Wait for the playlist + its tracklist (the seed has "Everything in Its Right Place").
    expect(
      await screen.findByRole('heading', { name: 'Focus Beats', level: 1 }),
    ).toBeInTheDocument()
    expect(await screen.findByLabelText('Remove Everything in Its Right Place')).toBeInTheDocument()

    // The catalogue picker lists "Airbag" (not yet in this playlist) with an Add button.
    const addAirbag = await screen.findByRole('button', { name: 'Add Airbag' })
    fireEvent.click(addAirbag)

    // The add is optimistic + reconciled: a tracklist row for Airbag now exists (its remove
    // control is present), proving the relationship add wrote through to the related read.
    await waitFor(() => {
      expect(screen.getByLabelText('Remove Airbag')).toBeInTheDocument()
    })

    // The added row carries a pivot position (appended -> position 3 in this 2-track playlist).
    const airbagRow = screen.getByLabelText('Move Airbag up').closest('.track-row')
    expect(within(airbagRow as HTMLElement).getByText('3')).toBeInTheDocument()
  })

  it("shows an add as a skeleton row while it is pending, then as the server's row once it settles", async () => {
    renderAt('/playlists/00000000-0000-4000-8000-000000000002')
    expect(await screen.findByLabelText('Remove Everything in Its Right Place')).toBeInTheDocument()

    // The picker's Airbag is a narrow catalogue row the playlist's tracks view can't render, so
    // the draft defers it: no row yet, but the playlist reports it as pending.
    fireEvent.click(await screen.findByRole('button', { name: 'Add Airbag' }))
    const skeleton = await screen.findByLabelText('Adding a track')
    expect(skeleton).toHaveClass('track-row--skeleton')
    expect(screen.queryByLabelText('Remove Airbag')).not.toBeInTheDocument()

    // Once the write settles (and its refetch lands) the server's row replaces the skeleton, with
    // its position and no pending marker anywhere.
    const remove = await screen.findByLabelText('Remove Airbag')
    await waitFor(() => {
      expect(screen.queryByLabelText('Adding a track')).not.toBeInTheDocument()
    })
    const row = remove.closest('.track-row') as HTMLElement
    expect(within(row).getByText('3')).toBeInTheDocument()
    expect(document.querySelector('[data-optimistic]')).toBeNull()
    expect(mockStore?.orderedEdges('00000000-0000-4000-8000-000000000002')).toHaveLength(3)
  })

  it('marks a rename and a removal pending, then rolls the removal back when the server refuses', async () => {
    renderAt('/playlists/00000000-0000-4000-8000-000000000002')
    const name = await screen.findByRole('heading', { name: 'Focus Beats', level: 1 })
    expect(await screen.findByLabelText('Remove Everything in Its Right Place')).toBeInTheDocument()

    // The rename shows its title at once, marked pending until the write settles.
    fireEvent.click(name)
    const input = screen.getByLabelText('Rename playlist')
    fireEvent.change(input, { target: { value: 'Deep Focus' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const renamed = await screen.findByRole('heading', { name: 'Deep Focus', level: 1 })
    expect(renamed).toHaveAttribute('data-optimistic', 'pending')
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Deep Focus', level: 1 })).not.toHaveAttribute(
        'data-optimistic',
      )
    })
    expect(mockStore?.playlist('00000000-0000-4000-8000-000000000002')?.title).toBe('Deep Focus')

    // A removal the server refuses: the row leaves at once, then the rollback restores it and the
    // error is shown. Nothing stays marked pending.
    mockStore?.failNextWrite(403, 'This playlist is read-only.')
    fireEvent.click(screen.getByLabelText('Remove Everything in Its Right Place'))
    await waitFor(() => {
      expect(
        screen.queryByLabelText('Remove Everything in Its Right Place'),
      ).not.toBeInTheDocument()
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('This playlist is read-only.')
    expect(await screen.findByLabelText('Remove Everything in Its Right Place')).toBeInTheDocument()
    await waitFor(() => {
      expect(document.querySelector('[data-optimistic]')).toBeNull()
    })
    expect(mockStore?.orderedEdges('00000000-0000-4000-8000-000000000002')).toHaveLength(2)
  })

  it('puts a created playlist at the top of the newest-first list at once, then under its real id', async () => {
    renderAt('/playlists')
    expect(await screen.findByText('Late Night')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('New playlist name'), { target: { value: 'Brand New' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create playlist' }))

    // The new card is first, pending and not yet a link (it only has a temporary id).
    const pending = (await screen.findByText('Brand New')).closest('.card') as HTMLElement
    expect(pending).toHaveAttribute('data-optimistic', 'pending')
    expect(pending.tagName).toBe('DIV')
    expect(document.querySelector('.grid .card')).toBe(pending)

    // After the settle it is the server's playlist, still first, linking to its real id.
    await waitFor(() => {
      const card = screen.getByText('Brand New').closest('.card') as HTMLElement
      expect(card).not.toHaveAttribute('data-optimistic')
      expect(card.tagName).toBe('A')
    })
    const created = mockStore?.playlists().find((p) => p.title === 'Brand New')
    expect(screen.getByText('Brand New').closest('a')).toHaveAttribute(
      'href',
      `/playlists/${created?.id}`,
    )
    expect(document.querySelector('.grid .card')).toBe(
      screen.getByText('Brand New').closest('.card'),
    )
  })

  it('shows a create it cannot complete as a skeleton card in place, then as the server’s row', async () => {
    // The playlists page beside a create of its own that gives no `complete`: the page's list keeps
    // that create as a pending entry, which the page merges in with withPending.
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <QuickCreate title="Sketch" />
          <PlaylistsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('Late Night')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Quick create' }))

    // A skeleton card at the top, showing what was typed; no member row for it yet.
    const skeleton = await screen.findByLabelText('Creating Sketch')
    expect(skeleton).toHaveClass('card--skeleton')
    expect(document.querySelector('.grid .card')).toBe(skeleton)
    expect(document.querySelector('[data-optimistic]')).toBeNull()

    // Once the write settles and the list refetches, the server's row replaces it.
    await waitFor(() => {
      expect(screen.queryByLabelText('Creating Sketch')).not.toBeInTheDocument()
    })
    const created = mockStore?.playlists().find((p) => p.title === 'Sketch')
    expect(screen.getByText('Sketch').closest('a')).toHaveAttribute(
      'href',
      `/playlists/${created?.id}`,
    )
    expect(document.querySelector('.grid .card')).toBe(screen.getByText('Sketch').closest('.card'))
  })

  it('shows the caller from the /me singleton and renames them with the id it read', async () => {
    renderAt('/account')

    // The sidebar and the account page both read the singleton, with no id in the path.
    expect(await screen.findByText('Ada · ada@example.com')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Account' })).toHaveTextContent('Ada')
    })

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Ada Lovelace' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    // The mock answers 409 unless the PATCH body carries the account's id, so the new name
    // reaching the store proves the id rode the body.
    expect(await screen.findByText('Ada Lovelace · ada@example.com')).toBeInTheDocument()
    expect(mockStore?.account().displayName).toBe('Ada Lovelace')
    // The sidebar's own read, with its own fieldset, re-renders from the write-through patch the
    // update's response makes, with no refetch.
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Account' })).toHaveTextContent('Ada Lovelace')
    })
  })

  it('lists liked tracks by the polymorphic relation, dated ones unless asked for both', async () => {
    renderAt('/liked')

    // WhereMorph keeps the favorites of tracks, leaving the liked album out. WhereSet's default
    // keeps only dated favorites, so the undated Idioteque is left out.
    expect(await screen.findByText('Paranoid Android')).toBeInTheDocument()
    expect(screen.getByText('Teardrop')).toBeInTheDocument()
    expect(screen.queryByText('Idioteque')).not.toBeInTheDocument()
    expect(screen.queryByText('OK Computer')).not.toBeInTheDocument()

    // Sending both booleans asks for every favorite of a track.
    fireEvent.click(screen.getByLabelText('Include undated likes'))
    expect(await screen.findByText('Idioteque')).toBeInTheDocument()
    expect(screen.getByText('Undated')).toBeInTheDocument()
  })
})
