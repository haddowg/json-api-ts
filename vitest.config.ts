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
    // Two projects under one run: the library/packages suite (node), and the example app's
    // render smoke (jsdom). The example carries its own vite.config.ts (jsdom + plugin-react
    // + setup), so it is referenced by path; the packages project inlines its node config here.
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'packages',
          include: ['packages/*/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      './examples/spotify-clone/vite.config.ts',
    ],
  },
})
