import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Resolve workspace packages to their source during tests so the suite is
  // self-contained and does not depend on a prior `pnpm build` (CI runs test
  // before build). This also lets a dynamically-imported generated *.gen.ts
  // resolve its bare `@haddowg/json-api-client` import without dist, and the
  // cross-package worked example (packages/example) import the client's `/ajv`
  // sub-path export and the query bindings from source. More-specific keys
  // (the sub-path) come first so they win over the bare package alias.
  resolve: {
    alias: {
      '@haddowg/json-api-client/ajv': fileURLToPath(
        new URL('./packages/client/src/ajv.ts', import.meta.url),
      ),
      '@haddowg/json-api-client': fileURLToPath(
        new URL('./packages/client/src/index.ts', import.meta.url),
      ),
      '@haddowg/json-api-query': fileURLToPath(
        new URL('./packages/query/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    coverage: {
      include: ['packages/*/src/**'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
})
