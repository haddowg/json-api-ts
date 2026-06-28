import type { ApiDescriptor } from './descriptor'
import type { JsonApiTransport } from './transport'

/**
 * The `fetch` headers init type. `@types/node` declares the global `RequestInit` (used
 * by the transport) but not `HeadersInit`; we derive it from `RequestInit.headers` to
 * stay dep-free and consistent with the rest of the runtime's web-globals usage.
 */
export type HeadersInit = NonNullable<RequestInit['headers']>

/**
 * Options for {@link createClient}. The fluent read/write surface (Phase 2+) is built
 * on top of this seam; for now `createClient` only binds the descriptor and options.
 */
export interface ClientOptions {
  /** Base URL the generated path templates are resolved against. */
  baseUrl: string
  /** Transport seam; defaults to the `fetch` adapter when omitted. */
  transport?: JsonApiTransport
  /** Per-request header provider (e.g. bearer auth); may be async. */
  headers?: () => HeadersInit | Promise<HeadersInit>
}

/**
 * The seam the generated file binds to. The fluent, descriptor-driven surface lands in
 * Phase 2 — this only captures the descriptor + options so the generated code has a
 * stable entry point to call.
 */
export function createClient<D extends ApiDescriptor>(
  descriptor: D,
  options: ClientOptions,
): { descriptor: D; options: ClientOptions } {
  return { descriptor, options }
}
