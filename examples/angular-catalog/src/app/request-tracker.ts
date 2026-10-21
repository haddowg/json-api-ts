import type { HttpInterceptorFn } from '@angular/common/http'
import { HttpEventType } from '@angular/common/http'
import { Injectable, inject, signal } from '@angular/core'
import { finalize, tap } from 'rxjs'

/** Counts requests as the interceptor sees them, for the status bar. */
@Injectable({ providedIn: 'root' })
export class RequestTracker {
  readonly inFlight = signal(0)
  readonly sent = signal(0)
  readonly cancelled = signal(0)
}

/**
 * An ordinary app interceptor: it stamps a header and counts requests. Every request the JSON:API
 * client makes passes through it, because the client sends through HttpClient. A request that
 * finalizes without a response was cancelled, which is what a superseded resource load does.
 */
export const trackRequestsInterceptor: HttpInterceptorFn = (req, next) => {
  const tracker = inject(RequestTracker)
  tracker.sent.update((n) => n + 1)
  tracker.inFlight.update((n) => n + 1)
  let settled = false

  return next(req.clone({ setHeaders: { 'X-Requested-With': 'angular-catalog' } })).pipe(
    tap({
      next: (event) => {
        if (event.type === HttpEventType.Response) {
          settled = true
        }
      },
      error: () => {
        settled = true
      },
    }),
    finalize(() => {
      tracker.inFlight.update((n) => n - 1)
      if (!settled) {
        tracker.cancelled.update((n) => n + 1)
      }
    }),
  )
}
