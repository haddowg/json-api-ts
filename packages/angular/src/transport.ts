import { HttpErrorResponse, type HttpClient, type HttpHeaders } from '@angular/common/http'
import type { JsonApiTransport, TransportResponse } from '@haddowg/json-api-client'

/**
 * A transport that sends every request through Angular's `HttpClient`, so the app's interceptors
 * run. The body comes back as text for the client to parse, exactly as with `fetchTransport`, or
 * as binary when the request sets `responseType` for a custom action's binary response.
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

      const body = req.rawBody ?? req.body ?? null
      const error = (failure: unknown): void => {
        settle()
        if (failure instanceof HttpErrorResponse && failure.status !== 0) {
          errorBody(failure.error).then(
            (text) =>
              resolve({ status: failure.status, headers: toRecord(failure.headers), body: text }),
            reject,
          )
          return
        }
        reject(failure)
      }
      const subscription =
        req.responseType === undefined
          ? http
              .request(req.method, req.url, {
                body,
                headers: req.headers,
                observe: 'response',
                responseType: 'text',
              })
              .subscribe({
                next: (res) => {
                  settle()
                  resolve({
                    status: res.status,
                    headers: toRecord(res.headers),
                    body: res.body ?? '',
                  })
                },
                error,
              })
          : http
              .request(req.method, req.url, {
                body,
                headers: req.headers,
                observe: 'response',
                // HttpClient's overloads need the literal, so pick the call per response type.
                responseType: req.responseType as 'blob',
              })
              .subscribe({
                next: (res) => {
                  settle()
                  const out: TransportResponse = {
                    status: res.status,
                    headers: toRecord(res.headers),
                    body: '',
                  }
                  if (res.body !== null) {
                    out.binary = res.body
                  }
                  resolve(out)
                },
                error,
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

// With responseType 'text' the error body is already a string, and a binary request's error body is
// decoded as text. Anything else (an interceptor that replaced it) is serialised so the client can
// still try to parse a JSON:API error document.
async function errorBody(body: unknown): Promise<string> {
  if (typeof body === 'string') {
    return body
  }
  if (body === null || body === undefined) {
    return ''
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return body.text()
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body)
  }
  return JSON.stringify(body)
}
