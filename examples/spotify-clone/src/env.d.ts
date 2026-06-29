/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * When set, the app uses the real fetch transport. Set to `/api` to go through the Vite
   * dev-proxy to the live bundle server (same-origin, no CORS); an absolute URL hits it directly
   * (needs CORS on the server).
   */
  readonly VITE_API_URL?: string
  /** Live mode only: a Bearer token (the example's token IS the user id, e.g. `ada@example.com`). */
  readonly VITE_API_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
