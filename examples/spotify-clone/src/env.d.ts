/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** When set, the app uses the real fetch transport against this JSON:API server. */
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
