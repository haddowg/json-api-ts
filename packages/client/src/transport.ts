/**
 * A request body that is not text: the binary, multipart and URL-encoded payloads a custom action
 * can take.
 */
export type TransportRawBody =
  | Blob
  | ArrayBuffer
  | Uint8Array<ArrayBuffer>
  | FormData
  | URLSearchParams

/** A single outbound request, already serialised. */
export interface TransportRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  /**
   * A body that is not text, sent instead of {@link body}. Only a custom action with a binary,
   * multipart or URL-encoded request media type sets it, and a custom transport must send it as
   * is for those actions to work.
   */
  rawBody?: TransportRawBody
  /**
   * Read a successful response as binary into {@link TransportResponse.binary}. Absent means text,
   * which is every JSON:API response. Only a custom action answering with a binary media type
   * sets it; an error response is still read as text so the client can parse its JSON:API errors.
   */
  responseType?: 'blob' | 'arraybuffer'
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
  /** The response body as text; empty when it was read into {@link binary} instead. */
  body: string
  /** The body of a successful response to a request that set `responseType`. */
  binary?: Blob | ArrayBuffer
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
  if (req.rawBody !== undefined) {
    init.body = req.rawBody
  } else if (req.body !== undefined) {
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

  if (req.responseType !== undefined && res.ok) {
    const binary = req.responseType === 'blob' ? await res.blob() : await res.arrayBuffer()
    return { status: res.status, headers, body: '', binary }
  }
  return { status: res.status, headers, body: await res.text() }
}
