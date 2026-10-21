/** A single outbound request, already serialised to strings. */
export interface TransportRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  /**
   * Aborts the request when signalled. Optional: a transport that ignores it still works, the
   * caller just can't cancel an in-flight request through it.
   */
  signal?: AbortSignal
}

/** A single inbound response, body still a string for the runtime to parse. */
export interface TransportResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * The transport seam: a tiny, `fetch`-shaped function (not a class), so any impl
 * (native `fetch`, undici, an axios adapter) drops in. Retries are deliberately out
 * of scope here — the transport (or the TanStack layer) owns them.
 */
export type JsonApiTransport = (req: TransportRequest) => Promise<TransportResponse>

/** The default transport, backed by the global `fetch`. */
export const fetchTransport: JsonApiTransport = async (req) => {
  const init: RequestInit = { method: req.method, headers: req.headers }
  if (req.body !== undefined) {
    init.body = req.body
  }
  if (req.signal !== undefined) {
    init.signal = req.signal
  }

  const res = await fetch(req.url, init)

  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })

  return { status: res.status, headers, body: await res.text() }
}
