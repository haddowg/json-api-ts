import { DatePipe } from '@angular/common'
import { Component, signal } from '@angular/core'
import { nextPage, prevPage } from '@haddowg/json-api-angular'
import {
  injectJsonApiReads,
  injectJsonApiWrites,
  JsonApiErrorPipe,
} from '@haddowg/json-api-angular/query'
import type { ListPageParams } from '@haddowg/json-api-client'
import { injectMutation, injectQuery, keepPreviousData, skipToken } from '@tanstack/angular-query'
import type { resourceMap } from '../generated/music-catalog.gen'

type AlbumsPage = ListPageParams<typeof resourceMap, 'albums'>

const FIRST_PAGE: AlbumsPage = { size: 5 }

@Component({
  selector: 'app-album-list',
  imports: [DatePipe, JsonApiErrorPipe],
  template: `
    <input
      type="search"
      placeholder="Filter by title"
      [value]="search()"
      (input)="onSearch($any($event.target).value)"
    />

    @if (albums.error() | jsonApiError; as error) {
      <p class="error">Could not load albums ({{ error.status }})</p>
    } @else if (albums.data(); as list) {
      <ul [attr.aria-busy]="albums.isPlaceholderData()">
        @for (album of list; track album.id) {
          <li [class.pending]="album.$optimistic">
            <button type="button" (click)="selectedId.set(album.id)">{{ album.title }}</button>
            <span>{{ album.artist?.name }}, {{ album.releasedAt | date: 'yyyy' }}</span>
          </li>
        } @empty {
          <li>No albums match.</li>
        }
      </ul>
      <nav>
        <button type="button" [disabled]="!previous()" (click)="goTo(previous())">Previous</button>
        <span>Page {{ list.$page.meta?.currentPage }}</span>
        <span>{{ list.$meta.explicitCount }} explicit on this page</span>
        <button type="button" [disabled]="!next()" (click)="goTo(next())">Next</button>
      </nav>
    }
    @if (albums.isFetching()) {
      <p class="muted">Loading…</p>
    }

    @if (selected.data(); as album) {
      <section>
        <h2>{{ album.title }}</h2>
        <p>by {{ album.artist?.name }}</p>
        <form
          (submit)="$event.preventDefault(); rename.mutate({ id: album.id, title: title.value })"
        >
          <input #title [value]="album.title" aria-label="Title" />
          <button type="submit" [disabled]="rename.isPending()">Rename</button>
        </form>
        @if (rename.error() | jsonApiError; as error) {
          <p class="error">{{ error.byPath()['title']?.[0]?.detail }}</p>
        }
        @if (saved(); as message) {
          <p class="muted">{{ message }}</p>
        }
      </section>
    }
  `,
})
export class AlbumList {
  private readonly reads = injectJsonApiReads()
  private readonly writes = injectJsonApiWrites()

  readonly search = signal('')
  readonly page = signal<AlbumsPage>(FIRST_PAGE)
  readonly selectedId = signal<string | undefined>(undefined)
  readonly saved = signal<string | undefined>(undefined)

  // Typing in the box changes the key, which cancels the request still in flight. The previous
  // page stays on screen until the new one arrives.
  readonly albums = injectQuery(() => ({
    ...this.reads.albums.list({
      filter: { title: this.search() },
      page: this.page(),
      sort: 'title',
      include: ['artist'],
      fields: { albums: ['title', 'releasedAt', 'artist'], artists: ['name'] },
    }),
    placeholderData: keepPreviousData,
  }))

  // Idle until an album is picked: skipToken stands where the id would go.
  readonly selected = injectQuery(() =>
    this.reads.albums.get(this.selectedId() ?? skipToken, { include: ['artist'] }),
  )

  // The new title shows at once, in the list and the detail alike, and is rolled back if the
  // server refuses it. On success the server's version patches both in place: no refetch. The
  // album's id travels in the variables, so one mutation renames whichever album is picked.
  readonly rename = injectMutation(() => ({
    ...this.writes.albums.update({ optimistic: true }),
    onMutate: () => this.saved.set(undefined),
    onSuccess: (album: { title: string }) => this.saved.set(`Saved as "${album.title}"`),
  }))

  next(): AlbumsPage | undefined {
    return nextPage(this.albums.data())
  }

  previous(): AlbumsPage | undefined {
    return prevPage(this.albums.data())
  }

  onSearch(value: string): void {
    this.search.set(value)
    this.page.set(FIRST_PAGE)
  }

  goTo(page: AlbumsPage | undefined): void {
    if (page !== undefined) {
      this.page.set(page)
    }
  }
}
