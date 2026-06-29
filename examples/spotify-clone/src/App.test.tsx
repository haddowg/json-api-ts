import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { mockStore, queryClient } from './api/client'
import { App } from './App'

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
})
