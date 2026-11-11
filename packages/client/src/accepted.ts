import {
  type Document,
  executeResponse,
  type ExecutedResponse,
  type JsonApiContext,
} from './request'

/** Options for waiting on an accepted write: `wait` on the call, or {@link Accepted.$poll}. */
export interface PollOptions {
  /**
   * How long to keep polling, in milliseconds, before rejecting with a {@link PollTimeoutError}.
   * Defaults to five minutes.
   */
  timeout?: number
  /** Stops polling when signalled. The call rejects with the signal's reason, as a request does. */
  signal?: AbortSignal
}

/**
 * A write the server accepted for later (`202 Accepted`). `Job` is the job it answered with and
 * `Result` what the write resolves to once the job is done.
 */
export interface Accepted<Job, Result = unknown> {
  /**
   * The job, materialised as its type's resource, or the document's top-level `meta` when the
   * server answered with a meta-only document.
   */
  readonly job: Job
  /** The job URL, from `Content-Location`, which {@link $poll} reads until the job is done. */
  readonly contentLocation: string
  /**
   * How long the server asks the client to wait before polling, in seconds, from `Retry-After`. An
   * HTTP date is counted from when the response arrived. Absent when the server sent none.
   */
  readonly retryAfter: number | undefined
  /** Poll the job URL until the job is done, and resolve to what the write returns. */
  $poll(options?: PollOptions): Promise<Result>
}

/** Thrown when a job is still pending when the poll's timeout runs out. */
export class PollTimeoutError extends Error {
  readonly contentLocation: string
  readonly timeout: number

  constructor(contentLocation: string, timeout: number) {
    super(`The job at ${contentLocation} was still pending after ${timeout}ms`)
    this.name = 'PollTimeoutError'
    this.contentLocation = contentLocation
    this.timeout = timeout
  }
}

const ACCEPTED = Symbol.for('@haddowg/json-api-client/accepted')

/** Whether a write's result is an {@link Accepted} job rather than its normal result. */
export function isAccepted(value: unknown): value is Accepted<unknown, unknown> {
  return typeof value === 'object' && value !== null && ACCEPTED in value
}

const DEFAULT_TIMEOUT = 5 * 60 * 1000
const DEFAULT_INTERVAL = 1000

/** How the client reads and finishes one accepted write. */
export interface AcceptedTarget {
  readonly request: JsonApiContext
  readonly jobType: string
  /** Shape the job's materialised document (or `meta`) for {@link Accepted.job}. */
  readonly job: (doc: Document | undefined) => unknown
  /** Shape the finished response into what the write returns. */
  readonly complete: (doc: Document | undefined) => unknown
}

/** A response header by name, whatever case the transport wrote it in. */
function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value
    }
  }
  return undefined
}

/**
 * A `Retry-After` value in seconds: delta-seconds as sent, an HTTP date as the seconds left until
 * it, rounded up and never negative. `undefined` when absent or unreadable.
 */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === '') {
    return undefined
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed)
  }
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000))
}

/** Whether a document is a meta-only one: no primary `data` member. */
const isMetaOnly = (doc: Document | undefined): boolean => doc === undefined || !('data' in doc)

/** The `type` of a document's single primary resource, if it has one. */
function primaryType(doc: Document | undefined): unknown {
  const data = doc?.data
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)['type']
    : undefined
}

/** Build the {@link Accepted} for a `202` response. */
export function toAccepted(target: AcceptedTarget, res: ExecutedResponse): Accepted<unknown> {
  const contentLocation = header(res.headers, 'Content-Location')
  if (contentLocation === undefined) {
    throw new Error('The server answered 202 Accepted without a Content-Location to poll.')
  }
  const metaJob = isMetaOnly(res.document)
  const retryAfter = parseRetryAfter(header(res.headers, 'Retry-After'))
  const value = {
    job: target.job(res.document),
    contentLocation,
    retryAfter,
  }
  Object.defineProperty(value, ACCEPTED, { value: true, enumerable: false })
  Object.defineProperty(value, '$poll', {
    value: (options?: PollOptions) => poll(target, contentLocation, metaJob, retryAfter, options),
    enumerable: false,
  })
  return value as Accepted<unknown>
}

/**
 * Poll the job URL. A `2xx` still holding the job (its type, or a meta-only document for a
 * meta-only job) is pending: wait for its `Retry-After`, else the `202`'s, else a second. A `303`
 * the transport didn't follow is done, and its `Location` is fetched; any other `2xx` is the
 * redirect already followed. A non-2xx throws the usual {@link JsonApiError}.
 */
async function poll(
  target: AcceptedTarget,
  contentLocation: string,
  metaJob: boolean,
  acceptedRetryAfter: number | undefined,
  options: PollOptions = {},
): Promise<unknown> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT
  const signal = options.signal
  const deadline = Date.now() + timeout
  const get = (path: string, seeOther: boolean) =>
    executeResponse(
      target.request,
      { method: 'GET', path, link: true, ...(signal !== undefined ? { signal } : {}) },
      seeOther,
    )
  const holdsJob = (doc: Document | undefined): boolean =>
    doc !== undefined && (primaryType(doc) === target.jobType || (metaJob && isMetaOnly(doc)))

  let delay = (acceptedRetryAfter ?? DEFAULT_INTERVAL / 1000) * 1000
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new PollTimeoutError(contentLocation, timeout)
    }
    // A Retry-After past the deadline still gets one last poll at the deadline.
    await sleep(Math.min(delay, remaining), signal)
    const res = await get(contentLocation, true)
    if (res.status === 303) {
      const location = header(res.headers, 'Location')
      if (location === undefined) {
        throw new Error(`The job at ${contentLocation} answered 303 without a Location.`)
      }
      return target.complete((await get(location, false)).document)
    }
    if (!holdsJob(res.document)) {
      return target.complete(res.document)
    }
    const retryAfter = parseRetryAfter(header(res.headers, 'Retry-After')) ?? acceptedRetryAfter
    delay = (retryAfter ?? DEFAULT_INTERVAL / 1000) * 1000
  }
}

/** Resolve after `ms`, or reject with the signal's reason when it aborts first. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
