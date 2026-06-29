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

// Live mode (`VITE_API_URL=/api`): proxy `/api/*` to the running bundle server so the browser
// stays same-origin — no CORS needed, and the stripped path hits the bundle's real routes. The
// target defaults to the local FrankenPHP example; override with VITE_API_PROXY_TARGET.
const proxyTarget = process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:8080'

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  server: {
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    name: 'spotify-clone',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
