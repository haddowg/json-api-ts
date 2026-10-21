import { Component, inject } from '@angular/core'
import { AlbumList } from './album-list'
import { RequestTracker } from './request-tracker'

@Component({
  selector: 'app-root',
  imports: [AlbumList],
  template: `
    <header>
      <h1>Music catalogue</h1>
      <p class="muted">
        Requests through the interceptor: {{ tracker.sent() }} sent, {{ tracker.inFlight() }} in
        flight, {{ tracker.cancelled() }} cancelled
      </p>
    </header>
    <main>
      <app-album-list />
    </main>
  `,
})
export class App {
  protected readonly tracker = inject(RequestTracker)
}
