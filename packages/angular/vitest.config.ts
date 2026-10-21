import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Angular's TestBed needs a DOM and the JIT compiler (see vitest.setup.ts), so this package runs
// as its own project. The client resolves to source, as in the root config, so no build is needed.
export default defineConfig({
  resolve: {
    alias: {
      '@haddowg/json-api-client': fileURLToPath(new URL('../client/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'angular',
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
  },
})
