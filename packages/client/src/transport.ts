/** A single outbound request, already serialised to strings. */
export interface TransportRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
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
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  })

  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })

  return { status: res.status, headers, body: await res.text() }
}
