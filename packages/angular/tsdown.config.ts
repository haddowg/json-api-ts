import { defineConfig } from 'tsdown'

// Two entries: the root and the `./query` subpath. They share the DI tokens and `Register`, which
// land in a shared chunk, so the subpath injects the very client the root provides. The root
// imports neither the subpath nor TanStack.
export default defineConfig({
  entry: { index: 'src/index.ts', 'query/index': 'src/query/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  external: [
    /^@angular\//,
    /^rxjs/,
    /^@tanstack\//,
    '@haddowg/json-api-client',
    '@haddowg/json-api-query',
  ],
})
