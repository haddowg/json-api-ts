import { defineConfig } from 'tsdown'

export default defineConfig([
  // The runtime: dual ESM and CommonJS, so a CommonJS host can require it. Loads only the client.
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    external: ['@haddowg/json-api-client'],
  },
  // The build-time generator and its CLI: ESM only, like the codegen it loads.
  {
    entry: ['src/generate.ts', 'src/cli.ts'],
    format: ['esm'],
    dts: true,
    clean: false,
    external: ['@haddowg/json-api-client', '@haddowg/json-api-codegen'],
  },
])
