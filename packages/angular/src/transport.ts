import { HttpErrorResponse, type HttpClient, type HttpHeaders } from '@angular/common/http'
import type { JsonApiTransport, TransportResponse } from '@haddowg/json-api-client'

/**
 * A transport that sends every request through Angular's `HttpClient`, so the app's interceptors
 * run. The body comes back as text for the client to parse, exactly as with `fetchTransport`.
 *
 * A non-2xx response resolves with its status, headers and body, because the client maps those to
 * a `JsonApiError` itself. Only a request that never got a response (status 0: network failure,
 * CORS, a blocked request) rejects, with the `HttpErrorResponse`. Aborting `req.signal`
 * unsubscribes, which cancels the HTTP request, and rejects with the signal's reason.
 */
export function httpClientTransport(http: HttpClient): JsonApiTransport {
  return (req) =>
    new Promise<TransportResponse>((resolve, reject) => {
      const signal = req.signal
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }

      let unsubscribe: (() => void) | undefined
      const onAbort = (): void => {
        unsubscribe?.()
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const settle = (): void => signal?.removeEventListener('abort', onAbort)

      const subscription = http
        .request(req.method, req.url, {
          body: req.body ?? null,
          headers: req.headers,
          observe: 'response',
          responseType: 'text',
        })
        .subscribe({
          next: (res) => {
            settle()
            resolve({ status: res.status, headers: toRecord(res.headers), body: res.body ?? '' })
          },
          error: (error: unknown) => {
            settle()
            if (error instanceof HttpErrorResponse && error.status !== 0) {
              resolve({
                status: error.status,
                headers: toRecord(error.headers),
                body: errorBody(error.error),
              })
              return
            }
            reject(error)
          },
        })
      unsubscribe = () => subscription.unsubscribe()
    })
}

function toRecord(headers: HttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of headers.keys()) {
    const values = headers.getAll(name)
    if (values !== null) {
      out[name.toLowerCase()] = values.join(', ')
    }
  }
  return out
}

// With responseType 'text' the error body is already a string. Anything else (an interceptor that
// replaced it) is serialised so the client can still try to parse a JSON:API error document.
function errorBody(body: unknown): string {
  if (typeof body === 'string') {
    return body
  }
  if (body === null || body === undefined) {
    return ''
  }
  return JSON.stringify(body)
}
