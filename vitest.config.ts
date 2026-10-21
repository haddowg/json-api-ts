import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Resolve workspace packages to their source during tests so the suite is
// self-contained and does not depend on a prior `pnpm build` (CI runs test
// before build). This also lets a dynamically-imported generated *.gen.ts
// resolve its bare `@haddowg/json-api-client` import without dist, and the
// cross-package worked example (packages/example) import the client's `/ajv`
// sub-path export and the query bindings from source. More-specific keys
// (the sub-path) come first so they win over the bare package alias.
const alias = {
  '@haddowg/json-api-client/ajv': fileURLToPath(
    new URL('./packages/client/src/ajv.ts', import.meta.url),
  ),
  '@haddowg/json-api-client': fileURLToPath(
    new URL('./packages/client/src/index.ts', import.meta.url),
  ),
  '@haddowg/json-api-query': fileURLToPath(
    new URL('./packages/query/src/index.ts', import.meta.url),
  ),
}

export default defineConfig({
  resolve: { alias },
  test: {
    coverage: {
      include: ['packages/*/src/**'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
    // Three projects under one run: the library/packages suite (node), the Angular bindings
    // (jsdom + TestBed), and the example app's render smoke (jsdom). The Angular package and the
    // example carry their own configs, so they are referenced by path; the packages project
    // inlines its node config here.
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'packages',
          include: ['packages/*/src/**/*.test.ts'],
          exclude: ['packages/angular/**', '**/node_modules/**'],
          environment: 'node',
        },
      },
      './packages/angular/vitest.config.ts',
      './examples/spotify-clone/vite.config.ts',
    ],
  },
})
