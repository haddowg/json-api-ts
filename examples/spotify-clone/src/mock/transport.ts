/**
 * The mock transport: a {@link JsonApiTransport} backed by a single {@link MockStore}. Each call
 * is run through the focused {@link handle} handler, with a tiny artificial latency so loading
 * states are visible in the UI. A fresh store is created per transport so a test gets isolation.
 */
import type { JsonApiTransport } from '@haddowg/json-api-client'
import { handle } from './handler'
import { MockStore } from './store'

export interface MockTransport {
  transport: JsonApiTransport
  store: MockStore
}

export function createMockTransport(options: { latencyMs?: number } = {}): MockTransport {
  const store = new MockStore()
  const latency = options.latencyMs ?? 0
  const transport: JsonApiTransport = async (req) => {
    if (latency > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, latency)
      })
    }
    return handle(store, req)
  }
  return { transport, store }
}
