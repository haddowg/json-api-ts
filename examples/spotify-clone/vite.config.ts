/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Resolve the workspace client/query packages to their SOURCE (not dist) for both `vite build`
// and the vitest run, so the example is self-contained and never needs a prior `pnpm build`
// (CI runs build after test). Mirrors the root vitest alias map — more-specific sub-path keys
// first so they win over the bare package alias.
const alias = {
  '@haddowg/json-api-client/ajv': fileURLToPath(
    new URL('../../packages/client/src/ajv.ts', import.meta.url),
  ),
  '@haddowg/json-api-client': fileURLToPath(
    new URL('../../packages/client/src/index.ts', import.meta.url),
  ),
  '@haddowg/json-api-query': fileURLToPath(
    new URL('../../packages/query/src/index.ts', import.meta.url),
  ),
}

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    name: 'spotify-clone',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
