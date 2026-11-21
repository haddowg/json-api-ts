import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The app's render smoke runs under jsdom with Angular's TestBed, as packages/angular does. The
// workspace packages resolve to their source, so no build is needed (CI runs test before build).
// More-specific keys come first so the `/query` entry wins over the bare package alias. Every
// import of `@tanstack/angular-query` resolves to the one copy the workspace installs, so the app
// and the bindings share one `@tanstack/query-core`.
const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@haddowg/json-api-angular/query': source('../../packages/angular/src/query/index.ts'),
      '@haddowg/json-api-angular': source('../../packages/angular/src/index.ts'),
      '@haddowg/json-api-client': source('../../packages/client/src/index.ts'),
      '@haddowg/json-api-query': source('../../packages/query/src/index.ts'),
    },
  },
  test: {
    name: 'angular-catalog',
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.spec.ts'],
  },
})
