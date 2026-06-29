/**
 * The app's data layer bootstrap: builds the descriptor-bound client over either the seeded
 * in-memory mock transport (default — `pnpm dev` runs with no backend) or the real fetch
 * transport when `VITE_API_URL` is set, wires a QueryClient with `type:id` write-through
 * normalization, and exposes the bound TanStack read/write APIs.
 */
import { fetchTransport, type JsonApiTransport } from '@haddowg/json-api-client'
import { createMutationApi, createQueryApi, installNormalization } from '@haddowg/json-api-query'
import { QueryClient } from '@tanstack/react-query'
import { createClient, resourceMap } from '../generated/music-catalog.gen'
import { createMockTransport, type MockTransport } from '../mock/transport'

const apiUrl = import.meta.env.VITE_API_URL
// Live mode only: the example secures playlist writes behind a Bearer firewall where the token IS
// the user identifier — `ada@example.com` owns the seeded "Morning Mix" playlist, so she can edit
// it. Reads are public; without a token, live reads still work but playlist writes return 401.
const apiToken = import.meta.env.VITE_API_TOKEN

/** When `VITE_API_URL` is set we hit a real server; otherwise the seeded in-memory mock. */
function resolveTransport(): {
  baseUrl: string
  transport: JsonApiTransport
  mock?: MockTransport
} {
  if (apiUrl) {
    return { baseUrl: apiUrl.replace(/\/$/, ''), transport: fetchTransport }
  }
  const mock = createMockTransport({ latencyMs: 180 })
  return { baseUrl: 'https://music.example', transport: mock.transport, mock }
}

const resolved = resolveTransport()

/** The live mock store when running off the mock (handy for resets / debugging); else undefined. */
export const mockStore = resolved.mock?.store

export const client = createClient({
  baseUrl: resolved.baseUrl,
  transport: resolved.transport,
  // Send the Bearer token in live mode (mock mode ignores it).
  ...(apiUrl && apiToken ? { headers: () => ({ Authorization: `Bearer ${apiToken}` }) } : {}),
})

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: false } },
})

// `type:id` write-through patching: a change to any resource updates every cached view holding it.
installNormalization(queryClient, resourceMap)

/** Bound read-option factories: `reads.albums.list(query)` -> `{ queryKey, queryFn }`. */
export const reads = createQueryApi(client)

/** Bound mutation-option factories: `writes.playlists.id(id).update()` -> `MutationOptions`. */
export const writes = createMutationApi(queryClient, client, resourceMap)
