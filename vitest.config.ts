import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    coverage: {
      include: ['packages/*/src/**'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
})
