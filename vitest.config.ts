import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Resolve workspace packages to their source during tests so the suite is
  // self-contained and does not depend on a prior `pnpm build` (CI runs test
  // before build). This also lets a dynamically-imported generated *.gen.ts
  // resolve its bare `@haddowg/json-api-client` import without dist.
  resolve: {
    alias: {
      '@haddowg/json-api-client': fileURLToPath(
        new URL('./packages/client/src/index.ts', import.meta.url),
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
