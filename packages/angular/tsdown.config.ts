import { defineConfig } from 'tsdown'

// The root and its subpaths. The root and `./query` share the DI tokens and `Register`, which land
// in a shared chunk, so the subpath injects the very client the root provides. The root imports
// no subpath, TanStack or `@angular/forms`.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'query/index': 'src/query/index.ts',
    'forms/index': 'src/forms/index.ts',
    'forms/signals/index': 'src/forms/signals/index.ts',
  },
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
