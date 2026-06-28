import { defineConfig } from 'tsdown'

export default defineConfig({
  // `ajv` is a separate entry so the optional ajv adapter (and its `ajv` peer types) stay out
  // of the main entry's bundle + `.d.ts` — importing `@haddowg/json-api-client` never pulls ajv.
  entry: ['src/index.ts', 'src/ajv.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
})
