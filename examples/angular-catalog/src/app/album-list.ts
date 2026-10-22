import { DatePipe } from '@angular/common'
import { Component, signal } from '@angular/core'
import { jsonApiMutation, jsonApiResource, nextPage, prevPage } from '@haddowg/json-api-angular'
import type { ListPageParams } from '@haddowg/json-api-client'
import type { resourceMap } from '../generated/music-catalog.gen'

type AlbumsPage = ListPageParams<typeof resourceMap, 'albums'>

const FIRST_PAGE: AlbumsPage = { size: 5 }

@Component({
  selector: 'app-album-list',
  imports: [DatePipe],
  template: `
    <input
      type="search"
      placeholder="Filter by title"
      [value]="search()"
      (input)="onSearch($any($event.target).value)"
    />

    @if (albums.jsonApiError(); as error) {
      <p class="error">Could not load albums ({{ error.status }})</p>
    } @else if (albums.hasValue()) {
      <ul>
        @for (album of albums.value(); track album.id) {
          <li>
            <button type="button" (click)="selectedId.set(album.id)">{{ album.title }}</button>
            <span>{{ album.artist?.name }}, {{ album.releasedAt | date: 'yyyy' }}</span>
          </li>
        } @empty {
          <li>No albums match.</li>
        }
      </ul>
      <nav>
        <button type="button" [disabled]="!previous()" (click)="goTo(previous())">Previous</button>
        <span>Page {{ albums.value().$page.meta?.currentPage }}</span>
        <button type="button" [disabled]="!next()" (click)="goTo(next())">Next</button>
      </nav>
    }
    @if (albums.isLoading()) {
      <p class="muted">Loading…</p>
    }

    @if (selected.hasValue()) {
      <section>
        <h2>{{ selected.value().title }}</h2>
        <p>by {{ selected.value().artist?.name }}</p>
        <form (submit)="$event.preventDefault(); rename(title.value)">
          <input #title [value]="selected.value().title" aria-label="Title" />
          <button type="submit" [disabled]="renaming.isPending()">Rename</button>
        </form>
        @if (renaming.jsonApiError(); as error) {
          <p class="error">{{ error.byPath()['title']?.[0]?.detail }}</p>
        }
      </section>
    }
  `,
})
export class AlbumList {
  readonly search = signal('')
  readonly page = signal<AlbumsPage>(FIRST_PAGE)
  readonly selectedId = signal<string | undefined>(undefined)

  // Typing in the box changes the params, which cancels the request still in flight.
  readonly albums = jsonApiResource({
    params: () => ({ filter: { title: this.search() }, page: this.page() }),
    loader: ({ client, params, abortSignal }) =>
      client.albums.list({
        ...params,
        sort: 'title',
        include: ['artist'],
        fields: { albums: ['title', 'releasedAt', 'artist'], artists: ['name'] },
        signal: abortSignal,
      }),
  })

  // Idle until an album is picked: params return undefined until then.
  readonly selected = jsonApiResource({
    params: () => {
      const id = this.selectedId()
      return id === undefined ? undefined : { id }
    },
    loader: ({ client, params, abortSignal }) =>
      client.albums.get(params.id, { include: ['artist'], signal: abortSignal }),
  })

  readonly renaming = jsonApiMutation((client, input: { id: string; title: string }) =>
    client.albums.id(input.id).update({ title: input.title }),
  )

  next(): AlbumsPage | undefined {
    return this.albums.hasValue() ? nextPage(this.albums.value()) : undefined
  }

  previous(): AlbumsPage | undefined {
    return this.albums.hasValue() ? prevPage(this.albums.value()) : undefined
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

  rename(title: string): void {
    const id = this.selectedId()
    if (id === undefined) {
      return
    }
    this.renaming.mutate({ id, title }).then(
      () => {
        this.albums.reload()
        this.selected.reload()
      },
      () => {
        // The error is on renaming.jsonApiError(); the template shows it.
      },
    )
  }
}
