import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Angular's TestBed needs a DOM and the JIT compiler (see vitest.setup.ts), so this package runs
// as its own project. The client and the query bindings resolve to source, as in the root config,
// so no build is needed. `@tanstack/angular-query` pins one `@tanstack/query-core`, which the query
// bindings must share (a second copy breaks identity checks such as `skipToken`). The workspace
// installs that one version only, and Vite resolves each symlink to its real path, so both import
// the same module; `src/query/provide.test.ts` asserts it.
export default defineConfig({
  resolve: {
    alias: {
      '@haddowg/json-api-client': fileURLToPath(new URL('../client/src/index.ts', import.meta.url)),
      '@haddowg/json-api-query': fileURLToPath(new URL('../query/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'angular',
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
  },
})
